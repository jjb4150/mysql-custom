import * as path from "path";
import * as vscode from "vscode";
import { Global } from "../common/global";
import { Node } from "../model/interface/node";
import { QueryUnit } from "./queryUnit";
import { SSHConfig } from "../model/interface/sshConfig";
import { DatabaseCache } from "./common/databaseCache";
import { NodeUtil } from "../model/nodeUtil";
import { SSHTunnelService } from "./tunnel/sshTunnelService";
import { DbTreeDataProvider } from "../provider/treeDataProvider";
import { IConnection } from "./connect/connection";
import { DatabaseType } from "@/common/constants";
import { MSSqlConnnection } from "./connect/mssqlConnection";
import { MysqlConnection } from "./connect/mysqlConnection";
import { PostgreSqlConnection } from "./connect/postgreSqlConnection";
import { SqliteConnection } from "./connect/sqliteConnection";
import { Console } from "@/common/Console";

interface ConnectionWrapper {
    connection: IConnection;
    ssh: SSHConfig;
    schema?: string
    /**
     * 建连时对应的节点，用于在没有显式 active 时回退推断当前连接
     */
    node?: Node
}

export interface GetRequest {
    retryCount?: number;
    sessionId?: string;
}

export class ConnectionManager {

    public static activeNode: Node;
    private static alivedConnection: { [key: string]: ConnectionWrapper } = {};
    private static tunnelService = new SSHTunnelService();

    public static tryGetConnection(): Node {

        const byFile = this.getByActiveFile();
        if (byFile) { return byFile; }
        if (this.activeNode) {
            // 手写 SQL 时如果 activeNode 不带 schema，补上它自己的库，
            // 否则执行时会沿用上一个库，报 table doesn't exist。
            return this.withSchemaFallback(this.activeNode);
        }
        // 没有通过点表/切换数据库建立 active 时，退回到当前唯一已建立的连接，
        // 否则刚连上直接写 SQL 会报 "Not active database connection found!"。
        const aliveKeys = Object.keys(this.alivedConnection).filter(k => this.alivedConnection[k]);
        if (aliveKeys.length == 1) {
            return this.withSchemaFallback(this.alivedConnection[aliveKeys[0]].node);
        }
        return null;
    }

    /**
     * 保证返回的节点带有可用的库名（MySQL 的 database 等于 schema）。
     */
    private static withSchemaFallback(node: Node): Node {
        if (!node) { return node }
        if (!node.schema && !node.database) {
            const aliveKeys = Object.keys(this.alivedConnection).filter(k => this.alivedConnection[k]);
            if (aliveKeys.length >= 1) {
                const alive = this.alivedConnection[aliveKeys[0]];
                const schema = alive?.schema;
                if (schema) {
                    node = NodeUtil.of({ ...node, schema, database: node.database || schema });
                }
            }
        }
        return node;
    }

    public static getActiveConnectByKey(key: string): ConnectionWrapper {
        return this.alivedConnection[key]
    }

    public static removeConnection(uid: string) {

        try {
            const lcp = this.activeNode;
            if (lcp?.getConnectId() == uid) {
                delete this.activeNode
            }
            const activeConnect = this.alivedConnection[uid];
            if (activeConnect) {
                this.end(uid, activeConnect)
            }
            DatabaseCache.clearDatabaseCache(uid)
        } catch (error) {
            Console.log(error)
        }

    }

    public static changeActive(connectionNode: Node) {
        this.activeNode = connectionNode;
        Global.updateStatusBarItems(connectionNode);
        DbTreeDataProvider.refresh()
    }

    public static getConnection(connectionNode: Node, getRequest: GetRequest = { retryCount: 1 }): Promise<IConnection> {
        if (!connectionNode) {
            throw new Error("Connection is dead!")
        }
        return new Promise(async (resolve, reject) => {

            NodeUtil.of(connectionNode)
            if (!getRequest.retryCount) getRequest.retryCount = 1;
            const key = getRequest.sessionId || connectionNode.getConnectId();
            const connection = this.alivedConnection[key];
            if (connection) {
                if (connection.connection.isAlive()) {
                    if (connection.schema != connectionNode.schema) {
                        const sql = connectionNode?.dialect?.pingDataBase(connectionNode.schema);
                        try {
                            if (sql) {
                                await QueryUnit.queryPromise(connection.connection, sql, false)
                            }
                            connection.schema = connectionNode.schema
                            resolve(connection.connection);
                            return;
                        } catch (err) {
                            ConnectionManager.end(key, connection);
                        }
                    } else {
                        resolve(connection.connection);
                        return;
                    }
                }
            }

            const ssh = connectionNode.ssh;
            let connectOption = connectionNode;
            if (connectOption.usingSSH) {
                connectOption = await this.tunnelService.createTunnel(connectOption, (err) => {
                    reject(err?.message || err?.errno);
                    if (err.errno == 'EADDRINUSE') { return; }
                    this.alivedConnection[key] = null
                })
                if (!connectOption) {
                    reject("create ssh tunnel fail!");
                    return;
                }
            }
            const newConnection = this.create(connectOption);
            this.alivedConnection[key] = { connection: newConnection, ssh, node: connectionNode };
            newConnection.connect(async (err: Error) => {
                if (err) {
                    this.end(key, this.alivedConnection[key])
                    reject(err)
                } else {
                    try {
                        const sql = connectionNode?.dialect?.pingDataBase(connectionNode.schema);
                        if (connectionNode.schema && sql) {
                            await QueryUnit.queryPromise(newConnection, sql, false)
                        }
                    } catch (error) {
                        console.log(err)
                    }

                    // 连接成功后如果没有 active 节点，直接把它设为 active，
                    // 避免用户刚连上就写 SQL 时提示找不到活动连接
                    if (!this.activeNode && connectionNode) {
                        this.activeNode = connectionNode;
                    }

                    resolve(newConnection);
                }
            });

        });

    }

    private static create(opt: Node) {
        if (!opt.dbType) opt.dbType = DatabaseType.MYSQL
        switch (opt.dbType) {
            case DatabaseType.MSSQL:
                return new MSSqlConnnection(opt)
            case DatabaseType.PG:
                return new PostgreSqlConnection(opt)
            case DatabaseType.SQLITE:
                return new SqliteConnection(opt);
        }
        return new MysqlConnection(opt)
    }

    private static end(key: string, connection: ConnectionWrapper) {
        this.alivedConnection[key] = null
        try {
            this.tunnelService.closeTunnel(key)
            connection.connection.end();
        } catch (error) {
        }
    }

    public static getByActiveFile(): Node {
        if (vscode.window.activeTextEditor) {
            const fileName = vscode.window.activeTextEditor.document.fileName;
            // 这个判断靠扩展安装路径里是否含有扩展标识来判断「文件属于本扩展生成的 SQL」。
            // 改了 publisher 之后路径会变成 junbiaojin.xxx，所以要同时认新旧两个标识，
            // 否则从树里点表生成的 SQL 文件会认不出对应连接。
            if (fileName.includes('junbiaojin') || fileName.includes('cweijan')) {
                const queryName = path.basename(path.resolve(fileName, '..'))
                const [host, port, database, schema] = queryName
                    .replace(/^.*@@/, '') // new connection id
                    .replace(/#.+$/, '').split('@')
                if (host != null) {
                    const node = NodeUtil.of({ key: queryName.split('@@')[0], host, port: parseInt(port), database, schema });
                    if (node.getCache()) {
                        return node.getCache();
                    }
                }
            }
        }
        return null;
    }

}
