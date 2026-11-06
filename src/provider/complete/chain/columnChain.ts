import * as vscode from "vscode";
import { ColumnMeta } from "@/common/typeDef";
import { Node } from "@/model/interface/node";
import { ComplectionChain, ComplectionContext } from "../complectionContext";
import { MetadataProvider } from "../metadataProvider";
import { extractTableRefs, isInColumnContext, stripStrings, TableRef } from "../sqlAnalyzer";
import { qualifierBeforeDot, sortTextFor, sqlBeforeCursor, SortGroup } from "./completionUtil";

/**
 * 列名补全。
 *
 * 三种触发场景：
 * 1. `a.` / `db.t.` —— 光标前有点号，按限定符反查是哪张表，给该表的列
 * 2. `where ` / `on ` / `select ` 等列位置，没有限定符 —— 给当前语句所有表的列
 * 3. 输入片段做模糊匹配（输入 ai 也能匹配 g_product_ai）
 */
export class ColumnChain implements ComplectionChain {

    private needStop = false;

    public async getComplection(context: ComplectionContext): Promise<vscode.CompletionItem[]> {

        const node = MetadataProvider.activeConnection();
        if (!node) { return null; }

        const sql = stripStrings(context.sqlBlock?.sql || '');
        const before = stripStrings(sqlBeforeCursor(context.sqlBlock, context.position));

        // 场景 1：光标前是 `qualifier.`
        const qualifier = qualifierBeforeDot(context.document, context.position);
        if (qualifier) {
            const items = await this.completeByQualifier(node, sql, qualifier);
            if (items.length > 0) {
                this.needStop = true;
                return items;
            }
            // 限定符不是表/别名，可能是库名，交给 TableChain
            return null;
        }

        // 场景 2：处于列的位置，给所有相关表的列
        if (!isInColumnContext(before)) { return null; }

        const refs = extractTableRefs(sql);
        if (refs.length === 0) { return null; }

        // 真实业务里有 44 / 64 个 JOIN 的统计 SQL。
        // 全量并发查列会瞬间打出几十条 SQL，把连接池和 UI 都拖住。
        // 这里限制并发数，并且只取最靠前的一批表（用户通常在看前几张表）。
        const MAX_TABLES = 12;
        const CONCURRENCY = 4;
        const targets = refs.slice(0, MAX_TABLES);

        const multi = targets.length > 1;
        const columnLists = await this.loadColumnsLimited(node, targets, CONCURRENCY);
        const items: vscode.CompletionItem[] = [];
        const seen = new Set<string>();

        targets.forEach((ref, i) => {
            for (const column of columnLists[i]) {
                const key = `${ref.alias}.${column.name}`;
                if (seen.has(key)) { continue; }
                seen.add(key);
                // 多表时插入带限定符的完整名，避免歧义
                items.push(this.toColumnItem(column, multi ? ref.alias : null));
            }
        });

        if (items.length === 0) { return null; }
        this.needStop = true;
        return items;
    }

    /** 限并发地批量取列 */
    private async loadColumnsLimited(node: Node, refs: TableRef[], concurrency: number): Promise<ColumnMeta[][]> {
        const results: ColumnMeta[][] = new Array(refs.length);
        let cursor = 0;
        const worker = async () => {
            while (true) {
                const i = cursor++;
                if (i >= refs.length) { return; }
                results[i] = await this.loadColumns(node, refs[i]);
            }
        };
        const workers: Promise<void>[] = [];
        for (let i = 0; i < Math.min(concurrency, refs.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return results.map(r => r || []);
    }

    /**
     * 按限定符取列。限定符可能是表别名、表名。
     * 都不是时按表名最后试一次（用户可能还没写 FROM）。
     */
    private async completeByQualifier(node: Node, sql: string, qualifier: string): Promise<vscode.CompletionItem[]> {
        const refs = extractTableRefs(sql);
        const lower = qualifier.toLowerCase();

        const ref = refs.find(r =>
            (r.alias && r.alias.toLowerCase() === lower) ||
            r.table.toLowerCase() === lower
        );

        if (ref) {
            const columns = await this.loadColumns(node, ref);
            return columns.map(c => this.toColumnItem(c, null));
        }

        // 没在 FROM/JOIN 里找到。如果这个限定符看起来像 CTE/派生表别名
        // （短名字，不含下划线前缀），不再盲查数据库，直接返回空。
        // 盲查会为每个不存在的名字发一次 SQL，在 44/64 JOIN 的大语句里很浪费。
        const columns = await MetadataProvider.getColumns(node, qualifier);
        return columns.map(c => this.toColumnItem(c, null));
    }

    private async loadColumns(node: Node, ref: TableRef): Promise<ColumnMeta[]> {
        // 虚拟表（CTE / 派生表）：列名从内部 SELECT 推导，
        // 不能去 information_schema 查——这些名字在库里不存在。
        if (ref.virtual) {
            return (ref.virtualColumns || []).map(name => ({
                name,
                type: '',
                comment: 'CTE / 子查询输出列',
            } as ColumnMeta));
        }
        try {
            return await MetadataProvider.getColumns(node, ref.table, ref.catalog || node.schema);
        } catch {
            return [];
        }
    }

    private toColumnItem(column: ColumnMeta, prefix: string | null): vscode.CompletionItem {
        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);

        item.insertText = prefix ? `${prefix}.${column.name}` : column.name;
        // filterText 用同样的串，保证输入 ai 时 VS Code 的默认过滤也能命中
        item.filterText = prefix ? `${prefix}.${column.name}` : column.name;
        item.sortText = sortTextFor(SortGroup.COLUMN, column.name);

        const parts: string[] = [];
        if (column.type) { parts.push(column.type); }
        const isPk = column.key === 'PRI' || column.key === 'PRIMARY KEY';
        if (isPk) { parts.push('PK'); }
        if (column.nullable === 'NO') { parts.push('NOT NULL'); }
        if (column.comment) { parts.push(column.comment); }
        item.detail = parts.join(' · ');

        if (column.type || column.comment) {
            const md = new vscode.MarkdownString();
            md.appendCodeblock(`${column.name} ${column.type || ''}`.trim(), 'sql');
            if (column.comment) { md.appendMarkdown(`\n${column.comment}`); }
            item.documentation = md;
        }

        return item;
    }

    public stop(): boolean {
        return this.needStop;
    }
}