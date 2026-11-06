import { DatabaseType } from "@/common/constants";
import { TableNode } from "@/model/main/tableNode";
import { ConnectionManager } from "@/service/connectionManager";
import { QueryUnit } from "@/service/queryUnit";
import * as vscode from "vscode";
import { HoverProvider } from "vscode";

export class TableInfoHoverProvider implements HoverProvider {

    public async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover> {

        const wordRange = document.getWordRangeAtPosition(position);
        const tableName = wordRange ? document.getText(wordRange) : null;
        const connection = ConnectionManager.tryGetConnection();

        if (connection && tableName) {
            // 优先用已缓存的树节点（能拿到正确 schema）
            const cached = connection.getByRegion(tableName) as TableNode
            const ddl = cached
                ? await this.getDdlFromNode(cached)
                : await this.getDdlFromConnection(connection, tableName)
            if (ddl) {
                const args = [{ sql: `SELECT * FROM ${tableName}` }];
                const runCommandUri = vscode.Uri.parse(`command:mysql.runQuery?${encodeURIComponent(JSON.stringify(args))}`);
                const markdownStr = new vscode.MarkdownString(`[Query Table](${runCommandUri})`);
                markdownStr.isTrusted = true;
                markdownStr.appendCodeblock(ddl, "sql");
                return new vscode.Hover(markdownStr);
            }
        }

        const selections = vscode.window.activeTextEditor?.selections || []
        for (const selection of selections) {
            if (selection.contains(position)) {
                const args = [{ sql: document.getText(selection) }];
                const runCommandUri = vscode.Uri.parse(`command:mysql.runQuery?${encodeURIComponent(JSON.stringify(args))}`);
                const contents = new vscode.MarkdownString(`[Run Selected SQL](${runCommandUri})`);
                contents.isTrusted = true;
                return new vscode.Hover(contents);
            }
        }

        return null;
    }

    private async getDdlFromNode(node: TableNode): Promise<string> {
        try {
            const res = await node.execute<any[]>(node.dialect.showTableSource(node.schema, node.table))
            return res?.[0]?.['Create Table'] || null
        } catch (error) {
            return null
        }
    }

    /**
     * 表节点还没进树缓存时（用户没展开过树），直接用当前连接查 DDL，
     * 否则悬停永远拿不到表信息。
     */
    private async getDdlFromConnection(connection: any, tableName: string): Promise<string> {
        try {
            if (connection.dbType == DatabaseType.MYSQL) {
                const schema = connection.schema || connection.database
                const sql = schema
                    ? `SHOW CREATE TABLE \`${schema}\`.\`${tableName}\``
                    : `SHOW CREATE TABLE \`${tableName}\``
                const res = await QueryUnit.queryPromise<any[]>(await ConnectionManager.getConnection(connection), sql, false)
                return res?.rows?.[0]?.['Create Table'] || null
            }
        } catch (error) {
            return null
        }
        return null
    }

}