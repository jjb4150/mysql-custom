/**
 * 把一段脚本切成独立的语句。
 *
 * 为什么必须切：mysql2 开了 multipleStatements 后，`A;B` 返回的是
 * 「二维结果集」（[rowsA, rowsB] / [fieldsA, fieldsB]），
 * 现有结果页只认单结果集，会把整批数据判成「非查询」直接丢弃，
 * 表现就是「只显示一句 EXECUTE SUCCESS、没有任何结果 tab」。
 * 切成单条逐句发送后，每条结果都能落到自己的 tab，错误也能定位到行。
 *
 * 切分依据（按优先级）：
 * 1. DELIMITER 指令 —— 客户端指令，决定真实的语句边界。
 *    存储过程体内有大量分号，只有按 DELIMITER 切才不会把 BEGIN...END 拆碎。
 * 2. 分号（默认分隔符）—— 字符串 / 反引号 / 三种注释内的分号不算。
 * 3. 行尾（兜底）—— 两句之间**漏写分号**时，在「一行结束 + 下一行是新 SELECT 开头」处断开。
 *    这类脚本本来是错的（MySQL 会直接报语法错），但用户经常这么写，
 *    按语句拆开执行比整段报错更符合直觉。
 */
export interface SplitStatement {
    /** 去掉首尾空白后的语句文本（不含 DELIMITER 指令行） */
    sql: string;
    /** 语句首个非空白字符在原文中的行号（0 基） */
    startLine: number;
    /** 语句结束时的行号（0 基），用于在编辑器里整段标注错误 */
    endLine: number;
}

export class SqlSplitter {

    /** 能作为一条语句开头、且允许「下一行直接接新语句」的类型 */
    private static readonly STATEMENT_HEAD = /^(select|with)\b/i;

    /** 行首的 DELIMITER 指令，例如 `DELIMITER $$`、`delimiter //` */
    private static readonly DELIMITER_DIRECTIVE = /^[ \t]*delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i;

    public static split(sql: string): SplitStatement[] {
        const list: SplitStatement[] = [];
        if (!sql) { return list; }

        /** 当前生效的语句分隔符，可被 DELIMITER 指令改写 */
        let delimiter = ';';
        let line = 0;
        /** 当前语句起始字符下标，-1 表示还没吃到有效内容 */
        let stmtStart = -1;
        let stmtStartLine = 0;
        /** 括号深度，行尾断句时要求为 0，避免拆开子查询 */
        let depth = 0;
        /** 当前语句内是否出现过 FROM（用于判断"像一条写完的查询"） */
        let seenFrom = false;

        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inBacktick = false;
        let inLineComment = false;
        let inBlockComment = false;

        const resetQuotes = () => {
            inSingleQuote = false;
            inDoubleQuote = false;
            inBacktick = false;
            inLineComment = false;
            inBlockComment = false;
        };

        const flush = (end: number, endLine: number) => {
            if (stmtStart < 0) { return; }
            const text = sql.slice(stmtStart, end).trim();
            if (text) {
                list.push({ sql: text, startLine: stmtStartLine, endLine });
            }
            stmtStart = -1;
            depth = 0;
            seenFrom = false;
            resetQuotes();
        };

        /** 只在需要时记录语句起点 */
        const markStart = (index: number) => {
            if (stmtStart < 0) {
                stmtStart = index;
                stmtStartLine = line;
            }
        };

        const inNormalState = () => !inSingleQuote && !inDoubleQuote && !inBacktick
            && !inLineComment && !inBlockComment;

        let atLineStart = true;
        let i = 0;

        while (i < sql.length) {
            // DELIMITER 是行首指令，只在正常状态下识别。
            // 识别到就换个分隔符继续，指令行本身不进入任何语句。
            if (atLineStart && inNormalState()) {
                const directive = sql.slice(i).match(this.DELIMITER_DIRECTIVE);
                if (directive) {
                    delimiter = directive[1];
                    i += directive[0].length;
                    line++;
                    atLineStart = true;
                    continue;
                }
            }

            const ch = sql.charAt(i);
            const next = sql.charAt(i + 1);

            if (inLineComment) {
                if (ch === '\n') { line++; inLineComment = false; atLineStart = true; i++; continue; }
                i++;
                continue;
            }

            if (inBlockComment) {
                if (ch === '\n') { line++; atLineStart = true; }
                else if (ch === '*' && next === '/') { inBlockComment = false; i += 2; atLineStart = false; continue; }
                i++;
                continue;
            }

            if (inSingleQuote) {
                if (ch === '\n') { line++; atLineStart = true; i++; continue; }
                // MySQL 字符串里反斜杠是转义符，\' 不算结束
                if (ch === '\\') { i += 2; continue; }
                if (ch === "'") {
                    if (next === "'") { i += 2; continue; }  // '' 是转义的单引号
                    inSingleQuote = false;
                }
                i++;
                continue;
            }
            if (inDoubleQuote) {
                if (ch === '\n') { line++; atLineStart = true; i++; continue; }
                if (ch === '\\') { i += 2; continue; }
                if (ch === '"') {
                    if (next === '"') { i += 2; continue; }
                    inDoubleQuote = false;
                }
                i++;
                continue;
            }
            if (inBacktick) {
                if (ch === '\n') { line++; atLineStart = true; i++; continue; }
                // 反引号标识符里只有 `` 一种转义，没有反斜杠转义
                if (ch === '`') {
                    if (next === '`') { i += 2; continue; }
                    inBacktick = false;
                }
                i++;
                continue;
            }

            // ---- 以下是「不在字符串/注释里」的顶层字符 ----

            // 当前分隔符命中（支持 $$ // 这类多字符分隔符）
            if (sql.startsWith(delimiter, i)) {
                flush(i, line);
                i += delimiter.length;
                atLineStart = false;
                continue;
            }

            if (ch === '\n') {
                // 兜底：两句之间漏写分号时在这里断开
                if (this.shouldBreakAtLineEnd(sql, i, stmtStart, depth, seenFrom)) {
                    flush(i, line);
                }
                line++;
                atLineStart = true;
                i++;
                continue;
            }

            atLineStart = false;

            // MySQL 的 -- 注释要求后面跟空白或直接到行尾，否则是减号
            if (ch === '-') {
                if (next === '-') {
                    const after = sql.charAt(i + 2);
                    if (after === '' || after === '\n' || after === '\r' || after === ' ' || after === '\t') {
                        inLineComment = true;
                        i += 2;
                        continue;
                    }
                }
                markStart(i);
                i++;
                continue;
            }
            if (ch === '#') { inLineComment = true; i++; continue; }
            if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }

            if (ch === "'") { markStart(i); inSingleQuote = true; i++; continue; }
            if (ch === '"') { markStart(i); inDoubleQuote = true; i++; continue; }
            if (ch === '`') { markStart(i); inBacktick = true; i++; continue; }

            if (ch === '(') { depth++; markStart(i); i++; continue; }
            if (ch === ')') { depth = Math.max(0, depth - 1); markStart(i); i++; continue; }

            // 记录是否出现过 FROM —— 有 FROM 才更像「一条真正写完了的查询」
            if (stmtStart >= 0 && !seenFrom && (ch === 'f' || ch === 'F')
                && sql.substr(i, 4).toLowerCase() === 'from'
                && !/[\w$]/.test(sql.charAt(i - 1))) {
                seenFrom = true;
            }

            if (stmtStart < 0 && !/\s/.test(ch)) {
                markStart(i);
            }
            i++;
        }

        flush(sql.length, line);
        return list;
    }

    /**
     * 判断是否该在换行处断开。规则刻意保守，宁可少拆也不要拆错：
     *
     * 1. 括号必须已闭合（depth == 0）—— 否则会拆开子查询 / 函数参数
     * 2. 当前语句必须以 SELECT / WITH 开头 —— INSERT...SELECT、UPDATE...WHERE 这类
     *    跨行续写不能被误拆
     * 3. 当前语句必须已经出现过 FROM —— 「SELECT 1」这种常量查询和
     *    「SELECT\n  id」这种折行写法都不该在这里断
     * 4. 下一行的首个有效字符必须是 SELECT / WITH —— 与第 2 条对称
     *
     * 满足这四条时，几乎只可能是「两条 SELECT 之间忘了写分号」。
     */
    private static shouldBreakAtLineEnd(sql: string, nlIndex: number, stmtStart: number,
        depth: number, seenFrom: boolean): boolean {
        if (stmtStart < 0) { return false; }
        if (depth !== 0) { return false; }
        if (!seenFrom) { return false; }

        const current = sql.slice(stmtStart, nlIndex);
        if (!this.STATEMENT_HEAD.test(current.trim())) { return false; }

        const nextHead = this.peekNextStatement(sql, nlIndex + 1);
        if (nextHead == null) { return false; }
        return this.STATEMENT_HEAD.test(nextHead);
    }

    /**
     * 看下一行的首个有效内容是否是一条语句的开头。
     * 返回那一行的开头文本（用于匹配），空行/注释行返回 null。
     */
    private static peekNextStatement(sql: string, from: number): string {
        let i = from;
        while (i < sql.length) {
            while (i < sql.length && (sql.charAt(i) === ' ' || sql.charAt(i) === '\t' || sql.charAt(i) === '\r')) { i++; }
            if (i >= sql.length) { return null; }
            const ch = sql.charAt(i);
            if (ch === '\n') { return null; }              // 空行，不拆
            if (ch === '-' && sql.charAt(i + 1) === '-') { return null; }  // 注释行，不拆
            if (ch === '#') { return null; }
            return sql.substr(i, 12);
        }
        return null;
    }
}