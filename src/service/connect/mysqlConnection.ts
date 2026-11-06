import { Node } from "@/model/interface/node";
import * as fs from "fs";
import * as mysql from "mysql2";
import { IConnection, queryCallback } from "./connection";
import { dumpTypeCast } from './convert/mysqlTypeCast';
import { Console } from "@/common/Console";

export class MysqlConnection extends IConnection {
    private con: mysql.Connection;
    constructor(node: Node) {
        super()
        let config = {
            host: node.host, port: node.port, user: node.user, password: node.password,
            timezone: node.timezone,
            multipleStatements: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
            connectTimeout: node.connectTimeout || 5000,
            typeCast: (field, next) => {
                if (this.dumpMode) return dumpTypeCast(field as mysql.TypecastField)
                // 只对 BIT 做特殊处理，其余类型交给 next()。
                // 原写法对所有列无条件调用 field.buffer()，在预处理（二进制协议）下
                // 会重复消费数据包导致 PROTOCOL_UNEXPECTED_PACKET，连接直接损坏。
                if (field.type == 'BIT') {
                    const buf = field.buffer();
                    return this.bitToBoolean(buf)
                }
                return next();
            }
        } as mysql.ConnectionConfig;

        // MySQL 中 database 与 schema 是同一个概念。SchemaNode 只带 schema 不带 database，
        // 若只取 node.database 会连到上一次的库，导致 table doesn't exist。
        // 注意：新建连接时两者可能都是空串，此时绝不能传 database 字段
        // （阿里云 PolarDB 会拒绝空库名：Illegal database ''）。
        const dbName = (node.database || node.schema || '').trim();
        if (dbName) {
            config.database = dbName;
        }
        // 诊断：确认实际传给 mysql2 的库名（空值绝不能出现）
        Console.log(`[mysql connect] host=${node.host} db=${JSON.stringify(dbName)} ` +
            `hasDatabaseField=${'database' in config}`);
        if (node.useSSL) {
            config.ssl = {
                rejectUnauthorized: false,
                ca: (node.caPath) ? fs.readFileSync(node.caPath) : null,
                cert: (node.clientCertPath) ? fs.readFileSync(node.clientCertPath) : null,
                key: (node.clientKeyPath) ? fs.readFileSync(node.clientKeyPath) : null,
                minVersion: 'TLSv1'
            }
        }
        this.con = mysql.createConnection(config);
    }
    isAlive(): boolean {
        return !this.dead && (this.con.state == 'authenticated' || this.con.authorized)
    }
    query(sql: string, callback?: queryCallback): void;
    query(sql: string, values: any, callback?: queryCallback): void;
    query(sql: any, values?: any, callback?: any) {
        return this.con.query({ sql, infileStreamFactory: (path: string) => fs.createReadStream(path) } as any, values, callback)
    }

    /**
     * 预处理语句：走服务端 prepare/execute，参数化绑定。
     * 相比 query() 拼接字符串，省一次解析、且天然防注入。
     */
    execute(sql: string, values?: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const callback = (err: Error, rows: any, fields: any) => {
                if (err) { reject(err) } else { resolve({ rows, fields }) }
            }
            if (values && values.length) {
                (this.con as any).execute(sql, values, callback)
            } else {
                (this.con as any).execute(sql, callback)
            }
        })
    }

    /**
     * 流式查询：逐行回调，不把整个结果集堆在内存里。
     * 大表导出时内存占用从 O(总行数) 降到 O(1)。
     * onFields 会在数据行之前回调一次，用于取列名。
     */
    queryStream(sql: string, onRow: (row: any) => void, onEnd: (err?: Error) => void, onFields?: (fields: any[]) => void): void {
        let done = false
        const finish = (err?: Error) => {
            if (done) { return }
            done = true
            onEnd(err)
        }
        try {
            const stream = (this.con as any).query(sql)
            stream.on('fields', (fields: any) => {
                if (fields && fields.length && onFields) {
                    try { onFields(fields) } catch (e) { /* 忽略消费方异常 */ }
                }
            })
            stream.on('result', (row: any) => {
                try {
                    onRow(row)
                } catch (e) {
                    // 消费方异常不应打断整个流
                }
            })
            stream.on('error', (err: Error) => finish(err))
            stream.on('end', () => finish())
        } catch (error) {
            finish(error)
        }
    }
    connect(callback: (err: Error) => void): void {
        this.con.connect(callback)
        this.con.on("error", () => {
            this.dead = true;
        })
        this.con.on("end", () => {
            this.dead = true;
        })
    }
    beginTransaction(callback: (err: Error) => void): void {
        this.con.beginTransaction(callback)
    }
    rollback(): void {
        this.con.rollback()
    }
    commit(): void {
        this.con.commit()
    }
    end(): void {
        this.dead = true;
        this.con.end()
    }

    bitToBoolean(buf: Buffer): any {
        return buf ? buf[0] == 1 : null;
    }

}