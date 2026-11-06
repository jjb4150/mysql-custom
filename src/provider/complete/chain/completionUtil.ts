import * as vscode from "vscode";
import { SQLBlock } from "../../parser/sqlBlcok";

/**
 * 补全项的排序分层。
 *
 * VS Code 默认按字母序排，导致关键字、表、列、函数混在一起，
 * 想找的列反而排在后面。这里用 sortText 前缀强制分层：
 * 数字越小越靠前，同层内再按原名排序（VS Code 会接着比后续字符）。
 */
export const SortGroup = {
    /** 当前语句里已经出现的表的列，最相关 */
    COLUMN: 0,
    /** 表 / 视图 */
    TABLE: 1,
    /** 函数 */
    FUNCTION: 2,
    /** 关键字 */
    KEYWORD: 3,
} as const;

export function sortTextFor(group: number, name: string): string {
    return `${group}_${(name || '').toLowerCase()}`;
}

/**
 * 计算光标在 block.sql 中的字符偏移。
 *
 * block.sql 是解析器重新拼出来的文本：行与行之间用 \n 连接，
 * 且每行结束后会补一个 \n（包括最后一行）。
 * block.range.start 是 SQL 在文档里的真实起点，
 * 首行的字符位置要减去 start.character。
 */
export function offsetInBlock(block: SQLBlock, position: vscode.Position): number {
    if (!block || !block.range) { return -1; }
    const start = block.range.start;
    if (position.line < start.line) { return -1; }

    const lines = (block.sql || '').split('\n');
    const lineDelta = position.line - start.line;

    let offset = 0;
    for (let i = 0; i < lineDelta && i < lines.length; i++) {
        offset += lines[i].length + 1;
    }
    // 首行开头可能不是第 0 列（SQL 前面有缩进），要减掉
    const columnBase = lineDelta === 0 ? start.character : 0;
    offset += Math.max(0, position.character - columnBase);

    return Math.max(0, Math.min(offset, (block.sql || '').length));
}

/** 取 block.sql 中光标之前的部分 */
export function sqlBeforeCursor(block: SQLBlock, position: vscode.Position): string {
    if (!block) { return ''; }
    const offset = offsetInBlock(block, position);
    if (offset < 0) { return block.sql || ''; }
    return (block.sql || '').substring(0, offset);
}

/** 取光标当前正在输入的词（用于模糊过滤的查询串） */
export function currentWord(document: vscode.TextDocument, position: vscode.Position): string {
    const line = document.lineAt(position.line).text;
    const before = line.substring(0, position.character);
    const m = before.match(/[\w\u4e00-\u9fa5$]+$/);
    return m ? m[0] : '';
}

/** 光标前面紧邻的是不是点号（`a.` 场景） */
export function isAfterDot(document: vscode.TextDocument, position: vscode.Position): boolean {
    const line = document.lineAt(position.line).text;
    const before = line.substring(0, position.character).replace(/\s+$/, '');
    return before.endsWith('.');
}

/** 取点号前面的限定符，例如 `where a.` → a */
export function qualifierBeforeDot(document: vscode.TextDocument, position: vscode.Position): string | null {
    const line = document.lineAt(position.line).text;
    const before = line.substring(0, position.character);
    const m = before.match(/(?:`([^`]+)`|"([^"]+)"|([\w\u4e00-\u9fa5$]+))\s*\.\s*$/);
    if (!m) { return null; }
    return m[1] || m[2] || m[3];
}