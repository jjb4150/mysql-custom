import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { WebviewPanel } from "vscode";
import { Console } from "./Console";
import { EventEmitter } from 'events'

export class ViewOption {
    public iconPath?:  string|vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };
    public path: string;
    public title: string;
    public type?: string;
    public preserveFocus?:boolean;
    public splitView: boolean = false;
    /**
     * 结果面板是否开在下方的编辑器组（上下分栏）。
     */
    public openBelow?: boolean;
    /**
     * keep single page by viewType
     */
    public singlePage?: boolean;
    /**
     * receive webview send message 
     */
    public handleHtml?: (html: string, viewPanel: WebviewPanel) => string;
    public eventHandler?: (handler: Hanlder) => void;
}

export class Hanlder {

    constructor(public panel: WebviewPanel, private eventEmitter: EventEmitter) { }

    on(event: string, callback: (content: any) => void): this {
        this.eventEmitter.on(event, callback)
        return this;
    }

    emit(event: string, content?: any) {
        this.panel.webview.postMessage({ type: event, content })
    }

}

interface ViewState {
    instance: WebviewPanel;
    creating: boolean;
    eventEmitter: EventEmitter;
}

export class ViewManager {

    private static viewStatu: { [key: string]: ViewState } = {};
    private static webviewPath: string;
    public static initExtesnsionPath(extensionPath: string) {
        this.webviewPath = extensionPath + "/out/webview"
    }

    public static createWebviewPanel(viewOption: ViewOption): Promise<WebviewPanel> {

        return new Promise((resolve, reject) => {

            if (typeof (viewOption.singlePage) == 'undefined') { viewOption.singlePage = true }

            if(viewOption.preserveFocus==null){
                viewOption.preserveFocus=true;
            }
            if(!viewOption.type){
                viewOption.type=viewOption.title
            }
            if (!viewOption.singlePage) {
                viewOption.type = viewOption.type + new Date().getTime()
            }

            const viewColumn = viewOption.splitView ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
            const currentStatus = this.viewStatu[viewOption.type]
            if (viewOption.singlePage && currentStatus && currentStatus.instance) {
                // 面板已存在就复用，不再因为不可见而销毁重建，
                // 否则每次切走再执行 SQL 都会新开一个编辑器标签。
                if (currentStatus.instance.visible == false) {
                    currentStatus.instance.reveal()
                }
                currentStatus.eventEmitter.removeAllListeners()
                if (viewOption.eventHandler) {
                    viewOption.eventHandler(new Hanlder(currentStatus.instance, currentStatus.eventEmitter))
                }
                // 面板仍在创建中：等它自己 init，不要在这里丢弃本次数据
                if (currentStatus.creating) {
                    return Promise.resolve(currentStatus.instance);
                }
                currentStatus.eventEmitter.emit('init')
                return Promise.resolve(currentStatus.instance);
            }
            const webviewPanel = vscode.window.createWebviewPanel(
                viewOption.type,
                viewOption.title,
                { viewColumn, preserveFocus: viewOption.preserveFocus },
                { enableScripts: true, retainContextWhenHidden: true },
            );
            const newStatus = { creating: true, instance: webviewPanel, eventEmitter: new EventEmitter() }
            this.viewStatu[viewOption.type] = newStatus
            const targetPath = `${this.webviewPath}/${viewOption.path}.html`;
            fs.readFile(targetPath, 'utf8', async (err, data) => {
                if (err) {
                    Console.log(err);
                    reject(err);
                    return;
                }
                if (viewOption.iconPath) {
                    if(viewOption.iconPath instanceof Object){
                        webviewPanel.iconPath = viewOption.iconPath
                    }else{
                        webviewPanel.iconPath =vscode.Uri.file(viewOption.iconPath) 
                    }
                }
                const contextPath = path.resolve(targetPath, "..");
                if (viewOption.handleHtml) {
                    data = viewOption.handleHtml(data, webviewPanel)
                }
                webviewPanel.webview.html = this.buildPath(data, webviewPanel.webview, contextPath);

                // 让结果面板停在下方：先把它移到新的编辑器组，再执行分栏命令
                if (viewOption.openBelow) {
                    this.movePanelBelow(webviewPanel);
                }

                webviewPanel.onDidDispose(() => {
                    this.viewStatu[viewOption.type] = null
                })
                if (viewOption.eventHandler) {
                    viewOption.eventHandler(new Hanlder(webviewPanel, newStatus.eventEmitter))
                }
                webviewPanel.webview.onDidReceiveMessage((message) => {
                    if (message.type == 'init') {
                        if (newStatus.creating) {
                            newStatus.eventEmitter.emit(message.type, message.content)
                            newStatus.creating = false
                        }
                    } else {
                        newStatus.eventEmitter.emit(message.type, message.content)
                    }
                })
                resolve(webviewPanel);
            });

        });

    }

    private static buildPath(data: string, webview: vscode.Webview, contextPath: string): string {
        return data.replace(/((src|href)=("|'))(.+?\.(css|js))\b/gi, "$1" + webview.asWebviewUri(vscode.Uri.file(`${contextPath}`)) + "/$4");
    }

    /**
     * 把面板移动到下方新建的编辑器组，形成"上 SQL、下结果"的布局。
     * VS Code 没有直接创建下方分栏的 API，只能借内置命令完成：
     * 先让面板成为活动编辑器，再执行 moveEditorToBelowGroup，最后把焦点还给编辑器。
     */
    private static movePanelBelow(panel: WebviewPanel) {
        setTimeout(async () => {
            try {
                if (!panel.visible) { return }
                const commands = await vscode.commands.getCommands(true);
                const moveCmd = 'workbench.action.moveEditorToBelowGroup';
                if (commands.indexOf(moveCmd) < 0) { return }

                // 记住原来聚焦的文本编辑器，移动完把焦点还回去
                const previousEditor = vscode.window.activeTextEditor;
                // 让面板成为活动编辑器，否则移动命令会作用在 SQL 文件上
                panel.reveal(panel.viewColumn, false);
                await vscode.commands.executeCommand(moveCmd);
                if (previousEditor) {
                    await vscode.window.showTextDocument(previousEditor.document, {
                        viewColumn: previousEditor.viewColumn,
                        preserveFocus: false,
                        selection: previousEditor.selection,
                    });
                }
            } catch (error) {
                Console.log(error);
            }
        }, 80);
    }


}
