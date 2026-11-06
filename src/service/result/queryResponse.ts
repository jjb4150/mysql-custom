import { ColumnMeta, FieldInfo } from "@/common/typeDef";

export class RunResponse {
    public sql: string;
    /** 本批次要执行的语句总数；单条执行时为 1 或省略 */
    public batchSize?: number;
}

export class MessageResponse {
    public message: string;
    public success: boolean;
}

export class DataResponse {
    public sql: string;
    public costTime: number;
    public primaryKey: string;
    public columnList: ColumnMeta[];
    public primaryKeyList: ColumnMeta[];
    public database?: string;
    public table: string | null;
    public data: any[];
    public fields: FieldInfo[];
    public pageSize: number;
    public tableCount: number;
    public total?: number;
}

export class ErrorResponse {
    public sql: string;
    public costTime: number;
    public message: string;
    /** 出错语句在源编辑器中的起始行（0 基），无源编辑器时为 null */
    public line?: number;
}

export class DMLResponse {
    public sql: string;
    public costTime: number;
    public message?: string;
    public affectedRows: number;
    public isInsert: boolean;
}

/**
 * Elastic Search Response
 */

export class EsDataResponse extends DataResponse{
    public request?: any;
}