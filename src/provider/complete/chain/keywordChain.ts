import * as vscode from "vscode";
import { ComplectionChain, ComplectionContext } from "../complectionContext";
import { sortTextFor, sqlBeforeCursor, SortGroup } from "./completionUtil";
import { stripStrings } from "../sqlAnalyzer";

/**
 * 关键字补全。
 *
 * 相比原来的一百来个词，这里补齐了 MySQL 8 的常用关键字，并按上下文排序：
 * - 语句开头时，能开头的语句关键字排最前
 * - 已经出现过的关键字往后放，避免在关键字后面又提示同一个词
 */
export class KeywordChain implements ComplectionChain {

    /** 语句开头能用的关键字 */
    private static readonly STATEMENT_STARTERS = [
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN',
        'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'CALL', 'REPLACE', 'WITH', 'USE',
        'SET', 'BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'ANALYZE', 'OPTIMIZE',
    ];

    private static readonly KEYWORDS = [
        // 数据操作
        'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
        'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'REPLACE', 'IGNORE',
        'ON DUPLICATE KEY UPDATE', 'UNION', 'UNION ALL', 'DISTINCT', 'AS', 'WITH', 'WINDOW',
        // 连接
        'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN', 'FULL JOIN',
        'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'NATURAL JOIN', 'STRAIGHT_JOIN', 'USING', 'ON',
        // 条件
        'AND', 'OR', 'NOT', 'XOR', 'IN', 'NOT IN', 'EXISTS', 'NOT EXISTS',
        'BETWEEN', 'LIKE', 'NOT LIKE', 'REGEXP', 'RLIKE', 'IS NULL', 'IS NOT NULL',
        'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'IFNULL', 'NULLIF', 'COALESCE',
        'ANY', 'SOME', 'ALL', 'TRUE', 'FALSE', 'NULL',
        // 排序与窗口
        'ASC', 'DESC', 'PARTITION BY', 'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING',
        // DDL
        'TABLE', 'VIEW', 'INDEX', 'KEY', 'COLUMN', 'DATABASE', 'SCHEMA',
        'PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE', 'FULLTEXT', 'SPATIAL',
        'ADD', 'DROP', 'MODIFY', 'CHANGE', 'RENAME',
        'REFERENCES', 'CONSTRAINT', 'CASCADE', 'RESTRICT', 'AUTO_INCREMENT',
        'DEFAULT', 'COMMENT', 'UNSIGNED', 'CHARSET', 'COLLATE',
        'TEMPORARY', 'IF EXISTS', 'IF NOT EXISTS', 'AFTER', 'FIRST',
        // 事务与锁
        'BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
        'LOCK', 'UNLOCK', 'FOR UPDATE', 'SHARE MODE',
        // 语句
        'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'ANALYZE', 'OPTIMIZE', 'TRUNCATE', 'CALL',
        'PROCEDURE', 'FUNCTION', 'TRIGGER', 'DELIMITER', 'SOURCE',
        'GRANT', 'REVOKE', 'PRIVILEGES', 'IDENTIFIED', 'BY',
        'DECLARE', 'CURSOR', 'FETCH', 'OPEN', 'CLOSE', 'LOOP', 'WHILE', 'REPEAT',
        'RETURNS', 'RETURN', 'DETERMINISTIC',
        // 类型
        'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'DECIMAL', 'NUMERIC',
        'FLOAT', 'DOUBLE', 'BIT', 'CHAR', 'VARCHAR', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT',
        'BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'DATE', 'TIME', 'DATETIME', 'TIMESTAMP',
        'YEAR', 'JSON', 'ENUM', 'BOOLEAN', 'BINARY', 'VARBINARY',
    ];

    /** 去重后的关键字表，构造一次复用 */
    private readonly labels: string[] = (() => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const k of KeywordChain.KEYWORDS) {
            if (seen.has(k)) { continue; }
            seen.add(k);
            out.push(k);
        }
        return out;
    })();

    public getComplection(context: ComplectionContext): vscode.CompletionItem[] {

        const before = stripStrings(sqlBeforeCursor(context.sqlBlock, context.position));
        const isStatementStart = !before.trim() || /;\s*$/.test(before.trim());
        const appeared = this.collectAppeared(before);

        const items: vscode.CompletionItem[] = [];
        for (const label of this.labels) {
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
            item.filterText = label;
            item.detail = 'keyword';

            if (isStatementStart && KeywordChain.STATEMENT_STARTERS.includes(label)) {
                // 语句开头：能开头的排最前
                item.sortText = `0_${label.toLowerCase()}`;
            } else if (appeared.has(label)) {
                // 已经打过的关键字往后放
                item.sortText = sortTextFor(SortGroup.KEYWORD + 1, label);
            } else {
                item.sortText = sortTextFor(SortGroup.KEYWORD, label);
            }
            items.push(item);
        }

        return items;
    }

    /** 收集光标前已经完整出现过的关键字（只算单词型，避免误判） */
    private collectAppeared(text: string): Set<string> {
        const appeared = new Set<string>();
        for (const label of this.labels) {
            if (label.includes(' ')) { continue; }
            if (new RegExp(`\\b${label}\\b`, 'i').test(text)) {
                appeared.add(label);
            }
        }
        return appeared;
    }

    public stop(): boolean {
        return true;
    }
}