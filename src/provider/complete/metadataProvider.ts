import { Console } from '@/common/Console';
import { ColumnMeta, TableMeta } from '@/common/typeDef';
import { Node } from '@/model/interface/node';
import { TableGroup } from '@/model/main/tableGroup';
import { ViewGroup } from '@/model/main/viewGroup';
import { ConnectionManager } from '@/service/connectionManager';

/**
 * 补全用的元数据缓存。
 *
 * 原来的补全直接读左侧树的节点缓存（DatabaseCache.childCache），
 * 那个缓存只有在用户手动展开过对应节点后才有内容，
 * 所以「新开窗口、没点过表」时补全拿不到任何表/列。
 *
 * 这里做一层独立的、按需加载的缓存：
 * - 先查树节点缓存（命中则零开销，和原来行为一致）
 * - 没命中就用 information_schema 查一次，结果缓存起来
 * - 同一个库的并发请求合并成一个，避免手速快时打爆数据库
 */
export class MetadataProvider {

    /** 连接+库 → 表列表 */
    private static tableCache = new Map<string, { at: number; tables: TableMeta[] }>();
    /** 连接+库+表 → 列列表 */
    private static columnCache = new Map<string, { at: number; columns: ColumnMeta[] }>();
    /** 进行中的请求，用于并发合并 */
    private static inflight = new Map<string, Promise<any>>();

    /** 缓存有效期：结构变更不频繁，5 分钟足够，用户也能手动刷新树来更新 */
    private static TTL = 5 * 60 * 1000;

    private static key(node: Node, ...parts: string[]): string {
        const conn = node.getConnectId({ withSchema: true }) || node.getConnectId();
        return [conn, ...parts].join('::');
    }

    /**
     * 取某个库下的表。
     * @param node 需要带 schema 的连接节点
     * @param schema 目标库，不传则用节点自身的
     */
    public static async getTables(node: Node, schema?: string): Promise<TableMeta[]> {
        if (!node) { return []; }
        const targetSchema = schema || node.schema || node.database;
        const cacheKey = this.key(node, 'tables', targetSchema || '');

        const cached = this.tableCache.get(cacheKey);
        if (cached && Date.now() - cached.at < this.TTL) {
            return cached.tables;
        }

        // 树已经展开过就直接用，零查询开销
        const fromTree = await this.getTablesFromTree(node, targetSchema);
        if (fromTree && fromTree.length > 0) {
            this.tableCache.set(cacheKey, { at: Date.now(), tables: fromTree });
            return fromTree;
        }

        return this.dedupe(cacheKey, async () => {
            try {
                const target = this.resolveNode(node, targetSchema);
                const rows = await target.execute<any[]>(target.dialect.showTables(targetSchema || target.schema));
                const tables: TableMeta[] = (rows || []).map((row: any) => ({
                    name: row.name ?? row.TABLE_NAME ?? row.table_name,
                    comment: row.comment ?? row.TABLE_COMMENT ?? '',
                    rows: row.rows ?? row.TABLE_ROWS,
                    auto_increment: row.auto_increment,
                    row_format: row.row_format,
                    data_length: row.data_length,
                    index_length: row.index_length,
                })).filter(t => !!t.name);
                this.tableCache.set(cacheKey, { at: Date.now(), tables });
                return tables;
            } catch (err) {
                Console.log(`[completion] 加载表列表失败: ${err}`);
                return [];
            }
        });
    }

    /**
     * 取某张表的列。
     */
    public static async getColumns(node: Node, table: string, schema?: string): Promise<ColumnMeta[]> {
        if (!node || !table) { return []; }
        const targetSchema = schema || node.schema || node.database;
        const cacheKey = this.key(node, 'columns', targetSchema || '', table);

        const cached = this.columnCache.get(cacheKey);
        if (cached && Date.now() - cached.at < this.TTL) {
            return cached.columns;
        }

        const fromTree = await this.getColumnsFromTree(node, table, targetSchema);
        if (fromTree && fromTree.length > 0) {
            this.columnCache.set(cacheKey, { at: Date.now(), columns: fromTree });
            return fromTree;
        }

        return this.dedupe(cacheKey, async () => {
            try {
                const target = this.resolveNode(node, targetSchema);
                const rows = await target.execute<any[]>(target.dialect.showColumns(targetSchema || target.schema, table));
                const columns: ColumnMeta[] = (rows || []).map((row: any) => ({
                    name: row.name ?? row.COLUMN_NAME ?? row.column_name,
                    simpleType: row.simpleType ?? row.DATA_TYPE ?? '',
                    type: row.type ?? row.COLUMN_TYPE ?? '',
                    comment: row.comment ?? row.COLUMN_COMMENT ?? '',
                    key: row.key ?? row.COLUMN_KEY ?? '',
                    nullable: row.nullable ?? row.IS_NULLABLE,
                    maxLength: row.maxLength ?? row.CHARACTER_MAXIMUM_LENGTH,
                    defaultValue: row.defaultValue ?? row.COLUMN_DEFAULT,
                    extra: row.extra ?? row.EXTRA,
                } as ColumnMeta)).filter(c => !!c.name);
                this.columnCache.set(cacheKey, { at: Date.now(), columns });
                return columns;
            } catch (err) {
                Console.log(`[completion] 加载列失败 ${table}: ${err}`);
                return [];
            }
        });
    }

    /** 从树节点缓存里拿表，拿不到返回空数组 */
    private static async getTablesFromTree(node: Node, schema?: string): Promise<TableMeta[]> {
        try {
            const target = this.resolveNode(node, schema);
            const groups = await target.getChildren();
            if (!groups) { return []; }
            const tables: TableMeta[] = [];
            for (const group of groups) {
                if (group instanceof TableGroup || group instanceof ViewGroup) {
                    const children = await group.getChildren();
                    for (const child of children || []) {
                        const anyChild = child as any;
                        if (anyChild && anyChild.table) {
                            tables.push({
                                name: anyChild.table,
                                comment: child.description || '',
                                rows: undefined,
                            });
                        }
                    }
                }
            }
            return tables;
        } catch {
            return [];
        }
    }

    /** 从树节点缓存里拿列 */
    private static async getColumnsFromTree(node: Node, table: string, schema?: string): Promise<ColumnMeta[]> {
        try {
            const target = this.resolveNode(node, schema);
            const tableNode = target.getByRegion<any>(table);
            if (!tableNode || typeof tableNode.getChildren !== 'function') { return []; }
            const children = await tableNode.getChildren();
            return (children || [])
                .map((child: any) => child && child.column)
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    /**
     * 找一个带正确 schema 的连接节点。
     * schema 和当前节点不一致时，从节点缓存里换一个，保证 SQL 打到对的库。
     */
    private static resolveNode(node: Node, schema?: string): Node {
        if (!schema || schema === node.schema) { return node; }
        const id = node.getConnectId({ schema, withSchema: true });
        const cached = Node.nodeCache[id];
        if (cached) { return cached; }
        return node;
    }

    /** 同一个 key 的并发请求只发一次 */
    private static dedupe<T>(cacheKey: string, factory: () => Promise<T>): Promise<T> {
        const running = this.inflight.get(cacheKey);
        if (running) { return running; }
        const promise = factory().finally(() => {
            this.inflight.delete(cacheKey);
        });
        this.inflight.set(cacheKey, promise);
        return promise;
    }

    /** 手动失效（用户刷新树时调用） */
    public static invalidate(schema?: string) {
        if (!schema) {
            this.tableCache.clear();
            this.columnCache.clear();
            return;
        }
        for (const k of Array.from(this.tableCache.keys())) {
            if (k.includes(schema)) { this.tableCache.delete(k); }
        }
        for (const k of Array.from(this.columnCache.keys())) {
            if (k.includes(schema)) { this.columnCache.delete(k); }
        }
    }

    /**
     * 当前应该用哪个连接做补全。
     * 优先活动连接；没有活动连接时退到唯一存活的连接，尽量让新开窗口也有候选。
     */
    public static activeConnection(): Node {
        return ConnectionManager.tryGetConnection();
    }
}