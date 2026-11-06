import * as vscode from "vscode";
import { FieldInfo } from "@/common/typeDef";
import * as fs from "fs";
import { Console } from "../../common/Console";
import { ExportContext, ExportType } from "./exportContext";
import { ProgressLocation } from "vscode";
import { ConnectionManager } from "../connectionManager";
import { ConfigKey, DatabaseType } from "@/common/constants";
import { Global } from "@/common/global";

export class ExportService {

    public export(context: ExportContext): Thenable<any> {
        const randomFileName = `${new Date().getTime()}.${context.type}`

        return vscode.window.showSaveDialog({ saveLabel: "Select export file path", defaultUri: vscode.Uri.file(randomFileName), filters: { 'file': [context.type] } }).then((filePath) => {
            if (!filePath) { return null }
            context.exportPath = filePath.fsPath;
            if (context.withOutLimit) {
                context.sql = context.sql.replace(/\blimit\s.+/gi, "")
            }
            // 全量导出前先估算行数，超大表先确认，避免把内存撑爆
            return this.checkExportSize(context).then((blocked) => {
                if (blocked) { return null }
                return vscode.window.withProgress(
                    { title: `Start exporting data to ${context.type}...`, location: ProgressLocation.Notification },
                    () => new Promise((resolve) => {
                        context.done = resolve
                        try {
                            this.exportData(context)
                        } catch (error) {
                            resolve(null)
                        }
                    })
                )
            })
        })
    }


    /**
     * 全量导出前的体量检查。
     * 直接把百万行读进内存会 OOM，这里先 COUNT 一次，
     * 超过阈值就提醒用户自己加 WHERE 缩小范围。
     */
    private async checkExportSize(context: ExportContext): Promise<boolean> {
        if (!context.withOutLimit) { return false }
        const limit = Global.getConfig<number>(ConfigKey.EXPORT_ROW_LIMIT, 500000)
        if (!limit || limit <= 0) { return false }
        const base = context.sql.trim().replace(/;+\s*$/, '')
        if (!/^\s*(select|with)\b/i.test(base)) { return false }
        try {
            const connection = await ConnectionManager.getConnection(context.dbOption)
            const countSql = `SELECT COUNT(*) AS count FROM (${base}) __dbclient_export_count__`
            const rows: any = await new Promise((resolve, reject) => {
                connection.query(countSql, (err, data) => err ? reject(err) : resolve(data))
            })
            const total = Number(rows?.[0]?.count ?? rows?.[0]?.COUNT ?? 0)
            if (total > limit) {
                const action = await vscode.window.showWarningMessage(
                    `导出范围过大：共 ${total} 行，超过安全阈值 ${limit} 行。建议加 WHERE 条件缩小范围。`,
                    '仍然导出', '取消'
                )
                return action !== '仍然导出'
            }
        } catch (error) {
            // 统计失败不阻塞导出，只是失去这层保护
            Console.log(error)
        }
        return false
    }

    private async exportData(context: ExportContext) {

        const sql = context.sql
        const connection = await ConnectionManager.getConnection(context.dbOption)

        // 大结果集导出走流式：边读边写文件，内存占用与总行数无关。
        // Excel/JSON/Markdown 需要完整数据才能生成，仍走原来的内存方式。
        const canStream = (context.type == ExportType.csv || context.type == ExportType.sql)
            && typeof (connection as any).queryStream === 'function'
        if (canStream) {
            this.exportByStream(context, connection as any, sql)
            return
        }

        connection.query(sql, (err, rows, fields?: FieldInfo[]) => {
            if (err) {
                Console.log(err)
                return;
            }
            this.delegateExport(context, rows, fields)
        })

    }

    /**
     * 流式导出 CSV / SQL。
     * 逐行写入流，不把结果集整体读入内存，百万行也不会 OOM。
     */
    private exportByStream(context: ExportContext, connection: any, sql: string) {
        const isCsv = context.type == ExportType.csv
        const stream = fs.createWriteStream(context.exportPath, { encoding: 'utf8' })
        // CSV 加 BOM，避免 Excel 打开中文乱码
        if (isCsv) { stream.write('\ufeff') }

        let headerWritten = false
        let rowCount = 0
        let failed = false
        // 列名由 fields 事件提供，保证 CSV 表头与数据列顺序一致
        let columnNames: string[] = []

        const escapeCsv = (value: any) => {
            if (value === null || value === undefined) return ''
            const text = value instanceof Date ? value.toISOString() : String(value)
            return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
        }

        connection.queryStream(sql, (row: any) => {
            if (failed) return
            try {
                rowCount++
                if (isCsv) {
                    // 按列名取值，保证列顺序与表头一致
                    const values = columnNames.map((name) => escapeCsv(row[name]))
                    stream.write(values.join(',') + '\r\n')
                } else {
                    const columns = Object.keys(row).join(',')
                    const values = Object.keys(row).map((k) => this.formatSqlValue(row[k])).join(',')
                    stream.write(`insert into ${context.table}(${columns}) values(${values});\n`)
                }
            } catch (error) {
                failed = true
                Console.log(error)
            }
        }, (err?: Error) => {
            stream.end(() => {
                if (err) {
                    Console.log(err)
                    vscode.window.showErrorMessage(`Export failed: ${err.message}`)
                } else {
                    vscode.window.showInformationMessage(
                        `Export success: ${rowCount} rows -> ${context.exportPath}`, 'Open'
                    ).then(action => {
                        if (action) {
                            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(context.exportPath));
                        }
                    })
                }
                context.done()
            })
        }, (fields: any[]) => {
            // 列定义回调：先写 CSV 表头，再开始写数据行
            columnNames = (fields || []).map((f) => f.name)
            if (isCsv && !headerWritten && columnNames.length) {
                stream.write(columnNames.map(escapeCsv).join(',') + '\r\n')
                headerWritten = true
            }
        })
    }

    private delegateExport(context: ExportContext, rows: any, fields: FieldInfo[]) {
        context.fields = fields;
        context.rows = rows;
        const filePath = context.exportPath;
        switch (context.type) {
            case ExportType.excel:
                this.exportByNodeXlsx(filePath, fields, rows);
                break;
            case ExportType.csv:
                this.exportToCsv(filePath, fields, rows);
                break;
            case ExportType.json:
                this.exportToJson(context);
                break;
            case ExportType.sql:
                this.exportToSql(context);
                break;
            case ExportType.markdown:
                this.exportToMarkdown(filePath, fields, rows);
                break;
        }
        context.done()
        vscode.window.showInformationMessage(`export ${context.type} success, path is ${context.exportPath}!`, 'Open').then(action => {
            if (action) {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(context.exportPath));
            }
        })

    }

    private exportToJson(context: ExportContext) {
        fs.writeFileSync(context.exportPath, JSON.stringify(context.rows, (k, v:any) => {
            return v === undefined ? null : v;
        }, 2));
    }

    private exportToSql(exportContext: ExportContext) {

        const { rows, exportPath } = exportContext;
        if (rows.length == 0) {
            // show waraing
            return;
        }

        let sql = ``;
        for (const row of rows) {
            let columns = "";
            let values = "";
            for (const key in row) {
                columns += `${key},`
                values += `${this.formatSqlValue(row[key])},`
            }
            sql += `insert into ${exportContext.table}(${columns.replace(/.$/, '')}) values(${values.replace(/.$/, '')});\n`
        }
        fs.writeFileSync(exportPath, sql);
    }

    /**
     * 把结果集中的值转成合法的 SQL 字面量。
     * 原来直接拼 `'${value}'`，值里带单引号就会生成坏 SQL（如 O'Brien），
     * 反斜杠、换行、NULL 与 Buffer 也没有处理。
     */
    private formatSqlValue(value: any): string {
        if (value === null || value === undefined) {
            return 'null'
        }
        if (typeof value === 'number') {
            return isFinite(value) ? String(value) : 'null'
        }
        if (typeof value === 'boolean') {
            return value ? '1' : '0'
        }
        if (value instanceof Date) {
            return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`
        }
        if (Buffer.isBuffer(value)) {
            return `X'${value.toString('hex')}'`
        }
        if (typeof value === 'object') {
            return `'${this.escapeSqlString(JSON.stringify(value))}'`
        }
        return `'${this.escapeSqlString(String(value))}'`
    }

    private escapeSqlString(str: string): string {
        return str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "''")
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')
            .replace(/\u0000/g, '\\0')
    }

    private exportToMarkdown(filePath: string, fields: FieldInfo[], rows: any) {
        const names = fields.map((field) => field.name)
        const escapeCell = (value: any) => {
            if (value === null || value === undefined) return ''
            // 竖线会破坏表格结构，换行会让整行断裂
            return String(value)
                .replace(/\|/g, '\\|')
                .replace(/\r?\n/g, '<br>')
        }
        const lines: string[] = []
        lines.push(`| ${names.map(escapeCell).join(' | ')} |`)
        lines.push(`| ${names.map(() => '---').join(' | ')} |`)
        for (const row of rows) {
            const cells = names.map((name) => escapeCell(row[name]))
            lines.push(`| ${cells.join(' | ')} |`)
        }
        fs.writeFileSync(filePath, lines.join('\n'), { encoding: 'utf8' })
    }

    private exportByNodeXlsx(filePath: string, fields: FieldInfo[], rows: any) {
        const nodeXlsx = require('@/bin/node-xlsx');
        fs.writeFileSync(filePath, nodeXlsx.build([{
            name: "sheet1",
            data: [
                fields.map((field) => field.name),
                ...rows.map((row) => {
                    const values = [];
                    for (const key in row) {
                        values.push(row[key]);
                    }
                    return values;
                })
            ]
        }]), "binary");
    }

    private exportToCsv(filePath: string, fields: FieldInfo[], rows: any) {
        const names = fields.map((field) => field.name)
        // 原实现只把 null 转成空串、直接按逗号拼接，值里含逗号/双引号/换行时
        // 导出的文件会错列甚至无法解析。按 RFC 4180 补齐转义。
        const escapeCsv = (value: any) => {
            if (value === null || value === undefined) return ''
            const text = value instanceof Date ? value.toISOString() : String(value)
            if (/[",\r\n]/.test(text)) {
                return `"${text.replace(/"/g, '""')}"`
            }
            return text
        }
        const lines: string[] = []
        lines.push(names.map(escapeCsv).join(','))
        for (const row of rows) {
            lines.push(names.map((name) => escapeCsv(row[name])).join(','))
        }
        // 加 BOM，避免 Excel 打开 UTF-8 中文乱码
        fs.writeFileSync(filePath, '\ufeff' + lines.join('\r\n'), { encoding: "utf8" });
    }


}
