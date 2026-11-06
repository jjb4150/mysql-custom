import * as vscode from "vscode";
import { Console } from "../../common/Console";
import { ColumnChain } from "./chain/columnChain";
import { DDLChain } from "./chain/ddlChain";
import { DMLChain } from "./chain/dmlChain";
import { KeywordChain } from "./chain/keywordChain";
import { TableChain } from "./chain/tableChain";
import { ComplectionContext } from "./complectionContext";

export class CompletionProvider implements vscode.CompletionItemProvider {

    /**
     * 链的执行顺序：越靠前越具体，命中后可以中断后续链。
     *
     * 顺序的依据是「当前上下文有多确定」：
     * 1. DDL —— 建表/改表的语法位置很明确
     * 2. ColumnChain —— `a.` 或 SELECT/WHERE 列表，能确定是列
     * 3. TableChain —— FROM/JOIN 之后，能确定是表
     * 4. DMLChain —— 函数、INSERT 列清单，位置判断最宽松，必须往后放
     * 5. KeywordChain —— 兜底
     *
     * 关键：DMLChain 判断「是否在值位置」时用的是宽泛的关键字匹配，
     * 如果排在 Column/Table 前面，会把 `from ` 和 `where ` 都当成
     * 值位置而返回函数列表，导致表名和列名补全全被吞掉。
     */
    private completeChain() {
        return [
            new DDLChain(),
            new ColumnChain(),
            new TableChain(),
            new DMLChain(),
            new KeywordChain(),
        ];
    }

    public async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {

        const context = ComplectionContext.build(document, position);

        // 空文档/空白位置也要给关键字补全，不能直接返回空数组。
        // 只有解析器完全拿不到块（极少数异常情况）时才放弃。
        if (!context.sqlBlock) {
            return [];
        }

        // 先跑会「短路」的具体链，命中就停，避免多余的数据库查询。
        // 关键字链放在最后兜底，永远参与。
        const chains = this.completeChain();
        const results: vscode.CompletionItem[] = [];

        for (const chain of chains) {
            let items: vscode.CompletionItem[];
            try {
                items = await chain.getComplection(context);
            } catch (err) {
                Console.log(err);
                continue;
            }
            if (!items || items.length === 0) { continue; }

            results.push(...items);
            if (chain.stop()) { return this.dedupe(results); }
        }

        return this.dedupe(results);
    }

    /**
     * 同名项去重，保留先出现的那个（靠前的链更具体）。
     */
    private dedupe(items: vscode.CompletionItem[]): vscode.CompletionItem[] {
        const seen = new Set<string>();
        const out: vscode.CompletionItem[] = [];
        for (const item of items) {
            const rawLabel: any = item.label;
            const label: string = typeof rawLabel === 'string' ? rawLabel : (rawLabel && rawLabel.label);
            if (!label) { continue; }
            const kind = item.kind ?? 0;
            const key = `${kind}::${label}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            out.push(item);
        }
        return out;
    }

    public resolveCompletionItem(item: vscode.CompletionItem): vscode.ProviderResult<vscode.CompletionItem> {
        return item;
    }
}