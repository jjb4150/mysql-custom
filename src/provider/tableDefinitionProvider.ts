import { DatabaseType } from "@/common/constants";
import { TableNode } from "@/model/main/tableNode";
import { ConnectionManager } from "@/service/connectionManager";
import { QueryUnit } from "@/service/queryUnit";
import * as vscode from "vscode";
import { extractTableRefs, stripQuote, TableRef } from "./complete/sqlAnalyzer";
import { SQLParser } from "./parser/sqlParser";

/**
 * Ctrl+点击 跳转到定义。
 *
 * 支持三类目标：
 * 1. 表名（FROM mk_activity_info）→ 打开该表的 DDL
 * 2. 表别名（FROM mk_activity_info mkai 里的 mkai）→ 解析到真实表再打开 DDL
 * 3. 字段（mkai.memo / memo）→ 打开所属表的 DDL，并定位到该字段所在行
 *
 * DDL 用只读虚拟文档展示，避免污染用户文件。
 */
export class TableDefinitionProvider implements vscode.DefinitionProvider {

    private static cache: { [uri: string]: string } = {};

    public static readonly SCHEME = 'dbclient-ddl';

    public static register(): vscode.Disposable {
        return vscode.workspace.registerTextDocumentContentProvider(TableDefinitionProvider.SCHEME, {
            provideTextDocumentContent(uri: vscode.Uri): string {
                return TableDefinitionProvider.cache[uri.toString()] || '-- Table DDL not available'
            }
        })
    }

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | null> {

        const connection = ConnectionManager.tryGetConnection();
        if (!connection) { return null }

        // 取光标所在的完整标识符，可能带限定符（mkai.memo / db.tbl）
        const target = this.resolveIdentifier(document, position);
        if (!target) { return null }

        // 用补全那套解析器分析当前语句的表引用，能识别别名、CTE、派生表
        const sql = this.currentStatement(document, position);
        const refs = extractTableRefs(stripStringsSafe(sql));

        // 情况 A：光标在一个单独的标识符上（没有 x. 形式）。
        // 它可能是：别名、表名、或者裸字段名，按这个优先级依次尝试。
        if (!target.column) {
            // A1：是某个表引用（别名或表名）
            const ref = this.findRef(refs, target.qualifier);
            if (ref) {
                return this.openTable(connection, ref.table, ref.catalog, null);
            }

            // A2：当前语句里含 FROM，说明这个裸词更可能是字段名而不是表名。
            // 先去各表里找有没有这个列，命中就跳转到字段定义。
            if (refs.length > 0) {
                for (const r of refs.slice(0, 12)) {
                    if (r.virtual) { continue; }
                    const location = await this.openTable(connection, r.table, r.catalog, target.qualifier);
                    if (location) { return location; }
                }
            }

            // A3：最后再当作表名试一次（光标可能就停在表单上）
            return this.openTable(connection, target.qualifier, undefined, null);
        }

        // 情况 B：有列名。先按限定符找到表，再定位字段
        // 情况 B1：mkai.memo —— 限定符是别名
        if (target.qualifier) {
            const ref = this.findRef(refs, target.qualifier);
            if (ref) {
                return this.openTable(connection, ref.table, ref.catalog, target.column);
            }
            // 限定符可能是库名，直接拼成表名再试
            return this.openTable(connection, target.column, target.qualifier, target.column);
        }

        // 情况 B2：裸字段名 memo —— 在当前语句涉及的表里逐个找
        if (refs.length > 0) {
            for (const ref of refs.slice(0, 12)) {
                if (ref.virtual) { continue; }
                const location = await this.openTable(connection, ref.table, ref.catalog, target.column);
                if (location) { return location; }
            }
        }
        return null;
    }

    /**
     * 解析光标所在的标识符。
     * 输入形如 `mkai.memo` 时返回 { qualifier: 'mkai', column: 'memo' }；
     * 单个词 `mkai` 返回 { qualifier: 'mkai', column: null }。
     */
    private resolveIdentifier(document: vscode.TextDocument, position: vscode.Position): { qualifier: string; column: string | null } | null {
        const line = document.lineAt(position.line).text;

        // 光标的词范围（含中文、下划线、$）
        const wordRange = document.getWordRangeAtPosition(position, /[`"\w\u4e00-\u9fa5$]+/);
        if (!wordRange) { return null }
        const word = stripQuote(document.getText(wordRange));
        if (!word) { return null }
        // 防御：标识符不可能含空格或太长。范围异常时直接放弃，
        // 避免把整行当成表名去查（会打出无效的 SHOW CREATE TABLE）。
        if (/\s/.test(word) || word.length > 128) { return null }

        // 看词前面是否紧跟着 `xxx.`，有的话当前词是列名
        const before = line.substring(0, wordRange.start.character);
        const qualifierMatch = /([`"\w\u4e00-\u9fa5$]+)\s*\.\s*$/.exec(before);
        if (qualifierMatch) {
            return { qualifier: stripQuote(qualifierMatch[1]), column: word };
        }

        // 看词后面是否紧跟着 `.`
        const after = line.substring(wordRange.end.character);
        if (/^\s*\./.test(after)) {
            return { qualifier: word, column: null };
        }

        return { qualifier: word, column: null };
    }

    /** 在表引用里找匹配的限定符（别名或表名，忽略大小写与引号） */
    private findRef(refs: TableRef[], qualifier: string): TableRef | null {
        const lower = qualifier.toLowerCase();
        return refs.find(r =>
            (r.alias && r.alias.toLowerCase() === lower) ||
            r.table.toLowerCase() === lower
        ) || null;
    }

    /** 取光标所在的 SQL 语句，用补全那套容错解析 */
    private currentStatement(document: vscode.TextDocument, position: vscode.Position): string {
        try {
            const block = SQLParser.parseBlockForCompletion(document, position);
            const sql = block?.sql || '';
            if (sql.trim()) { return sql; }
        } catch {
            // 解析器依赖连接信息（分隔符），拿不到时会抛异常，走下面的兜底
        }
        // 兜底：把整个文档内容当作一段 SQL。
        // 解析失败时宁可范围大一点，也好过完全跳不了。
        return document.getText();
    }

    /**
     * 打开表 DDL。column 不为空时，把位置定位到该字段所在行。
     * 找不到字段返回 null（这样裸字段名场景可以继续尝试下一张表）。
     */
    private async openTable(connection: any, tableName: string, catalog: string | undefined, column: string | null): Promise<vscode.Location | null> {
        if (!tableName) { return null }

        const ddl = await this.resolveDdl(connection, tableName, catalog);
        if (!ddl) { return null }

        const line = column ? this.findColumnLine(ddl, column) : 0;
        if (column && line < 0) { return null }

        const connectId = connection.getConnectId ? connection.getConnectId() : 'connection';
        const safeName = `${catalog ? catalog + '.' : ''}${tableName}`;
        const uri = vscode.Uri.parse(`${TableDefinitionProvider.SCHEME}:/${connectId}/${safeName}.sql`);
        TableDefinitionProvider.cache[uri.toString()] = ddl;

        return new vscode.Location(uri, new vscode.Position(line < 0 ? 0 : line, 0));
    }

    /**
     * 在 DDL 里定位字段定义所在行。
     * MySQL 的 SHOW CREATE TABLE 形如：
     *   `column_name` varchar(64) NOT NULL COMMENT 'xxx',
     * 这里按行首的反引号字段名匹配，忽略大小写。
     */
    private findColumnLine(ddl: string, column: string): number {
        const lines = ddl.split('\n');
        const target = column.toLowerCase();

        // 先精确匹配「行首的字段定义」：`col` type ... / "col" type ... / col type ...
        const patterns = [
            /^`([^`]+)`\s+\S/,          // MySQL 反引号
            /^"([^"]+)"\s+\S/,           // PostgreSQL 双引号
            /^([A-Za-z_][\w$]*)\s+[A-Za-z(]/,  // 无引号
        ];
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i].trim();
            for (const re of patterns) {
                const m = re.exec(text);
                if (m && m[1] && m[1].toLowerCase() === target) { return i; }
            }
        }

        // 兜底：整行里出现该字段名
        for (let i = 0; i < lines.length; i++) {
            if (new RegExp('`' + escapeRegExp(target) + '`', 'i').test(lines[i])) { return i; }
        }
        return -1;
    }

    private async resolveDdl(connection: any, tableName: string, catalog?: string): Promise<string> {
        try {
            const cached = connection.getByRegion?.(tableName) as TableNode
            if (cached) {
                const res = await cached.execute<any[]>(cached.dialect.showTableSource(cached.schema, cached.table))
                const ddl = res?.[0]?.['Create Table']
                if (ddl) { return ddl }
            }
        } catch (error) {
            // 走下面的兜底
        }

        try {
            if (connection.dbType == DatabaseType.MYSQL) {
                const schema = catalog || connection.schema || connection.database
                const sql = schema
                    ? `SHOW CREATE TABLE \`${schema}\`.\`${tableName}\``
                    : `SHOW CREATE TABLE \`${tableName}\``
                const res = await QueryUnit.queryPromise<any[]>(await ConnectionManager.getConnection(connection), sql, false)
                return res?.rows?.[0]?.['Create Table'] || null
            }
        } catch (error) {
            return null
        }
        return null
    }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉字符串字面量，避免其中的关键字干扰分析（保持长度不变无需，这里只为解析） */
function stripStringsSafe(sql: string): string {
    let out = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'" && !inDouble) { inSingle = !inSingle; out += ' '; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; out += ' '; continue; }
        out += (inSingle || inDouble) ? ' ' : ch;
    }
    return out;
}