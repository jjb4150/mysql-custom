import * as vscode from "vscode";
import { Console } from "@/common/Console";

/**
 * 把 SQL 执行错误标注到产生它的那一行 SQL 上。
 *
 * 用户诉求：错误不要只塞在结果面板里，要「直接在上面写 SQL 的地方」看到。
 * 所以错误以 VS Code 原生诊断（diagnostic）的形式挂在对应行，
 * 表现为行尾红波浪线 + 行号槽红点，鼠标悬停显示完整 MySQL 报错。
 *
 * 用诊断而不是 decoration 的原因：诊断是 VS Code 原生能力，
 * 会进「问题」面板、支持 F8 跳转，且不需要维护装饰器生命周期。
 */
export class SqlErrorReporter {

    private static collection: vscode.DiagnosticCollection;

    private static getCollection(): vscode.DiagnosticCollection {
        if (!this.collection) {
            this.collection = vscode.languages.createDiagnosticCollection('mysql-custom-sql-error');
        }
        return this.collection;
    }

    /**
     * @param error       数据库返回的错误
     * @param startLine   错误语句在文档中的起始行（0 基），为 null 时无法定位，跳过标注
     * @param endLine     错误语句在文档中的结束行（0 基），用于把整条语句标红
     */
    public static report(error: Error, startLine: number, endLine: number = null) {
        if (startLine == null || startLine < 0) { return; }
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        // 只在 SQL 文件里标，避免在其他语言的编辑器里乱画红波浪线
        if (editor.document.languageId != 'sql' && !editor.document.fileName.match(/\.sql$/i)) { return; }

        const document = editor.document;
        const from = Math.max(0, Math.min(startLine, document.lineCount - 1));
        const to = Math.max(from, Math.min(endLine ?? from, document.lineCount - 1));
        // 标整条语句的内容区，比只标行首更好辨认
        const range = new vscode.Range(
            new vscode.Position(from, 0),
            new vscode.Position(to, document.lineAt(to).text.length)
        );

        const message = this.buildMessage(error);
        const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'MySQL Custom';
        // 只保留本次错误，避免历史红波浪线堆积
        this.getCollection().set(document.uri, [diagnostic]);
    }

    /**
     * 把 MySQL 的 "near 'xxx' at line N" 转换成更容易定位的中文提示，
     * 原文完整保留在后面，方便复制给 DBA。
     */
    private static buildMessage(error: Error): string {
        const raw = (error && error.message) || String(error);
        const nearMatch = raw.match(/near '([\s\S]*?)' at line (\d+)/i);
        if (nearMatch) {
            const [, snippet, lineNo] = nearMatch;
            return `SQL 语法错误（语句内第 ${lineNo} 行附近）：${snippet.trim()}\n\n${raw}`;
        }
        return raw;
    }

    /** 清掉所有错误标记（例如下一次执行成功时） */
    public static clear(document?: vscode.TextDocument) {
        try {
            if (document) {
                this.getCollection().delete(document.uri);
            } else {
                this.getCollection().clear();
            }
        } catch (error) {
            Console.log(error);
        }
    }
}