import * as vscode from "vscode";
import { TableMeta } from "@/common/typeDef";
import { Node } from "@/model/interface/node";
import { ComplectionChain, ComplectionContext } from "../complectionContext";
import { MetadataProvider } from "../metadataProvider";
import { extractTableRefs, stripStrings } from "../sqlAnalyzer";
import { qualifierBeforeDot, sortTextFor, sqlBeforeCursor, SortGroup } from "./completionUtil";

/**
 * 表名 / 视图名补全。
 *
 * 触发场景：
 * 1. `from ` / `join ` / `update ` / `into ` 之后 —— 给当前库的表
 * 2. `db.` 之后 —— 给该库的表
 * 3. 输入片段由 VS Code 按 filterText 过滤，输入 ai 也能匹配 g_product_ai
 */
export class TableChain implements ComplectionChain {

    private needStop = false;

    public async getComplection(context: ComplectionContext): Promise<vscode.CompletionItem[]> {

        const node = MetadataProvider.activeConnection();
        if (!node) { return null; }

        // 去掉正在输入的那个词，只看它前面的部分
        const before = stripStrings(sqlBeforeCursor(context.sqlBlock, context.position))
            .replace(/[`"\[\]\w\u4e00-\u9fa5$.]*$/, '');

        const qualifier = qualifierBeforeDot(context.document, context.position);

        // 场景 2：`db.` —— 取该库的表
        if (qualifier) {
            const tables = await MetadataProvider.getTables(node, qualifier);
            if (tables.length > 0) {
                this.needStop = true;
                return tables.map(t => this.toTableItem(t));
            }
            return null;
        }

        // 场景 1：在 FROM / JOIN 等关键字之后
        if (!this.isTablePosition(before)) { return null; }

        const schema = this.detectSchema(context, node);
        const tables = await MetadataProvider.getTables(node, schema);
        if (tables.length === 0) { return null; }

        this.needStop = true;
        return tables.map(t => this.toTableItem(t));
    }

    /**
     * 判断光标处是不是期望表名的位置。
     *
     * 注意不要用「关键字后面跟空格就算表位置」这种宽泛判断：
     * `where ` 也会命中，导致在 WHERE 里给出表名而不是列名。
     * 这里改成显式枚举：只有当最近的子句关键字确实是表名相关的，
     * 并且光标距它之间只有「表名/别名/逗号/空白」时才认为是表位置。
     */
    private isTablePosition(before: string): boolean {
        const trimmed = before.replace(/\s+$/, '');
        if (!trimmed) { return false; }

        // 直接跟在表名关键字后：FROM / JOIN / UPDATE / INTO / TABLE / DESC
        if (/\b(from|join|update|into|table|desc|describe|truncate)\s+$/i.test(before)) { return true; }

        // 关键字后正在输入表名：from op_st|
        if (/\b(from|join|update|into)\s+[`"\[\]\w\u4e00-\u9fa5$]*$/i.test(trimmed)) { return true; }

        // 逗号分隔的多表：from t1, |  或  from t1 a, |
        if (/,\s*$/.test(trimmed)) {
            const lastClause = this.lastClauseKeyword(trimmed);
            return lastClause === 'from' || lastClause === 'join';
        }

        return false;
    }

    /**
     * 取光标前最后一个结构性关键字。
     * 只有子句级关键字参与判断，AND/ON 这类不算——它们出现在 WHERE 内部。
     */
    private lastClauseKeyword(text: string): string {
        const matches = [...text.matchAll(/\b(from|join|update|into|table|where|group\s+by|order\s+by|having|limit|offset|set|values|select|on|using)\b/gi)];
        return matches.length > 0 ? matches[matches.length - 1][1].toLowerCase().replace(/\s+/g, ' ') : '';
    }

    /**
     * 推断当前语句该用哪个库：
     * 语句里写了 db.表 就优先用那个 db，否则用活动连接的库。
     */
    private detectSchema(context: ComplectionContext, node: Node): string {
        const sql = stripStrings(context.sqlBlock?.sql || '');
        const refs = extractTableRefs(sql);
        const withCatalog = refs.find(r => r.catalog);
        return withCatalog ? withCatalog.catalog : (node.schema || node.database);
    }

    private toTableItem(table: TableMeta): vscode.CompletionItem {
        const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Struct);
        item.insertText = table.name;
        item.filterText = table.name;
        item.sortText = sortTextFor(SortGroup.TABLE, table.name);

        const parts: string[] = [];
        if (table.rows != null && table.rows !== '') { parts.push(`rows ${table.rows}`); }
        if (table.comment) { parts.push(table.comment); }
        item.detail = parts.join(' · ');

        if (table.comment) {
            const md = new vscode.MarkdownString();
            md.appendCodeblock(table.name, 'sql');
            md.appendMarkdown(`\n${table.comment}`);
            item.documentation = md;
        }
        return item;
    }

    public stop(): boolean {
        return this.needStop;
    }
}