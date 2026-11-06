import { FieldInfo } from "@/common/typeDef";
import { Util } from "@/common/util";
import { ServiceManager } from "@/service/serviceManager";
import { basename, extname } from "path";
import { env, Uri, ViewColumn, window } from "vscode";
import * as vscode from "vscode";
import { Trans } from "@/common/trans";
import { ConfigKey, DatabaseType, MessageType } from "../../common/constants";
import { Global } from "../../common/global";
import { ViewManager } from "../../common/viewManager";
import { Node } from "../../model/interface/node";
import { ColumnNode } from "../../model/other/columnNode";
import { ExportService } from "../export/exportService";
import { QueryOption, QueryUnit } from "../queryUnit";
import { DataResponse } from "./queryResponse";
import { ConnectionManager } from "../connectionManager";
import { Console } from "@/common/Console";

export class QueryParam<T> {
    public connection: Node;
    public singlePage?: boolean;
    public type: MessageType;
    public res: T;
    public queryOption?: QueryOption;
}

export class QueryPage {

    private static exportService: ExportService = new ExportService()

    public static async send(queryParam: QueryParam<any>) {

        const dbOption: Node = queryParam.connection;
        await QueryPage.adaptData(queryParam);
        const type = this.keepSingle(queryParam);

        ViewManager.createWebviewPanel({
            singlePage: true,
            splitView: this.shouldSplitView(queryParam.queryOption),
            openBelow: Global.getConfig<boolean>(ConfigKey.RESULT_BELOW_EDITOR, true),
            path: 'result', title: 'Query', type,
            iconPath: Global.getExtPath("resources", "icon", "query.svg"),
            eventHandler: async (handler) => {
                handler.on("init", () => {
                    // 单面板模式下标题固定，表名放到面板内的 tab 上显示，
                    // 避免编辑器标签名跟着表来回变。
                    if (!Global.getConfig<boolean>(ConfigKey.SINGLE_RESULT_PANEL, true)) {
                        if (queryParam.res?.table) {
                            handler.panel.title = queryParam.res.table;
                        }
                    }
                    queryParam.res.transId = Trans.transId;
                    queryParam.res.viewId = queryParam.queryOption?.viewId;
                    handler.emit(queryParam.type, {
                        ...queryParam.res,
                        dbType: dbOption.dbType,
                        showColumnComment: Global.getConfig<boolean>(ConfigKey.SHOW_COLUMN_COMMENT, true),
                        autoCountTotal: Global.getConfig<boolean>(ConfigKey.AUTO_COUNT_TOTAL, false)
                    })
                }).on('execute', (params) => {
                    // 透传 noAutoPaging：结果页“全部数据”模式不能再次被自动分页截断
                    QueryUnit.runQuery(params.sql, dbOption, {
                        ...queryParam.queryOption,
                        noAutoPaging: params.noAutoPaging === true,
                    });
                }).on('next', async (params) => {
                    const executeTime = new Date().getTime();
                    const sql = ServiceManager.getPageService(dbOption.dbType).build(params.sql, params.pageNum, params.pageSize)
                    dbOption.execute(sql).then((rows) => {
                        const costTime = new Date().getTime() - executeTime;
                        // 回传本次实际使用的 pageSize 与页码，供前端同步状态
                        handler.emit(MessageType.NEXT_PAGE, {
                            sql,
                            data: rows,
                            costTime,
                            pageSize: params.pageSize,
                            pageNum: params.pageNum,
                        })
                    })
                }).on("full", () => {
                    handler.panel.reveal(ViewColumn.One)
                }).on('copy', value => {
                    Util.copyToBoard(value)
                }).on('count', async (params) => {
                    // 只在用户主动点击统计时才走这里。
                    // 自动 count 在大表上代价太高（曾跑出 41 秒慢 SQL），
                    // 默认改为“按需统计”，由前端点击 Total 触发。
                    const plan = this.buildCountSql(params.sql)
                    if (!plan) {
                        handler.emit('COUNT', { data: null, estimated: true })
                        return
                    }
                    const timeoutMs = Global.getConfig<number>(ConfigKey.COUNT_TIMEOUT, 3000)
                    let settled = false
                    const timer = setTimeout(() => {
                        if (settled) { return }
                        settled = true
                        handler.emit('COUNT', { data: null, estimated: true })
                    }, timeoutMs)
                    // 静默查询：超时是预期内情况，不能把 interrupted 当错误弹给用户
                    QueryUnit.queryPromise<any>(await ConnectionManager.getConnection(dbOption), plan.sql, false).then((result) => {
                        if (settled) { return }
                        settled = true
                        clearTimeout(timer)
                        const rows: any = result.rows
                        const row = Array.isArray(rows) ? rows[0] : rows
                        const total = row ? (row.count ?? row.COUNT ?? Object.values(row)[0]) : null
                        handler.emit('COUNT', { data: total, estimated: plan.estimated })
                    }).catch((err) => {
                        if (settled) { return }
                        settled = true
                        clearTimeout(timer)
                        Console.log(err)
                        handler.emit('COUNT', { data: null, estimated: true })
                    })
                }).on('export', (params) => {
                    this.exportService.export({ ...params.option, request: queryParam.res.request, dbOption }).then(() => {
                        handler.emit('EXPORT_DONE')
                    })
                }).on('changePageSize', (pageSize) => {
                    Global.updateConfig(ConfigKey.DEFAULT_LIMIT, pageSize)
                }).on('openGithub', () => {
                    // 二次开发版：不指向上游仓库，避免引导到付费版本
                    window.showInformationMessage(
                        'MySQL Custom：基于 cweijan/vscode-database-client 3.9.8 (MIT) 二次开发。'
                    );
                }).on('openCoffee', () => {
                    // 二次开发版不设赞助入口
                }).on('dataModify', () => {
                    if (handler.panel.title.indexOf("*") == -1) handler.panel.title = `${handler.panel.title}*`
                }).on("saveModify", (sql) => {
                    dbOption.execute(sql).then(() => {
                        handler.emit('updateSuccess')
                        handler.panel.title = handler.panel.title.replace("*", "")
                    }).catch(err => {
                        handler.emit("updateFail", err)
                    })
                }).on("jumpToLine", (params) => {
                    // 结果面板里点「跳到出错行」：把焦点交回 SQL 编辑器并选中那一行
                    const editor = window.activeTextEditor
                    if (!editor || params?.line == null) { return }
                    const line = Math.max(0, Math.min(params.line, editor.document.lineCount - 1))
                    const targetLine = editor.document.lineAt(line)
                    editor.selection = new vscode.Selection(targetLine.range.start, targetLine.range.end)
                    editor.revealRange(targetLine.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
                    window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false })
                })
            }
        });

    }

    private static async adaptData(queryParam: QueryParam<any>) {
        switch (queryParam.type) {
            case MessageType.DATA:
                await this.loadColumnList(queryParam);
                const configuredSize = ServiceManager.getPageService(queryParam.connection.dbType).getPageSize(queryParam.res.sql);
                // pageSize 表示"每页配置的大小"，不能因为某次返回行数不同就改写它。
                // 原实现把 data.length 覆盖给 pageSize，导致页面显示 101 行/页。
                ((queryParam.res) as DataResponse).pageSize = configuredSize;
                break;
            case MessageType.MESSAGE_BLOCK:
                // 成功场景不再往结果面板塞整段 SQL 回显：
                // 用户要的是"直接看数据"，SQL 自己刚写过，没必要回显一遍。
                queryParam.res.message = null;
                break;
            case MessageType.DML:
            case MessageType.DDL:
                queryParam.res.message = `影响行数：${queryParam.res.affectedRows}`;
                break;
            case MessageType.ERROR:
                // 错误只回一行摘要：完整报错已由 SqlErrorReporter 标在 SQL 编辑器对应行。
                // 这里仍保留原文，因为从树节点/右键菜单触发执行时没有源编辑器可标。
                queryParam.res.message = this.buildErrorSummary(queryParam.res);
                break;
        }
    }

    /** 把错误压成「一句话 + 出错语句」，不再用 <br> 拼大段 HTML */
    private static buildErrorSummary(res: any): string {
        const sql = this.oneLine(res.sql);
        const message = res.message || '执行失败';
        if (!sql) { return message; }
        return `${message}\n\n出错语句：${sql}`;
    }

    private static oneLine(sql: string): string {
        if (!sql) { return ''; }
        const flat = sql.replace(/\s+/g, ' ').trim();
        return flat.length > 200 ? flat.slice(0, 200) + '…' : flat;
    }

    private static keepSingle(queryParam: QueryParam<any>) {
        if (typeof queryParam.singlePage == 'undefined') {
            queryParam.singlePage = true;
        }
        if (!queryParam.queryOption) {
            queryParam.queryOption = {
                viewId: "Query"
            }
        }
        // 结果面板固定为一个，所有查询结果都在这个面板里以 tab 形式堆叠，
        // 类似 Navicat / 阿里云 DMS。关闭多面板模式时仍按 viewId 分开。
        if (Global.getConfig<boolean>(ConfigKey.SINGLE_RESULT_PANEL, true)) {
            return "QueryResult";
        }
        return queryParam.queryOption.viewId;
    }

    private static isActiveSql(option: QueryOption): boolean {

        if (!window.activeTextEditor || !window.activeTextEditor.document || option.split === false) { return false; }

        const extName = extname(window.activeTextEditor.document.fileName)?.toLowerCase()
        const fileName = basename(window.activeTextEditor.document.fileName)?.toLowerCase()

        return extName == '.sql' || fileName.match(/mock.json$/) != null || extName == '.es';
    }

    /**
     * 是否把结果页拆到右侧新编辑器组。
     * 默认 false：结果页在下方（同一编辑器组）打开，跟 9.x 习惯一致。
     * 配置 database-client.resultInSplitView 可改回右侧分栏。
     */
    private static shouldSplitView(option: QueryOption): boolean {
        const inSplit = Global.getConfig<boolean>(ConfigKey.RESULT_IN_SPLIT_VIEW, false)
        if (!inSplit) { return false }
        return this.isActiveSql(option)
    }

    /**
     * 构造总数统计 SQL。
     * 关键取舍：绝不对复杂查询套子查询做 COUNT。
     * `SELECT COUNT(*) FROM (SELECT * FROM 大表 JOIN ...)` 会让数据库
     * 物化整个结果集再数行数，生产上实测跑过 41 秒。
     *
     * 返回 { sql, estimated }：
     * - 简单单表查询：给出精确 count 语句，estimated=false
     * - 复杂查询：返回估算语句（或 null），estimated=true
     */
    private static buildCountSql(sql: string): { sql: string, estimated: boolean } {
        if (!sql) { return null }
        let clean = sql.trim().replace(/;+\s*$/, '')
        clean = clean.replace(/\s+limit\s+\d+(\s*,\s*\d+)?\s*$/i, '')
        if (!/^\s*select\b/i.test(clean)) { return null }

        // 复杂查询一律不做精确统计，避免拖垮数据库
        const complex = /\b(join|group\s+by|having|union|distinct|with)\b/i.test(clean)
            || /\(\s*select\b/i.test(clean)
        if (complex) { return null }

        // 只从单表取数时，用 COUNT(*) + 同样的 WHERE，成本可控
        const fromMatch = clean.match(/\bfrom\s+([`\w.]+)([\s\S]*)$/i)
        if (!fromMatch) { return null }
        const table = fromMatch[1]
        let tail = fromMatch[2] || ''

        // 去掉 order by：统计总数不需要排序，排序是主要的额外开销
        tail = tail.replace(/\border\s+by\b[\s\S]*$/i, '')

        return {
            // MAX_EXECUTION_TIME 让数据库自己在超时后中断，
            // 比客户端 setTimeout 更可靠（客户端超时不会真正停掉 SQL）
            sql: `SELECT /*+ MAX_EXECUTION_TIME(${Global.getConfig<number>(ConfigKey.COUNT_TIMEOUT, 3000)}) */ COUNT(*) AS count FROM ${table}${tail}`,
            estimated: false
        }
    }

    private static async loadColumnList(queryParam: QueryParam<DataResponse>) {
        // fix null point on result view
        queryParam.res.columnList = []
        const sqlList = queryParam.res.sql.match(/(?<=\b(from|join)\b\s*)(\S+)/gi)
        if (!sqlList || sqlList.length == 0) {
            return;
        }

        let tableName = sqlList[0]
        let database: string;

        if (queryParam.connection.dbType == DatabaseType.MSSQL && tableName.indexOf(".") != -1) {
            tableName = tableName.split(".")[1]
        }

        // mysql直接从结果集拿
        const fields = queryParam.res.fields
        if (fields && fields[0]?.orgTable) {
            tableName = fields[0].orgTable;
            database = fields[0].schema || fields[0].db;
            queryParam.res.database = database;
        } else {
            tableName = tableName.replace(/^"?(.+?)"?$/, '$1')
        }

        const tableNode = queryParam.connection.getByRegion(tableName)
        if (tableNode) {
            let primaryKey: string;
            let primaryKeyList = [];
            const columnList = (await tableNode.getChildren()).map((columnNode: ColumnNode) => {
                if (columnNode.isPrimaryKey) {
                    primaryKey = columnNode.column.name;
                    primaryKeyList.push(columnNode.column)
                }
                return columnNode.column;
            });
            queryParam.res.primaryKey = primaryKey;
            queryParam.res.columnList = columnList;
            queryParam.res.primaryKeyList = primaryKeyList;
            // compatible sqlite empty result.
            if (queryParam.res.fields.length == 0) {
                queryParam.res.fields = columnList as any as FieldInfo[];
            }
        } else {
            // 树节点还没加载过时 getByRegion 拿不到表，这里直接查元数据补注释与主键，
            // 否则结果页表头只剩英文字段名，看不到注释。
            await this.loadColumnListByMetadata(queryParam, database || queryParam.connection.schema, tableName)
        }
        queryParam.res.tableCount = sqlList.length;
        queryParam.res.table = tableName;
    }

    /**
     * 兜底：表节点没缓存时，直接从 information_schema 取列注释与主键，
     * 让结果页表头能显示中文注释（MySQL / MariaDB）。
     */
    private static async loadColumnListByMetadata(queryParam: QueryParam<DataResponse>, database: string, tableName: string) {
        const connection = queryParam.connection
        if (connection.dbType != DatabaseType.MYSQL || !database || !tableName) {
            return
        }
        const safeDb = database.replace(/'/g, "''")
        const safeTable = tableName.replace(/'/g, "''")
        const sql = `SELECT COLUMN_NAME name, DATA_TYPE simpleType, COLUMN_TYPE type, COLUMN_COMMENT comment, `
            + `COLUMN_KEY \`key\`, IS_NULLABLE nullable, CHARACTER_MAXIMUM_LENGTH maxLength, `
            + `COLUMN_DEFAULT defaultValue, EXTRA extra `
            + `FROM information_schema.columns WHERE table_schema = '${safeDb}' AND table_name = '${safeTable}' `
            + `ORDER BY ORDINAL_POSITION;`
        try {
            const queryResult = await QueryUnit.queryPromise<any[]>(await ConnectionManager.getConnection(connection), sql, false)
            const res = queryResult?.rows
            if (!res || res.length == 0) { return }
            queryParam.res.columnList = res as any[]
            const primaryKeys = res.filter((c: any) => c.key == 'PRI')
            queryParam.res.primaryKey = primaryKeys[0]?.name
            queryParam.res.primaryKeyList = primaryKeys
        } catch (error) {
            // 元数据查询失败不影响结果展示
        }
    }

}