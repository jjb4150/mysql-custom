"use strict";
import * as vscode from "vscode";
import { CodeCommand, ConfigKey, MessageType } from "../common/constants";
import { Global } from "../common/global";
import { Console } from "../common/Console";
import { FileManager, FileModel } from "../common/filesManager";
import { Node } from "../model/interface/node";
import { QueryPage } from "./result/query";
import { DataResponse, DMLResponse, ErrorResponse, MessageResponse, RunResponse } from "./result/queryResponse";
import { ConnectionManager } from "./connectionManager";
import { DelimiterHolder } from "./common/delimiterHolder";
import { SqlSplitter } from "./common/sqlSplitter";
import { SqlErrorReporter } from "./common/sqlErrorReporter";
import { ServiceManager } from "./serviceManager";
import { NodeUtil } from "@/model/nodeUtil";
import { Trans } from "@/common/trans";
import { IConnection } from "./connect/connection";
import { FieldInfo } from "@/common/typeDef";
import { Util } from "@/common/util";
import { SQLParser } from "@/provider/parser/sqlParser";

export class QueryUnit {

    public static queryPromise<T>(connection: IConnection, sql: string, showError = true): Promise<QueryResult<T>> {
        // 纯查询走服务端预处理（实测快约 20%）。
        // 前提：typeCast 不能对所有列调 field.buffer()，否则二进制协议会错乱。
        if (this.canUseExecute(connection, sql)) {
            return (connection as any).execute(sql).then((res: any) => ({
                rows: res.rows,
                fields: res.fields,
                total: undefined
            })).catch((err: Error) => {
                if (showError) {
                    Console.log(`Execute sql fail : ${sql}`);
                    Console.log(err);
                }
                throw err;
            })
        }
        return new Promise((resolve, reject) => {
            connection.query(sql, (err: Error, rows, fields, total) => {
                if (err) {
                    if (showError) {
                        Console.log(`Execute sql fail : ${sql}`);
                        Console.log(err);
                    }
                    reject(err);
                } else {
                    resolve(({ rows, fields, total }));
                }
            });
        });
    }

    /**
     * 判断能否安全走预处理语句。
     * 实测：SELECT / DESCRIBE / EXPLAIN 兼容；
     * SHOW 在预处理协议下带 LIMIT 会报语法错，一律跳过。
     * 前置条件：typeCast 必须用 next() 委托默认解析（见 mysqlConnection.ts）。
     */
    private static canUseExecute(connection: IConnection, sql: string): boolean {
        if (!connection || typeof (connection as any).execute !== 'function') { return false }
        if (!sql) { return false }
        const s = sql.trim()
        if (/;\s*\S/.test(s)) { return false }
        if (s.indexOf('?') >= 0) { return false }
        if (/^\s*show\b/i.test(s)) { return false }
        return /^\s*(select|desc|describe|explain)\b/i.test(s)
    }


    public static async runQuery(sql: string, connectionNode: Node, queryOption: QueryOption = {}): Promise<void> {

        if (!connectionNode) {
            vscode.window.showErrorMessage("Not active database connection found!")
            return;
        }

        Trans.begin()
        connectionNode = NodeUtil.of(connectionNode)
        if (queryOption.split == null)
            queryOption.split = (sql == null);

        // 选中的语句在编辑器里的起始行，用于把错误标到对应行
        let sourceLine: number = null;
        if (!sql) {
            const fromEditor = this.getSqlFromEditor(connectionNode, queryOption.runAll);
            sql = fromEditor.sql;
            sourceLine = fromEditor.line;
            queryOption.recordHistory = true;
        }
        if (!sql) {
            vscode.window.showErrorMessage("Not sql found!")
            return;
        }

        sql = sql.replace(/^\s*--.+/igm, '').trim();

        // 先分句，再处理 DELIMITER。
        // 顺序不能反：DelimiterHolder.parseBatch 会把 `$$` 之类统一替换成 `;`，
        // 之后就无法知道过程体内部的分号不算边界，CREATE PROCEDURE 会被拆碎。
        // 分句器自己识别 DELIMITER 指令，这里负责把这些指令登记给连接。
        const statements = SqlSplitter.split(sql);
        if (statements.length === 0) {
            // 只有 DELIMITER 指令、没有真实语句：沿用原有提示
            const parseResult = DelimiterHolder.parseBatch(sql, connectionNode.getConnectId())
            if (parseResult.replace) {
                QueryPage.send({ connection: connectionNode, type: MessageType.MESSAGE, queryOption, res: { message: `change delimiter success`, success: true } as MessageResponse });
            }
            return;
        }
        // 让连接层面也记住最新的 delimiter（存储过程后续执行需要）
        this.rememberDelimiter(sql, connectionNode);

        // 多条语句必须逐条执行。
        // 直接在 query() 里发 "A;B" 时 mysql2 会返回二维结果集
        // （[rowsA,rowsB] / [fieldsA,fieldsB]），结果页只认单结果集，
        // 会把整批数据判成「非查询」并只显示一句 EXECUTE SUCCESS。
        // 逐条发送后每条都能落到自己的结果 tab，错误也能定位到具体语句。
        if (statements.length > 1) {
            await this.runStatements(statements, connectionNode, queryOption, sourceLine);
            return;
        }

        // 单条语句：保留原有路径，避免行为回退
        sql = statements[0].sql;

        // 首次查询也加分页，否则 select * 会把整表拉进内存直接卡死。
        // 只在是查询语句、且用户没写 limit 时才加。
        // noAutoPaging 时跳过（结果页“全部数据”模式）。
        if (!queryOption.noAutoPaging) {
            const pagedSql = this.applyAutoPaging(sql, connectionNode)
            if (pagedSql !== sql) {
                sql = pagedSql
            }
        }

        QueryPage.send({ connection: connectionNode, type: MessageType.RUN, queryOption, res: { sql } as RunResponse });

        // 新一轮执行开始，先清掉上一轮留下的红波浪线，避免新旧错误叠在一起
        SqlErrorReporter.clear(vscode.window.activeTextEditor?.document);

        const absLine = sourceLine == null ? null : sourceLine + (statements[0]?.startLine ?? 0);
        const absEndLine = sourceLine == null ? null : sourceLine + (statements[0]?.endLine ?? 0);
        await this.executeSingle(sql, connectionNode, queryOption, new Date().getTime(), absLine, absEndLine);
    }

    /**
     * 把脚本里出现的 DELIMITER 指令登记到连接上，
     * 这样后续单独执行该连接的其他语句时分隔符也能保持一致。
     * 指令本身不参与执行，只影响下一次的切分。
     */
    private static rememberDelimiter(sql: string, connectionNode: Node) {
        if (!sql || !/\bdelimiter\b/i.test(sql)) { return; }
        DelimiterHolder.parseBatch(sql, connectionNode.getConnectId());
    }

    /**
     * 逐条执行多条语句。
     * MySQL 客户端遇到错误会中断后续语句，这里保持同样语义：
     * 已经成功的结果照常展示成 tab，唯一的错误单独提示。
     */
    private static async runStatements(statements: { sql: string, startLine: number, endLine: number }[],
        connectionNode: Node, queryOption: QueryOption, sourceLine: number): Promise<void> {

        // 先把整个批次报备给前端，让结果面板进入 loading 且知道这次有几条语句
        QueryPage.send({
            connection: connectionNode, type: MessageType.RUN, queryOption,
            res: { sql: statements.map(s => s.sql).join(';\n'), batchSize: statements.length } as RunResponse
        });

        // 新一轮执行开始，先清掉上一轮留下的红波浪线，避免新旧错误叠在一起
        SqlErrorReporter.clear(vscode.window.activeTextEditor?.document);

        for (const statement of statements) {
            let sql = statement.sql;
            if (!queryOption.noAutoPaging) {
                const pagedSql = this.applyAutoPaging(sql, connectionNode);
                if (pagedSql !== sql) { sql = pagedSql; }
            }

            // 错误行号要换算回编辑器里的绝对行
            const absLine = sourceLine == null ? null : sourceLine + statement.startLine;
            const absEndLine = sourceLine == null ? null : sourceLine + statement.endLine;
            const ok = await this.executeSingle(sql, connectionNode, queryOption, new Date().getTime(), absLine, absEndLine);
            if (!ok) {
                // 与 MySQL 客户端一致：出错即停止，不继续跑后面的语句
                break;
            }
        }
    }

    /**
     * 执行单条语句，返回是否成功。
     * errorLine 不为空时，错误会同时标注到编辑器对应行（见 SqlErrorReporter）。
     */
    private static executeSingle(sql: string, connectionNode: Node, queryOption: QueryOption, executeTime: number,
        errorLine: number = null, errorEndLine: number = null): Promise<boolean> {

        return new Promise<boolean>((resolve) => {
            const onResult = (err: Error, data: any, fields: any, total?: any) => {
                if (err) {
                    SqlErrorReporter.report(err, errorLine, errorEndLine);
                    QueryPage.send({
                        connection: connectionNode, type: MessageType.ERROR, queryOption,
                        res: { sql, message: err.message, line: errorLine } as ErrorResponse
                    });
                    resolve(false);
                    return;
                }
                const costTime = new Date().getTime() - executeTime;
                if (queryOption.recordHistory) {
                    vscode.commands.executeCommand(CodeCommand.RecordHistory, sql, costTime);
                }

                if (sql.match(/(create|drop|alter)\s+(table|prcedure|FUNCTION|VIEW)/i)) {
                    vscode.commands.executeCommand(CodeCommand.Refresh);
                }

                if (data.affectedRows) {
                    QueryPage.send({ connection: connectionNode, type: MessageType.DML, queryOption, res: { sql, costTime, affectedRows: data.affectedRows } as DMLResponse });
                    resolve(true);
                    return;
                }

                // query result
                if (Array.isArray(fields)) {
                    const isQuery = fields[0] != null && fields[0].name != undefined;
                    const isSqliteEmptyQuery = fields.length == 0 && sql.match(/\bselect\b/i);
                    const isMongoEmptyQuery = fields.length == 0 && sql.match(/\.collection\b/i);
                    if (isQuery || isSqliteEmptyQuery || isMongoEmptyQuery) {
                        QueryPage.send({ connection: connectionNode, type: MessageType.DATA, queryOption, res: { sql, costTime, data, fields, total } as DataResponse });
                        resolve(true);
                        return;
                    }
                }

                if (Array.isArray(data)) {
                    // mysql procedrue call result
                    const lastEle = data[data.length - 1]
                    if (data.length > 2 && Util.is(lastEle, 'ResultSetHeader') && Util.is(data[0], 'TextRow')) {
                        data = data[data.length - 2]
                        fields = fields[fields.length - 2] as any as FieldInfo[]
                        QueryPage.send({ connection: connectionNode, type: MessageType.DATA, queryOption, res: { sql, costTime, data, fields, total } as DataResponse });
                        resolve(true);
                        return;
                    }
                }

                QueryPage.send({ connection: connectionNode, type: MessageType.MESSAGE_BLOCK, queryOption, res: { sql, costTime, isInsert: sql.match(/\binsert\b/i) != null } as DMLResponse });
                resolve(true);
            };

            ConnectionManager.getConnection(connectionNode).then((connection) => {
                // 纯查询走服务端预处理（实测快约 20%），其余仍用 query()。
                // 失败时静默回退到 query()，保证功能不退化。
                if (this.canUseExecute(connection, sql)) {
                    (connection as any).execute(sql)
                        .then((res: any) => onResult(null, res.rows, res.fields))
                        .catch(() => {
                            connection.query(sql, onResult)
                        })
                } else {
                    connection.query(sql, onResult)
                }
            }).catch((error) => {
                Console.log(error);
                SqlErrorReporter.report(error, errorLine, errorEndLine);
                QueryPage.send({
                    connection: connectionNode, type: MessageType.ERROR, queryOption,
                    res: { sql, message: error?.message || String(error), line: errorLine } as ErrorResponse
                });
                resolve(false);
            });
        });
    }
    public static runBatch(connection: IConnection, sqlList: string[]) {
        return new Promise((resolve, reject) => {
            connection.beginTransaction(async () => {
                try {
                    for (let sql of sqlList) {
                        sql = sql.trim()
                        if (!sql) { continue }
                        await this.queryPromise(connection, sql)
                    }
                    connection.commit()
                    resolve(true)
                } catch (err) {
                    connection.rollback()
                    reject(err)
                }
            })
        })

    }

    /**
     * 给查询语句自动加上分页限制，避免一次性拉全表导致卡死。
     * 只处理纯 SELECT，且用户没写 limit 的情况。
     */
    public static applyAutoPaging(sql: string, connectionNode: Node): string {
        if (!sql) { return sql }
        if (!Global.getConfig<boolean>(ConfigKey.AUTO_PAGING_SQL, true)) { return sql }

        const trimmed = sql.trim()
        // 多条语句不处理，避免语义错乱
        if (/;\s*\S/.test(trimmed)) { return sql }
        // 只给 SELECT / WITH 加分页；DDL、DML、show/desc 等一律跳过
        if (!/^\s*(select|with)\b/i.test(trimmed)) { return sql }
        // 已有 limit 就尊重用户
        if (/\blimit\s+\d/i.test(trimmed)) { return sql }
        // 部分语句加分页会改变语义，跳过
        if (/\b(for\s+update|lock\s+in\s+share\s+mode|into\s+(outfile|dumpfile))\b/i.test(trimmed)) { return sql }
        // 非 MySQL 系的语句分页由各自的 PageService 负责，这里只兜底 MySQL 风格
        const limit = Global.getConfig<number>(ConfigKey.DEFAULT_LIMIT, 100)
        if (!limit || limit <= 0) { return sql }

        const base = trimmed.replace(/;+\s*$/, '')
        return `${base} LIMIT ${limit}`
    }

    private static getSqlFromEditor(connectionNode: Node, runAll: boolean): { sql: string, line: number } {
        if (!vscode.window.activeTextEditor) {
            throw new Error("No SQL file selected!");

        }
        const editor = vscode.window.activeTextEditor;
        if (runAll) {
            // 全文执行时，语句行号相对文档第 0 行
            return { sql: editor.document.getText(), line: 0 };
        }

        const selection = editor.selection;
        if (!selection.isEmpty) {
            // 选中执行时，语句行号相对选区起点
            return { sql: editor.document.getText(selection), line: selection.start.line };
        }

        const block = SQLParser.parseBlockSingle(editor.document, editor.selection.active);
        return { sql: block?.sql, line: block?.range?.start?.line ?? 0 };
    }

    public static async showSQLTextDocument(node: Node, sql: string, template = "template.sql", fileMode: FileModel = FileModel.WRITE): Promise<vscode.TextEditor> {

        const document = await vscode.workspace.openTextDocument(await FileManager.record(`${node.uid}/${template}`, sql, fileMode));
        return await vscode.window.showTextDocument(document);
    }

}



export interface QueryResult<T> {
    rows: T; fields: FieldInfo[];
    total?: number;
}


export interface QueryOption {
    viewId?: any;
    split?: boolean;
    recordHistory?: boolean;
    /**
     * runAll if get sql from editor.
     */
    runAll?: boolean;
    /**
     * 跳过自动分页。用户在结果页点“全部”时由前端传入，
     * 避免自动分页把已经写好的 LIMIT 再覆盖掉。
     */
    noAutoPaging?: boolean;
}