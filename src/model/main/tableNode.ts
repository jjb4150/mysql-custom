import { ColumnMeta, TableMeta } from "@/common/typeDef";
import { Hanlder, ViewManager } from "@/common/viewManager";
import * as vscode from "vscode";
import { ConfigKey, DatabaseType, ModelType, Template } from "../../common/constants";
import { Global } from "../../common/global";
import { Util } from "../../common/util";
import { DbTreeDataProvider } from "../../provider/treeDataProvider";
import { ConnectionManager } from "../../service/connectionManager";
import { QueryUnit } from "../../service/queryUnit";
import { CopyAble } from "../interface/copyAble";
import { Node } from "../interface/node";
import { ColumnNode } from "../other/columnNode";
import { InfoNode } from "../other/infoNode";

export class TableNode extends Node implements CopyAble {

    public iconPath = new vscode.ThemeIcon("split-horizontal")
    public contextValue: string = ModelType.TABLE;
    public table: string;

    constructor(readonly meta: TableMeta, readonly parent: Node) {
        super(`${meta.name}`)
        this.table = meta.name
        this.description = `${meta.comment || ''} ${(meta.rows != null) ? `Rows ${meta.rows}` : ''}`
        if (Util.supportColorIcon) {
            // this.iconPath=new vscode.ThemeIcon("split-horizontal",new vscode.ThemeColor("problemsWarningIcon.foreground"))
        }
        this.init(parent)
        this.tooltip = this.getToolTipe(meta)
        this.cacheSelf()
        this.command = {
            command: "mysql.table.source",
            title: "Show Table Source",
            arguments: [this],
        }
    }

    public async getChildren(isRresh: boolean = false): Promise<Node[]> {
        let columnNodes = this.getChildCache();
        if (columnNodes && !isRresh) {
            return columnNodes;
        }
        return this.execute<ColumnMeta[]>(this.dialect.showColumns(this.schema, this.table))
            .then((columns) => {
                columnNodes = columns.map<ColumnNode>((column, index) => {
                    return new ColumnNode(this.table, column, this, index);
                });
                this.setChildCache(columnNodes)
                return columnNodes;
            })
            .catch((err) => {
                return [new InfoNode(err)];
            });
    }

    public addColumnTemplate() {
        QueryUnit.showSQLTextDocument(this, this.dialect.addColumn(this.wrap(this.table)), Template.alter);
    }


    public async showSource(open = true) {
        let sql: string;
        if (this.dbType == DatabaseType.MYSQL || this.dbType == DatabaseType.SQLITE) {
            const sourceResule = await this.execute<any[]>(this.dialect.showTableSource(this.schema, this.table))
            sql = sourceResule[0]['Create Table'];
            if (this.dbType == DatabaseType.SQLITE) {
                sql = sql.replace(/\\n/g, '\n');
            }
        } else {
            const childs = await this.getChildren();
            sql = `CREATE TABLE ${this.table}(\n`
            for (let i = 0; i < childs.length; i++) {
                const child: ColumnNode = childs[i] as ColumnNode;
                if (i == childs.length - 1) {
                    sql += `    ${child.column.name} ${child.type}${child.isPrimaryKey ? ' PRIMARY KEY' : ''}\n`
                } else {
                    sql += `    ${child.column.name} ${child.type}${child.isPrimaryKey ? ' PRIMARY KEY' : ''},\n`
                }
            }
            sql += ")"
        }
        if (open) {
            QueryUnit.showSQLTextDocument(this, sql);
        }
        return sql;
    }

    /**
     * 复制表：CREATE TABLE new LIKE old，再按需带上数据。
     */
    public async copyTable() {
        const newName = await vscode.window.showInputBox({
            prompt: `Copy table ${this.table} to`,
            value: `${this.table}_copy`,
            validateInput: (v) => (!v || !v.trim()) ? 'Table name is required' : null
        })
        if (!newName) { return }
        const withData = await vscode.window.showQuickPick(
            ['Structure only', 'Structure and data'],
            { placeHolder: 'Copy option' }
        )
        if (!withData) { return }
        const target = this.wrap(newName.trim())
        const source = `${this.wrap(this.schema)}.${this.wrap(this.table)}`
        try {
            await this.execute(`CREATE TABLE ${this.wrap(this.schema)}.${target} LIKE ${source}`)
            if (withData === 'Structure and data') {
                await this.execute(`INSERT INTO ${this.wrap(this.schema)}.${target} SELECT * FROM ${source}`)
            }
            this.parent.setChildCache(null)
            DbTreeDataProvider.refresh(this.parent)
            vscode.window.showInformationMessage(`Copy table ${this.table} to ${newName} success!`)
        } catch (error) {
            vscode.window.showErrorMessage(`Copy table failed: ${error.message}`)
        }
    }

    /**
     * 改名：MySQL 用 RENAME TABLE，其它库走 alter table rename。
     */
    public async changeName() {
        const newName = await vscode.window.showInputBox({
            prompt: `Rename table ${this.table} to`,
            value: this.table,
            validateInput: (v) => (!v || !v.trim()) ? 'Table name is required' : null
        })
        if (!newName || newName.trim() == this.table) { return }
        try {
            await this.execute(`RENAME TABLE ${this.wrap(this.schema)}.${this.wrap(this.table)} TO ${this.wrap(this.schema)}.${this.wrap(newName.trim())}`)
            this.parent.setChildCache(null)
            DbTreeDataProvider.refresh(this.parent)
            vscode.window.showInformationMessage(`Rename table ${this.table} to ${newName} success!`)
        } catch (error) {
            vscode.window.showErrorMessage(`Rename table failed: ${error.message}`)
        }
    }

    /**
     * 在整张表里按关键字做全文搜索：把所有字符列拼成 OR LIKE 条件。
     */
    public async fullTextSearch() {
        const keyword = await vscode.window.showInputBox({
            prompt: `Search keyword in table ${this.table}`,
            placeHolder: 'keyword'
        })
        if (keyword === undefined) { return }
        const children = await this.getChildren()
        const textColumns = children
            .filter((c: any) => c.column && this.isTextType(c.type))
            .map((c: any) => c.column.name)
        if (textColumns.length == 0) {
            vscode.window.showWarningMessage(`No text column found in table ${this.table}`)
            return
        }
        const escaped = keyword.replace(/'/g, "''")
        const conditions = textColumns
            .map((name: string) => `\`${name}\` LIKE '%${escaped}%'`)
            .join(' OR ')
        const sql = `SELECT * FROM ${this.wrap(this.schema)}.${this.wrap(this.table)} WHERE ${conditions}`
        QueryUnit.runQuery(sql, this, { viewId: new Date().getTime() })
        ConnectionManager.changeActive(this)
    }

    private isTextType(type: string): boolean {
        if (!type) { return false }
        const t = type.toLowerCase()
        return t.includes('char') || t.includes('text') || t.includes('enum') || t.includes('set')
    }

    public dropTable() {

        Util.confirm(`Are you sure you want to drop table ${this.table} ? `, async () => {
            this.execute(`DROP TABLE ${this.wrap(this.table)}`).then(() => {
                this.parent.setChildCache(null)
                DbTreeDataProvider.refresh(this.parent);
                vscode.window.showInformationMessage(`Drop table ${this.table} success!`);
            });
        })

    }


    public truncateTable() {

        Util.confirm(`Are you sure you want to clear table ${this.table} all data ?`, async () => {
            const truncateSql = this.dbType == DatabaseType.SQLITE ? `DELETE FROM ${this.wrap(this.table)}` : `truncate table ${this.wrap(this.table)}`;
            this.execute(truncateSql).then(() => {
                vscode.window.showInformationMessage(`Clear table ${this.table} all data success!`);
            });
        })

    }



    public designTable() {

        const executeAndRefresh = async (sql: string, handler: Hanlder) => {
            try {
                await this.execute(sql)
                handler.emit("success")
            } catch (error) {
                handler.emit("error", error.message)
            }
        }

        ViewManager.createWebviewPanel({
            path: "app", title: "Design Table",
            splitView: false, iconPath: Global.getExtPath("resources", "icon", "dropper.svg"),
            eventHandler: (handler => {
                handler.on("init", () => {
                    handler.emit('route', 'design')
                }).on("route-design", async () => {
                    const result = await this.execute(this.dialect.showIndex(this.schema, this.table))
                    let primaryKey: string;
                    const columnList = (await this.getChildren()).map((columnNode: ColumnNode) => {
                        if (columnNode.isPrimaryKey) {
                            primaryKey = columnNode.column.name;
                        }
                        return columnNode.column;
                    });
                    handler.emit('design-data', { indexs: result, table: this.table, comment: this.meta.comment, columnList, primaryKey, dbType: this.dbType })
                }).on("updateTable", async ({ newTableName, newComment }) => {
                    const sql = this.dialect.updateTable({ table: this.table, newTableName, comment: this.meta.comment, newComment });
                    await executeAndRefresh(sql, handler)
                    this.parent.setChildCache(null)
                    this.provider.reload(this.parent)
                }).on("updateColumn", async (updateColumnParam) => {
                    const sql = this.dialect.updateColumnSql(updateColumnParam);
                    await executeAndRefresh(sql, handler)
                    this.setChildCache(null)
                    this.provider.reload(this.parent)
                }).on("dropIndex", async indexName => {
                    const sql = this.dialect.dropIndex(this.table, indexName);
                    await executeAndRefresh(sql, handler)
                }).on("execute", async sql => {
                    await executeAndRefresh(sql, handler)
                    this.setChildCache(null)
                    this.parent.setChildCache(null)
                    this.provider.reload(this.parent)
                }).on("createIndex", async ({ column, type, indexType }) => {
                    const sql = this.dialect.createIndex({ column, type, indexType, table: this.wrap(this.table) });
                    await executeAndRefresh(sql, handler)
                })
            })
        })

    }

    public async openInNew() {
        const pageSize = Global.getConfig<number>(ConfigKey.DEFAULT_LIMIT);
        const sql = this.dialect.buildPageSql(this.wrap(this.schema), this.wrap(this.table), pageSize);
        QueryUnit.runQuery(sql, this, { viewId: new Date().getTime() });
        ConnectionManager.changeActive(this)
    }

    public async openTable() {
        const pageSize = Global.getConfig<number>(ConfigKey.DEFAULT_LIMIT);
        const sql = this.dialect.buildPageSql(this.wrap(this.schema), this.wrap(this.table), pageSize);
        QueryUnit.runQuery(sql, this);
        ConnectionManager.changeActive(this)
    }

    public getToolTipe(meta: TableMeta): string {
        if (this.dbType == DatabaseType.MYSQL && meta.data_length) {
            return `AUTO_INCREMENT : ${meta.auto_increment || 'null'}
ROW_FORMAT : ${meta.row_format}
`
        }

        return ''
    }

    public insertSqlTemplate(show: boolean = true): Promise<string> {
        return new Promise((resolve) => {
            this
                .getChildren()
                .then((children: Node[]) => {
                    const childrenNames = children.map((child: any) => "\n    " + this.wrap(child.column.name));
                    const childrenValues = children.map((child: any) => "\n    $" + child.column.name);
                    let sql = `insert into \n  ${this.wrap(this.table)} `;
                    sql += `(${childrenNames.toString().replace(/,/g, ", ")}\n  )\n`;
                    sql += "values\n  ";
                    sql += `(${childrenValues.toString().replace(/,/g, ", ")}\n  );`;
                    if (show) {
                        QueryUnit.showSQLTextDocument(this, sql, Template.table);
                    }
                    resolve(sql)
                });
        })
    }

    public async selectSqlTemplate() {
        const sql = `SELECT * FROM ${Util.wrap(this.table)}`;
        QueryUnit.showSQLTextDocument(this, sql, Template.table);

    }

    public deleteSqlTemplate(): any {
        this
            .getChildren()
            .then((children: Node[]) => {
                const keysNames = children.filter((child: any) => child.column.key).map((child: any) => child.column.name);

                const where = keysNames.map((name: string) => `${this.wrap(name)} = \$${name}`);

                let sql = `delete from \n  ${this.wrap(this.table)} \n`;
                sql += `where \n  ${where.toString().replace(/,/g, "\n  and")}`;
                QueryUnit.showSQLTextDocument(this, sql, Template.table);
            });
    }

    public updateSqlTemplate() {
        this
            .getChildren()
            .then((children: Node[]) => {
                const keysNames = children.filter((child: any) => child.column.key).map((child: any) => child.column.name);
                const childrenNames = children.filter((child: any) => !child.column.key).map((child: any) => child.column.name);

                const sets = childrenNames.map((name: string) => `${name} = ${name}`);
                const where = keysNames.map((name: string) => `${name} = '${name}'`);

                let sql = `update \n  ${this.wrap(this.table)} \nset \n  ${sets.toString().replace(/,/g, ",\n  ")}\n`;
                sql += `where \n  ${where.toString().replace(/,/g, "\n  and ")}`;
                QueryUnit.showSQLTextDocument(this, sql, Template.table);
            });
    }

    public async getMaxPrimary(): Promise<number> {
        return Promise.resolve(0)
    }

    public copyName(): void {
        Util.copyToBoard(this.table);
    }


}
