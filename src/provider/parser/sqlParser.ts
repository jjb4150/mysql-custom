import { DelimiterHolder } from '@/service/common/delimiterHolder';
import { ConnectionManager } from '@/service/connectionManager';
import * as vscode from 'vscode';
import { SQLBlock, SQLToken } from './sqlBlcok';
import { TokenContext } from './tokenContext';

export interface ParseOption {
    /**
     * 补全场景的容错模式：
     * 跨行引号/注释在到达新行时强制复位，避免一处手误（如未闭合的 '）
     * 把后续所有行都当成字符串内容，导致光标所在语句解析不出来。
     */
    tolerant?: boolean;
    /**
     * 取消 5000 行上限。
     * 执行整段脚本时需要把全文都切出来，否则 5000 行之后的分号全被忽略。
     */
    unlimited?: boolean;
}

export class SQLParser {

    public static parseBlockSingle(document: vscode.TextDocument, current?: vscode.Position): SQLBlock {
        return this.parseBlocks(document, current)[0]
    }

    /**
     * 补全专用：保证返回的块一定覆盖光标位置。
     *
     * parseBlockSingle 是为「执行当前语句」设计的，它需要考虑到
     * 「完整语句后面跟一行裸 ID」这种误粘贴场景，所以有按行截断的启发式。
     * 那套规则对执行是对的，但用来做补全就会出问题：光标后面的内容
     * 会干扰光标所在语句的边界判断，表现为「文件越写越长补全越不准」。
     *
     * 这里换成以光标为中心的窗口解析：
     * 1. 只取光标前后若干行，避免整篇文档扫描（也绕开 5000 行上限）
     * 2. 用容错模式解析，未闭合引号/注释不会污染后面的行
     * 3. 挑出覆盖光标的块，坐标换算回文档绝对位置
     */
    public static parseBlockForCompletion(document: vscode.TextDocument, position: vscode.Position): SQLBlock {
        const windowSize = 200;
        const startLine = Math.max(0, position.line - windowSize);
        const endLine = Math.min(document.lineCount - 1, position.line + windowSize);

        const lines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            lines.push(document.lineAt(i).text);
        }

        const sliceDoc = this.createSliceDocument(lines);
        const relativePosition = new vscode.Position(position.line - startLine, position.character);
        const blocks = this.parseBlocks(sliceDoc, undefined, { tolerant: true });

        let target: SQLBlock = null;
        for (const block of blocks) {
            if (block.range.contains(relativePosition)) { target = block; break; }
        }

        // 光标落在两段之间（如分号右侧空白）时，取它前面最近的那块
        if (!target && blocks.length > 0) {
            for (const block of blocks) {
                if (block.range.start.isBeforeOrEqual(relativePosition)) { target = block; }
            }
            if (!target) { target = blocks[0]; }
        }

        if (!target) {
            const empty = new vscode.Position(position.line, position.character);
            return { sql: '', range: new vscode.Range(empty, empty), tokens: [], scopes: [] };
        }

        const toAbsolute = (pos: vscode.Position) => new vscode.Position(pos.line + startLine, pos.character);
        return {
            sql: target.sql,
            range: new vscode.Range(toAbsolute(target.range.start), toAbsolute(target.range.end)),
            tokens: target.tokens.map(token => ({
                content: token.content,
                type: token.type,
                range: new vscode.Range(toAbsolute(token.range.start), toAbsolute(token.range.end)),
            })),
            scopes: target.scopes.map(scope => new vscode.Range(toAbsolute(scope.start), toAbsolute(scope.end))),
        };
    }

    /**
     * 把行数组包装成一个最小的 TextDocument 实现，只提供 parseBlocks 需要的成员。
     */
    private static createSliceDocument(lines: string[]): vscode.TextDocument {
        return {
            lineCount: lines.length,
            lineAt: (index: number) => ({ text: lines[index] ?? '' }),
        } as unknown as vscode.TextDocument;
    }

    public static parseBlocks(document: vscode.TextDocument, current?: vscode.Position, option?: ParseOption): SQLBlock[] {


        const delimter = this.getDelimter();

        const blocks: SQLBlock[] = []
        let lastLineLength: number;
        const context = { inSingleQuoteString: false, inDoubleQuoteString: false, inComment: false, sql: '', start: null }
        let tokenContext = new TokenContext()

        // 容错模式（补全）传入的是光标附近的小窗口，不需要再截断；
        // 普通模式保留 5000 行上限，避免超大文件整篇扫描拖慢执行/高亮。
        const lineCount = option?.tolerant ? document.lineCount : Math.min(document.lineCount, 5000);
        for (var i = 0; i < lineCount; i++) {
            var text = document.lineAt(i).text
            lastLineLength = text.length;
            for (let j = 0; j < text.length; j++) {
                const ch = text.charAt(j);
                // comment check
                if (ch == '*' && text.charAt(j + 1) == '/') {
                    j++;
                    context.inComment = false;
                    continue;
                }
                if (context.inComment) continue;
                // string check
                if (ch == `'`) {
                    context.inSingleQuoteString = !context.inSingleQuoteString;
                } else if (ch == `"`) {
                    context.inDoubleQuoteString = !context.inDoubleQuoteString;
                }
                const inString = context.inSingleQuoteString || context.inDoubleQuoteString;
                if (!inString) {
                    // line comment
                    if (ch == '-' && text.charAt(j + 1) == '-') break;
                    // block comment start
                    if (ch == '/' && text.charAt(j + 1) == '*') {
                        j++;
                        context.inComment = true;
                        continue;
                    }
                    // check sql end 
                    if (ch == delimter) {
                        if (!context.start) continue;
                        tokenContext.endToken(i, j)
                        const range = new vscode.Range(context.start, new vscode.Position(i, j + 1));
                        const block: SQLBlock = { sql: context.sql, range, tokens: tokenContext.tokens, scopes: tokenContext.scopes };
                        if (current && (range.contains(current) || range.start.line > current.line)) {
                            return [block];
                        }
                        blocks.push(block);
                        context.sql = ''
                        context.start = null
                        tokenContext = new TokenContext()
                        continue;
                    }
                }

                tokenContext.appendChar(i, j, ch)

                if (!context.start) {
                    if (ch.match(/\s/)) continue;
                    context.start = new vscode.Position(i, j)
                }
                context.sql = context.sql + ch;
            }
            if (context.sql) {
                context.sql = context.sql + '\n';
                tokenContext.appendChar(i, text.length, '\n')
            }

            // 容错模式（补全用）：未闭合的引号/块注释在换行处强制复位。
            // SQL 字符串是可以跨行的，所以严格模式下不做这个复位；
            // 但补全时一处手误（少个引号）不该让后面整篇都解析不出来。
            if (option?.tolerant) {
                context.inSingleQuoteString = false;
                context.inDoubleQuoteString = false;
                context.inComment = false;
            }

            // 语句没有以分隔符结尾时，如果当前已经是一条完整语句、
            // 而下一行看起来是独立内容（裸数字/ID、或新的语句开头），
            // 就在这里截断，避免把下一行误吞进当前 SQL。
            // 典型场景：上一行是 select * from t，下一行是一个孤立的 ID。
            //
            // 截断判断本身与光标无关，无论有没有传 cursor 都应该切块；
            // 只有「命中光标就提前返回」这一步才需要 cursor。
            // 早期版本把整个判断都绑在 cursor 上，导致补全路径（不传 cursor）
            // 会把前面几百行无关语句累积进同一个块。
            if (context.start && this.isSqlComplete(context.sql)) {
                const nextText = (i + 1 < lineCount) ? document.lineAt(i + 1).text.trim() : '';
                if (this.looksLikeNewStatement(nextText)) {
                    const range = new vscode.Range(context.start, new vscode.Position(i, lastLineLength));
                    const block: SQLBlock = {
                        sql: context.sql,
                        range,
                        tokens: tokenContext.tokens,
                        scopes: tokenContext.scopes
                    };
                    // 光标落在本块内可以直接返回；否则先存下，继续扫描后续行，
                    // 保证光标所在的那一块也能被解析出来。
                    if (current && range.contains(current)) { return [block]; }
                    blocks.push(block);
                    context.sql = '';
                    context.start = null;
                    tokenContext = new TokenContext();
                }
            }

        }

        // if end withtout delimter
        if (context.start) {
            const range = new vscode.Range(context.start, new vscode.Position(lineCount, lastLineLength));
            const block: SQLBlock = { sql: context.sql, range, tokens: tokenContext.tokens, scopes: tokenContext.scopes };
            if (current) return [block];
            blocks.push(block)
        }

        return blocks

    }
    /**
     * 判断当前累积的 SQL 是否已经是一条语法完整的语句。
     * 只做最基本的判断：以 select/insert/update/delete/show 开头，
     * 且有实质内容（避免 "select" 单独一个词就判定完成）。
     */
    private static isSqlComplete(sql: string): boolean {
        const text = (sql || '').trim();
        if (!text) { return false; }
        if (!/^(select|insert|update|delete|show|desc|describe|explain|with|call)\b/i.test(text)) {
            return false;
        }
        // 去掉关键字本身，至少还要有表名等实质内容
        const body = text.replace(/^(select|insert|update|delete|show|desc|describe|explain|with|call)\b/i, '').trim();
        return body.length > 0;
    }

    /**
     * 判断某一行是否是"新内容的开头"。
     * 命中以下情况时，说明它不该被拼接进上一条语句：
     * - 纯数字 / 数字加引号（孤立 ID）
     * - 新的 SQL 关键字开头
     * - 纯逗号分隔的值（如 1,2,3）
     */
    private static looksLikeNewStatement(line: string): boolean {
        const t = (line || '').trim();
        if (!t) { return false; }
        // 孤立的数字或数字串（常见于误粘贴的 ID）
        if (/^[\d'"]+[,\d'"]*$/.test(t)) { return true; }
        // 新语句关键字
        if (/^(select|insert|update|delete|show|desc|describe|explain|with|call|create|drop|alter|truncate)\b/i.test(t)) {
            return true;
        }
        return false;
    }

    private static getDelimter() {

        const node = ConnectionManager.tryGetConnection()
        if (node) {
            return DelimiterHolder.get(node.getConnectId()).replace(/\\/g, '')
        }
        return ";";
    }

}