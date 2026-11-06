import * as vscode from "vscode";
import { ComplectionContext } from "../complectionContext";
import { MetadataProvider } from "../metadataProvider";
import { extractTableRefs, stripStrings } from "../sqlAnalyzer";
import { sortTextFor, sqlBeforeCursor, SortGroup } from "./completionUtil";
import { BaseChain } from "./baseChain";

/**
 * DML 相关补全：函数名、INSERT 的列清单。
 *
 * 历史上这里还负责「FROM 后的表名」，但那部分逻辑与 TableChain 重复，
 * 且依赖树节点缓存（未展开时为空）。现在表名统一由 TableChain 提供，
 * 这里只保留表名之外的、语句结构决定的补全。
 */
export class DMLChain extends BaseChain {

    /** 常用函数，按类别分组便于阅读 */
    private static readonly FUNCTIONS = [
        // 字符串
        'CONCAT', 'CONCAT_WS', 'SUBSTRING', 'SUBSTR', 'SUBSTRING_INDEX', 'LEFT', 'RIGHT',
        'LENGTH', 'CHAR_LENGTH', 'UPPER', 'LOWER', 'TRIM', 'LTRIM', 'RTRIM', 'REPLACE',
        'LOCATE', 'INSTR', 'LPAD', 'RPAD', 'REPEAT', 'REVERSE', 'FORMAT', 'FIND_IN_SET',
        // 数值
        'ABS', 'CEIL', 'CEILING', 'FLOOR', 'ROUND', 'TRUNCATE', 'MOD', 'POW', 'POWER',
        'SQRT', 'RAND', 'SIGN', 'GREATEST', 'LEAST',
        // 日期（MySQL）
        'NOW', 'CURDATE', 'CURTIME', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
        'DATE', 'TIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
        'DATE_ADD', 'DATE_SUB', 'SUBDATE', 'ADDDATE', 'DATEDIFF', 'DATE_FORMAT',
        'STR_TO_DATE', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME', 'LAST_DAY', 'TIMESTAMPDIFF',
        'TO_DAYS', 'FROM_DAYS', 'DAYOFWEEK', 'DAYOFMONTH', 'DAYOFYEAR', 'WEEK', 'QUARTER',
        // 日期（ClickHouse / 数仓常用）
        'DATE_TRUNC', 'TO_DATE', 'TO_DATETIME', 'ADDYEARS', 'ADDMONTHS', 'ADDDAYS',
        'TODATE', 'TODAY', 'DATE_PART', 'FORMATDATETIME', 'TOCHAR',
        // 聚合
        'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'GROUP_CONCAT',
        // 条件与空值
        'IF', 'IFNULL', 'NULLIF', 'COALESCE', 'ISNULL', 'CAST', 'CONVERT',
        // JSON
        'JSON_EXTRACT', 'JSON_UNQUOTE', 'JSON_OBJECT', 'JSON_ARRAY', 'JSON_CONTAINS',
        'JSON_LENGTH', 'JSON_VALID', 'JSON_SET', 'JSON_INSERT',
        // 窗口函数
        'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
        'NTILE', 'CUME_DIST', 'PERCENT_RANK',
        // 其他
        'MD5', 'SHA1', 'SHA2', 'UUID', 'LAST_INSERT_ID', 'DATABASE', 'VERSION', 'USER',
        'CURRENT_USER', 'FOUND_ROWS',
    ];

    public async getComplection(context: ComplectionContext) {

        const sql = stripStrings(context.sqlBlock?.sql || '');
        const before = stripStrings(sqlBeforeCursor(context.sqlBlock, context.position));
        const firstToken = (context.tokens[0]?.content || '').toLowerCase();

        if (!firstToken) { return null; }
        if (!['select', 'insert', 'update', 'delete', 'call'].includes(firstToken)) {
            return null;
        }

        // INSERT INTO t (  → 给该表的列
        if (firstToken === 'insert') {
            const insertColumns = await this.insertColumnCompletion(context, sql, before);
            if (insertColumns && insertColumns.length > 0) {
                this.requestStop();
                return insertColumns;
            }
            // INSERT INTO t (...) VALUES (  → 值占位，不需要候选
            if (/\bvalues\s*\(\s*$/i.test(before)) {
                this.requestStop();
                return [];
            }
            return null;
        }

        // 函数名只在「值/表达式」的位置给，避免污染表名、列名位置
        if (this.isValuePosition(before)) {
            return this.functionItems();
        }

        return null;
    }

    /**
     * 判断光标处是否处在可以用函数的位置。
     *
     * 这里必须严格：如果判得太松（例如把 `where ` 也算值位置），
     * 就会在需要列名的地方返回一堆函数，把列补全挤掉。
     * 只有在「明确开始写一个表达式」的位置才给函数：
     * SELECT 列表开头、WHERE 之后、比较运算符之后、括号内、逗号后。
     */
    private isValuePosition(before: string): boolean {
        const trimmed = before.replace(/\s+$/, '');
        if (!trimmed) { return false; }

        // 表名位置一律不给函数
        if (/\b(from|join|update|into|table|desc|describe|truncate)\s+[`"\[\]\w\u4e00-\u9fa5$]*$/i.test(trimmed)) { return false; }
        // 列限定符位置（a.）
        if (/[`"\w\u4e00-\u9fa5$]\s*\.$/.test(trimmed)) { return false; }

        // 明确开始表达式的位置。这些判断必须在「正在输入单词」之前，
        // 否则 `select ` 里的 select 会被当成正在输入的列名。
        if (/\bselect\s+$/i.test(before)) { return true; }
        if (/\b(where|and|or|on|having|when|then|else|case)\s+$/i.test(trimmed)) { return true; }
        if (/[=<>!]\s*$/.test(trimmed)) { return true; }
        if (/\(\s*$/.test(trimmed)) { return true; }
        if (/,\s*$/.test(trimmed) && !/\b(from|join)\b[^,]*$/i.test(trimmed)) { return true; }

        // 正在输入一个单词（可能是列名），此时让列补全优先
        if (/[\w\u4e00-\u9fa5$]+$/.test(trimmed)) { return false; }

        return false;
    }

    /**
     * INSERT INTO tbl ( 位置给出该表的列清单。
     * 只处理光标在 INSERT 的列括号内、且括号前是表名的情况。
     */
    private async insertColumnCompletion(context: ComplectionContext, sql: string, before: string): Promise<vscode.CompletionItem[]> {
        // 光标前最近的括号必须是 INSERT 的列清单括号
        if (!/\(\s*[`"\w\u4e00-\u9fa5$,.\s]*$/i.test(before)) { return []; }
        // 括号内不能已经出现 VALUES，否则说明在值列表里
        const lastOpenParen = before.lastIndexOf('(');
        if (lastOpenParen < 0) { return []; }
        const afterParen = before.substring(lastOpenParen);
        if (/\bvalues\b/i.test(afterParen)) { return []; }

        const refs = extractTableRefs(sql);
        if (refs.length === 0) { return []; }

        const node = MetadataProvider.activeConnection();
        if (!node) { return []; }

        // INSERT 只涉及第一张表
        const ref = refs[0];
        const columns = await MetadataProvider.getColumns(node, ref.table, ref.catalog || node.schema);
        return columns.map(c => {
            const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
            item.sortText = sortTextFor(SortGroup.COLUMN, c.name);
            item.detail = c.type || '';
            return item;
        });
    }

    private functionItems(): vscode.CompletionItem[] {
        return DMLChain.FUNCTIONS.map(name => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
            item.insertText = `${name}()`;
            item.filterText = name;
            item.sortText = sortTextFor(SortGroup.FUNCTION, name);
            item.detail = 'function';
            return item;
        });
    }
}