import * as vscode from "vscode";
import * as path from "path";

const extName=require("@/../package.json")

export class Constants {
    public static CONFIG_PREFIX = "database-client"
    public static RES_PATH = path.join(vscode.extensions.getExtension(`${extName.publisher}.${extName.name}`).extensionPath, "resources");
}

export class Pattern {
    public static TABLE_PATTERN = "\\b(from|join|update|into)\\b\\s*\\[?((\\w|\\.|-|`|\"|')+)\\]?";
    public static DML_PATTERN = "\\b(update|into)\\b\\s*`{0,1}(\\w|\\.|-)+`{0,1}";
    public static MULTI_PATTERN = /\b(TRIGGER|PROCEDURE|FUNCTION)\b/ig
}

export enum CacheKey {
    // sql
    DATBASE_CONECTIONS = "mysql.connections",
    DATABASE_SATE = "mysql.database.cache.collapseState",
    // nosql
    NOSQL_CONNECTION = "redis.connections",
    COLLAPSE_SATE = "redis.cache.collapseState",
    // history
    GLOBAL_HISTORY="sql.history"
}

export enum ConfigKey {
    HIGHLIGHT_SQL_BLOCK = "highlightSQLBlock",
    DEFAULT_LIMIT = "defaultSelectLimit",
    PREFER_CONNECTION_NAME = "preferConnectionName",
    DISABLE_SQL_CODELEN = "disableSqlCodeLen",
    /**
     * 结果页是否拆到右侧编辑器组打开。默认 false，在下方打开。
     */
    RESULT_IN_SPLIT_VIEW = "resultInSplitView",
    /**
     * 结果页表头是否显示字段注释。默认 true。
     */
    SHOW_COLUMN_COMMENT = "showColumnComment",
    /**
     * 每次执行 SQL 是否保留独立结果面板。默认 true，行为接近 Navicat。
     */
    KEEP_RESULT_HISTORY = "keepResultHistory",
    /**
     * 单个结果面板内以 tab 堆叠多次查询结果。默认 true。
     */
    SINGLE_RESULT_PANEL = "singleResultPanel",
    /**
     * 结果面板是否打开在编辑器下方（上下分栏）。默认 true。
     */
    RESULT_BELOW_EDITOR = "resultBelowEditor",
    /**
     * 首次执行 SELECT 时自动加 LIMIT，避免全表拉取导致卡死。默认 true。
     */
    AUTO_PAGING_SQL = "autoPagingSQL",
    /**
     * 全量导出的行数安全阈值，超过会先提示确认。默认 500000。
     */
    EXPORT_ROW_LIMIT = "exportRowLimit",
    /**
     * 总数统计的数据库端执行上限（毫秒）。默认 3000。
     */
    COUNT_TIMEOUT = "countTimeout",
    /**
     * 是否每次查询后自动统计总数。默认 false（改为点击 Total 才统计）。
     */
    AUTO_COUNT_TOTAL = "autoCountTotal",
    /**
     * 执行 SQL 时未指定库名，是否自动补全为当前活动库。默认 true。
     */
    AUTO_USE_ACTIVE_DATABASE = "autoUseActiveDatabase",
}

export enum CodeCommand {
    RecordHistory = "mysql.history.record",
    Refresh = "mysql.refresh"
}

export class Cursor {
    public static FIRST_POSITION = new vscode.Position(0, 0);
    public static getRangeStartTo(end: vscode.Position): vscode.Range {
        return new vscode.Range(this.FIRST_POSITION, end);
    }
}

export enum Confirm {
    YES = "YES", NO = "NO"
}

export enum DatabaseType {
    MYSQL = "MySQL", PG = "PostgreSQL", SQLITE = "SQLite",
    MSSQL = "SqlServer"
}

export enum ModelType {
    /**
     * database
     */
    CONNECTION = "connection",CATALOG = "catalog", SCHEMA = "database", USER_GROUP = "userGroup", USER = "user",
    TABLE = "table", COLUMN = "column", INFO = "info", TABLE_GROUP = "tableGroup",
    VIEW = "view", VIEW_GROUP = "viewGroup",  TRIGGER_GROUP = "triggerGroup", TRIGGER = "trigger",
    PROCEDURE_GROUP = "procedureGroup", PROCEDURE = "procedure", FUNCTION_GROUP = "functionGroup", FUNCTION = "function",
    QUERY_GROUP = "queryGroup", QUERY = "query",
    DIAGRAM_GROUP = "diagramGroup", DIAGRAM = "diagram"
}

export enum MessageType {
    DATA = 'DATA',
    DML = 'DML',
    DDL = 'DDL',
    MESSAGE_BLOCK = 'MESSAGE_BLOCK',
    ERROR = "ERROR",
    RUN = "RUN",
    MESSAGE = "MESSAGE",
    NEXT_PAGE = "NEXT_PAGE",
    THEME = "theme"
}

export enum Template {
    table = "sql-template.sql",
    alter = "alter-template.sql"
}


export enum RedisType {
    hash = 'hash', list = 'list', string = 'string', zset = 'zset', set = 'set'
}