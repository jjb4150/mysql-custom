/**
 * SQL 语句的轻量分析器，为补全提供「别名 → 表 → 列」的上下文。
 *
 * 不用完整 AST：数据库客户端场景里，用户经常在写到一半的语句上触发补全，
 * 语法往往不完整。这里只做满足补全所需的最小解析，容忍残缺语法。
 */

export interface TableRef {
    /** 原始写法里的库名，可能为空 */
    catalog?: string;
    /** 表名（已去掉反引号/引号） */
    table: string;
    /** 别名，没有别名时为 null */
    alias?: string;
    /** 该表在语句中的出现位置（用于判断作用域） */
    index: number;
    /**
     * 这张「表」不是数据库里真实存在的表，而是：
     * - CTE（WITH x AS ...）
     * - 子查询/派生表（FROM (...) t1）
     *
     * 这类引用不能拿去查 information_schema，它的列要从内部 SELECT 推导。
     */
    virtual?: boolean;
    /** 虚拟表的列名（从内部 SELECT 的输出列表推导，可能是空的） */
    virtualColumns?: string[];
}

/** 标识符允许的字符：字母数字下划线、中文、$、以及被引号包裹的情况 */
const IDENTIFIER = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|[\w\u4e00-\u9fa5$]+)`;
const QUALIFIED = String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})*`;

/** 别名不能是这些关键字 */
const NON_ALIAS = new Set([
    'where', 'on', 'join', 'inner', 'left', 'right', 'outer', 'full', 'cross',
    'group', 'order', 'having', 'limit', 'offset', 'union', 'set', 'values',
    'using', 'and', 'or', 'as', 'for', 'lock', 'into', 'from', 'select',
    'straight_join', 'natural', 'window', 'partition', 'by',
]);

const TABLE_INTRODUCERS = 'from|join|update|into';

/** 去掉标识符两侧的引号或反引号 */
export function stripQuote(identifier: string): string {
    if (!identifier) { return identifier; }
    return identifier.trim()
        .replace(/^`([^`]*)`$/, '$1')
        .replace(/^"([^"]*)"$/, '$1')
        .replace(/^\[([^\]]*)\]$/, '$1');
}

/** 按点拆分限定名，例如 `db`.`tbl` → ['db', 'tbl'] */
function splitQualified(name: string): string[] {
    const parts: string[] = [];
    const re = new RegExp(IDENTIFIER, 'g');
    let m: RegExpExecArray;
    while ((m = re.exec(name)) !== null) {
        parts.push(stripQuote(m[0]));
    }
    return parts.length > 0 ? parts : [stripQuote(name)];
}

/**
 * 从语句里抽取所有被引用的表，含别名。
 *
 * 覆盖：FROM t、FROM t a、FROM t AS a、JOIN t a、UPDATE t a、
 *       INSERT INTO t、FROM db.t、DELETE FROM t。
 * 括号里的子查询会被跳过，但其内部的表仍会被后面的扫描抓到。
 */
export function extractTableRefs(sql: string): TableRef[] {
    const refs: TableRef[] = [];
    if (!sql) { return refs; }

    const ctes = extractCteDefinitions(sql);
    const derived = extractDerivedTables(sql);

    // 注意：主正则只能匹配 `from 名字` 这种写法，
    // `from (...) t1` 里的 t1 在主句法上不是标识符，正则抓不到。
    // 所以 CTE 和派生表必须先单独抽出来，作为「已存在的引用」放进去。
    for (const v of [...ctes, ...derived]) {
        if (refs.some(r => r.alias && r.alias.toLowerCase() === v.alias.toLowerCase())) { continue; }
        refs.push(v);
    }

    const re = new RegExp(
        String.raw`\b(${TABLE_INTRODUCERS})\b\s+(${QUALIFIED})(?:\s+(?:as\s+)?(${IDENTIFIER}))?`,
        'gi'
    );

    let m: RegExpExecArray;
    while ((m = re.exec(sql)) !== null) {
        const rawName = m[2];
        const candidateAlias = m[3];

        const parts = splitQualified(rawName);
        if (parts.length === 0) { continue; }
        const table = parts[parts.length - 1];
        const catalog = parts.length > 1 ? parts[parts.length - 2] : undefined;

        // 表名本身可能是子查询占位或纯数字，跳过
        if (!table || /^\d+$/.test(table)) { continue; }

        let alias: string | undefined;
        if (candidateAlias) {
            const clean = stripQuote(candidateAlias);
            if (!NON_ALIAS.has(clean.toLowerCase())) {
                alias = clean;
            }
        }
        // 没有别名时，用表名本身作为可引用的限定符
        if (!alias) { alias = table; }

        // 引用 CTE 名（FROM cte_name）时，标记成虚拟表，避免去库里查
        const virtualRef = [...ctes, ...derived].find(v =>
            v.table.toLowerCase() === table.toLowerCase() ||
            v.alias.toLowerCase() === table.toLowerCase());

        // 去重只看「可引用的限定符」（alias）是否已被占用。
        // 不能只比 table：CTE 名作为定义已经放进 refs 了，
        // 但 `FROM current_approvers ca` 这个引用用的是别名 ca，
        // 两者是不同的限定符，都要能补充。
        const existing = refs.find(r => r.alias && r.alias.toLowerCase() === alias.toLowerCase());
        if (existing) { continue; }

        if (virtualRef) {
            refs.push({
                table,
                alias,
                index: m.index,
                virtual: true,
                virtualColumns: virtualRef.virtualColumns,
            });
            continue;
        }

        refs.push({ catalog, table, alias, index: m.index });
    }

    return refs;
}

/**
 * 抽取 CTE 定义：WITH [RECURSIVE] name [(col1, col2)] AS ( ... ), name2 AS ( ... )
 *
 * 递归 CTE 的列由显式列表 name(col1, col2) 给出；
 * 非递归 CTE 从内部第一个 SELECT 的输出列表推导。
 */
export function extractCteDefinitions(sql: string): TableRef[] {
    const out: TableRef[] = [];
    const text = stripStrings(sql);

    const withMatch = /\bWITH\s+(?:RECURSIVE\s+)?/i.exec(text);
    if (!withMatch) { return out; }

    let pos = withMatch.index + withMatch[0].length;
    while (pos < text.length) {
        // 读 CTE 名
        const nameMatch = /^\s*(`[^`]+`|"[^"]+"|[\w\u4e00-\u9fa5$]+)/.exec(text.slice(pos));
        if (!nameMatch) { break; }
        const name = stripQuote(nameMatch[1]);
        pos += nameMatch[0].length;

        // 可选的列名列表 (col1, col2)
        let explicitColumns: string[] | null = null;
        const colListMatch = /^\s*\(([^)]*)\)/.exec(text.slice(pos));
        if (colListMatch) {
            const inner = colListMatch[1].trim();
            // 只有当括号里不是 SELECT 语句时，才认为是列名列表
            if (inner && !/\bselect\b/i.test(inner)) {
                explicitColumns = inner.split(',')
                    .map(c => stripQuote(c.trim()))
                    .filter(Boolean);
                pos += colListMatch[0].length;
            }
        }

        // AS (
        const asMatch = /^\s*AS\s*\(/i.exec(text.slice(pos));
        if (!asMatch) { break; }
        pos += asMatch[0].length;

        // 找到匹配的右括号
        const bodyStart = pos;
        let depth = 1;
        while (pos < text.length && depth > 0) {
            const ch = text[pos];
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
            pos++;
        }
        const body = sql.substring(bodyStart, pos - 1);

        const columns = explicitColumns && explicitColumns.length > 0
            ? explicitColumns
            : extractSelectOutputColumns(body);

        out.push({ table: name, alias: name, index: nameMatch.index, virtual: true, virtualColumns: columns });

        // 后面可能是逗号继续下一个 CTE，也可能是主查询的 SELECT
        const rest = text.slice(pos);
        const next = /^\s*,\s*/.exec(rest);
        if (!next) { break; }
        pos += next[0].length;
    }

    return out;
}

/**
 * 抽取子查询/派生表：FROM ( ... ) [AS] t1
 *
 * 只看 FROM/JOIN 后面紧跟括号的情况，括号内必须是 SELECT。
 * 返回的列从内部 SELECT 的输出列表推导。
 */
export function extractDerivedTables(sql: string): TableRef[] {
    const out: TableRef[] = [];
    const text = stripStrings(sql);

    const re = /\b(?:from|join)\s*\(/gi;
    let m: RegExpExecArray;
    while ((m = re.exec(text)) !== null) {
        const bodyStart = m.index + m[0].length;
        let pos = bodyStart;
        let depth = 1;
        while (pos < text.length && depth > 0) {
            const ch = text[pos];
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
            pos++;
        }
        const body = sql.substring(bodyStart, pos - 1);
        // 括号内不是 SELECT（例如 IN (...) 或函数调用），跳过
        if (!/\bselect\b/i.test(body)) { continue; }

        // 括号之后是可选的 AS 和别名
        const after = text.slice(pos);
        const aliasMatch = /^\s*(?:AS\s+)?(`[^`]+`|"[^"]+"|[\w\u4e00-\u9fa5$]+)/i.exec(after);
        if (!aliasMatch) { continue; }
        const alias = stripQuote(aliasMatch[1]);
        if (NON_ALIAS.has(alias.toLowerCase())) { continue; }

        out.push({
            table: alias,
            alias,
            index: m.index,
            virtual: true,
            virtualColumns: extractSelectOutputColumns(body),
        });

        // 注意：这里不能把 lastIndex 跳到括号外。
        // 嵌套写法 FROM ( ... FROM ( ... ) t1 ... ) x 里，
        // 跳过外层就会漏掉内层的 t1。让正则自己继续往后扫即可。
    }

    return out;
}

/**
 * 从一段 SELECT 语句推导输出列名。
 *
 * 处理：
 * - `col`            → col
 * - `t.col`          → col
 * - `expr AS alias`  → alias
 * - `expr alias`     → alias
 * - `*`              → 跳过（无法推导，交给调用方）
 */
export function extractSelectOutputColumns(sql: string): string[] {
    const text = stripStrings(sql);
    const selectMatch = /\bSELECT\s+(?:DISTINCT\s+|ALL\s+)?/i.exec(text);
    if (!selectMatch) { return []; }

    // 从 SELECT 后到同层的 FROM
    const start = selectMatch.index + selectMatch[0].length;
    let depth = 0;
    let end = text.length;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') { depth++; }
        else if (ch === ')') { depth--; }
        else if (depth === 0 && /\bfrom\b/i.test(text.slice(i, i + 5)) &&
            (i === 0 || /\s/.test(text[i - 1]))) {
            end = i;
            break;
        }
    }

    const list = sql.substring(start, end);
    const columns: string[] = [];
    let depth2 = 0;
    let current = '';
    for (const ch of list) {
        if (ch === '(') { depth2++; }
        if (ch === ')') { depth2--; }
        if (ch === ',' && depth2 === 0) {
            columns.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) { columns.push(current); }

    const result: string[] = [];
    for (const raw of columns) {
        const item = raw.trim();
        if (!item || item === '*') { continue; }
        if (/^\w+\.\*$/.test(item)) { continue; }
        if (item.includes('*')) { continue; }

        // 优先取 AS 后面的别名
        const asMatch = /\bAS\s+(`[^`]+`|"[^"]+"|[\w\u4e00-\u9fa5$]+)\s*$/i.exec(item);
        if (asMatch) {
            result.push(stripQuote(asMatch[1]));
            continue;
        }
        // 没有 AS：如果整体是一个限定名（t.col 或 col），取最后一段
        const qualified = /^(`[^`]+`|"[^"]+"|[\w\u4e00-\u9fa5$]+)(?:\s*\.\s*(`[^`]+`|"[^"]+"|[\w\u4e00-\u9fa5$]+))?$/.exec(item);
        if (qualified) {
            result.push(stripQuote(qualified[2] || qualified[1]));
            continue;
        }
        // 表达式结尾是一个裸标识符，当作隐式别名（如 SUM(x) total）
        const implicit = /[\w\u4e00-\u9fa5$)\s]\s+(`[^`]+`|"[^"]+"|[\w\u4e00-\u9fa5$]+)\s*$/.exec(item);
        if (implicit) {
            const name = stripQuote(implicit[1]);
            if (!NON_ALIAS.has(name.toLowerCase())) {
                result.push(name);
            }
        }
    }

    return result;
}

/**
 * 找出光标正在引用的限定符。
 * 输入形如 "a." 或 "db.t." 时返回点号前面的最后一段（a / t），
 * 没有点号返回 null。
 */
export function getQualifierBeforeCursor(lineTextBeforeCursor: string): string | null {
    const m = lineTextBeforeCursor.match(new RegExp(String.raw`(${IDENTIFIER})\s*\.\s*(${IDENTIFIER})?\s*$`));
    if (!m) { return null; }
    return stripQuote(m[1]);
}

/**
 * 判断光标处是否正处在一个「需要列名」的位置：
 * SELECT 列表、WHERE、ON、GROUP BY、ORDER BY、HAVING、SET、SELECT 的第一个位置。
 */
export function isInColumnContext(sqlBeforeCursor: string): boolean {
    const text = stripStrings(sqlBeforeCursor);
    const lowered = text.toLowerCase();

    // 这些关键字之后，下一个词应该是列
    const lastKeyword = [...lowered.matchAll(/\b(select|where|on|and|or|by|having|set|using|when|then|else)\b/g)].pop();
    if (!lastKeyword) { return false; }

    const tail = lowered.slice(lastKeyword.index + lastKeyword[0].length);
    // 关键字后面如果已经出现了 from/join 等结构性关键字，说明列的上下文已经结束
    if (/\b(from|join|where|group|order|having|limit|set|values)\b/.test(tail)) { return false; }
    // 结尾是逗号或纯空白，说明还在同一个列表里
    return true;
}

/** 把字符串字面量替换为等长空白，避免其中的关键字干扰判断 */
export function stripStrings(sql: string): string {
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

/**
 * 判断光标是否位于顶层（不在字符串、不在注释里），
 * 用于决定要不要给出补全。
 */
export function isCodePosition(sqlBeforeCursor: string): boolean {
    // 行注释：最后一个换行之后若出现 -- 且后面没有内容闭合，则认为在注释里
    const lastLine = sqlBeforeCursor.split('\n').pop() || '';
    const lineComment = lastLine.indexOf('--');
    if (lineComment >= 0 && !/'.*--/.test(lastLine.slice(0, lineComment))) {
        // -- 之后的内容都算注释
        const afterComment = lastLine.slice(lineComment + 2);
        if (!afterComment.includes('\n')) { return false; }
    }
    // 块注释未闭合
    const lastOpen = sqlBeforeCursor.lastIndexOf('/*');
    const lastClose = sqlBeforeCursor.lastIndexOf('*/');
    if (lastOpen > lastClose) { return false; }
    return true;
}

/**
 * 模糊匹配：判断 query 是否是 target 的一个「子序列」。
 *
 * 支持三种用户直觉：
 * - 前缀：pro → product
 * - 子串：ai  → g_product_ai
 * - 分词前缀：pa → product_ai
 * - 驼峰/下划线首字母：gpa → g_product_ai
 *
 * 返回一个分值，越小越相关；不匹配返回 -1。
 */
export function fuzzyScore(query: string, target: string): number {
    if (!query) { return 0; }
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    // 完全相等最优
    if (t === q) { return 0; }
    // 前缀
    if (t.startsWith(q)) { return 1; }
    // 子串，越靠前越好
    const idx = t.indexOf(q);
    if (idx >= 0) { return 2 + idx / Math.max(t.length, 1); }

    // 分词边界前缀：g_product_ai 的 pa → product / ai 段
    const segments = t.split(/[_\-\s]+/).filter(Boolean);
    const segHit = segments.findIndex(seg => seg.startsWith(q));
    if (segHit >= 0) { return 4 + segHit; }

    // 子序列匹配：允许用户跳过下划线/连字符，
    // 例如 gpa → g_product_ai，a_i 也能命中 g_product_ai。
    const qChars = q.replace(/[_\-\s]/g, '');
    const tChars = t.replace(/[_\-\s]/g, '');
    let qi = 0;
    for (let i = 0; i < tChars.length && qi < qChars.length; i++) {
        if (tChars[i] === qChars[qi]) { qi++; }
    }
    if (qi === qChars.length && qChars.length > 0) { return 10; }

    return -1;
}

/**
 * 按模糊分值过滤并排序候选。空查询时保持原顺序。
 */
export function rankByFuzzy<T>(items: T[], query: string, labelOf: (item: T) => string): T[] {
    if (!query) { return items; }
    const scored: Array<{ item: T; score: number }> = [];
    for (const item of items) {
        const score = fuzzyScore(query, labelOf(item));
        if (score >= 0) { scored.push({ item, score }); }
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map(s => s.item);
}