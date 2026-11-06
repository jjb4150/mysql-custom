# Changelog

本文件记录 MySQL Custom 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本项目基于 [cweijan/vscode-database-client](https://github.com/cweijan/vscode-database-client)
> 的最后一个 MIT 版本 **v3.9.8** 二次开发，但**版本号独立起算，不沿用上游的 3.x 序列**。
> 上游 2021 年及更早的更新记录与本项目无关，不再收录。

## [0.1.0] - 2026-11-06

首个发布版本。定位为**只做 MySQL / MariaDB** 的数据库客户端。

### 新增

**多语句执行**

- 多条语句**逐条串行执行**，每条语句的结果各自成为一个结果 tab（此前会把整段当作一条发送，或只回显一句 `EXECUTE SUCCESS` 而丢失数据）
- 识别 `DELIMITER`，存储过程中的 `BEGIN ... END` 不会被分号拆碎
- 分句时跳过字符串、反引号标识符、`--` / `#` / `/* */` 三种注释内部的分号
- 漏写结尾分号时按行尾保守断句（4 条防误拆规则）
- 遇到首个错误即停止，行为与 `mysql` 命令行一致；**已成功语句的结果保留为 tab**，不会一起丢掉

**错误定位**

- MySQL 报错自动换算成 SQL 编辑器中的对应行，打原生 diagnostic 标记，可用 `F8` 跳转
- 结果面板底部显示一行错误摘要，并提供「跳到出错行」链接
- 下一次执行成功时自动清除旧标记

**结果页**

- Excel 式选区：拖动框选、`Shift` 扩展、`Ctrl` 追加离散单元格
- `Ctrl` + 双击列头，把该列整体追加到选区
- 双击单元格就地编辑，编辑态为单行内联（`HOME` / `END` 定位整条内容首尾）
- 双击时按点击位置自由定位光标、拖动圈选，不再强制全选
- 单元格内容溢出「查看」按钮按**实际** `scrollWidth/Height` 判定，不再用硬编码字符数阈值
- 列头显示字段名 + 注释 + 类型，带主键 / 非空标记

**国际化**

- 结果页中英双语，58 条词条，无 `vue-i18n` 运行时依赖
- 语言来源优先级：扩展侧注入的 `vscode.env.language` → `<html lang>` → `navigator.language`
- Element UI 自带 locale 随语言同步切换

**其他**

- 打 tag 自动发布到 Marketplace 并创建 Release（GitHub Actions）
- `docs/RELEASING.md`：完整的发布与验证流程

### 变更

- 成功执行时**不显示任何提示框**，直接出数据（原行为会弹一个大框回显 `EXECUTE SUCCESS`）
- 结果页配色收拢到 `src/vue/result/tokens.css` 的语义变量，全部走 VS Code 主题变量 + 兜底值
- `repository` / `homepage` / `bugs` 指向本项目仓库

### 移除

**非 MySQL 模块（194 个文件、15,778 行）**

- ElasticSearch 支持（含 119 个 REST spec JSON）
- Redis 支持（含 xterm 终端界面）
- MongoDB 支持
- FTP / SFTP 支持
- Exasol 支持
- 表结构对比（`structDiff`）与数据 mock
- SSH 独立连接类型、端口转发界面

> **SSH 隧道本身保留**：`src/service/tunnel/`、连接页的「SSH Tunnel」开关、`ssh2` 依赖均未改动，
> 删除的只是「把 SSH 当作一种连接类型」和 xterm 端口转发面板。

**连带清理**

- 视图容器 `github-junbiaojin-nosql`，以及 17 条相关命令、23 条相关菜单
- `DatabaseType` 从 10 个取值收缩到 4 个（MySQL / PostgreSQL / SQL Server / SQLite）
- `sqlite/sqlite-v3.26.0-win32-x86.exe`（890 KB 的未签名 Windows 可执行文件）
- 上游 README 的 9 处截图与文档链接、`image/` 目录
- README 中关于「会收集匿名使用数据」的声明（遥测代码实际已全部移除，保留该声明属虚假宣传）
- 打包内的 `test/**`、`sqlite/**`

**依赖**

- runtime 依赖 39 → 26（移除 `@exasol/exasol-driver-ts`、`bson`、`mongodb`、`ioredis`、`xterm` ×4、`json-format-highlight`、`ws`、`bufferutil`、`utf-8-validate`、`@types/ws`；`ssh2` 与 `pg` **保留**）
- 命令 77 → 60，nls 词条 72 → 63
- 打包体积 3.95 MB → 3.24 MB

### 修复

- **存储型 XSS**：`CellViewer` 用 `json-format-highlight` 渲染 JSON 时，该库对字符串值转义但对**键名不转义**，`{"<img src=x onerror=alert(1)>":1}` 会在查看器中执行。改为自建高亮：先整体 `escapeHtml`，再在已转义文本上叠加 `<span>`
- `Ctrl` + 双击列头无法多选（`$emit` 时丢掉了 `event`，导致 `event.ctrlKey` 恒为 false）
- `.info-panel` 硬编码浅色主题颜色（`#444` / `#dcdfe6`），深色主题下几乎不可见
- `.el-popover__reference { background: #409EFF }` 全局泄漏，把列选择按钮染成主操作色
- `.el-button:focus` 聚焦色与工具栏同色，键盘导航看不出焦点
- `result.html` 既无 `<meta charset>` 也无 `<html lang>`，中文有乱码风险
- 设置按钮因上游缺失 `settings.svg` 而无图标
- 消息提示中 `message.indexOf` 的空指针
- 批量执行时 `refresh()` 导致 tab 错位

### 说明

- **正式支持范围是 MySQL / MariaDB**。PostgreSQL / SQL Server / SQLite 的实现予以保留（与 MySQL 共用同一套 dialect、分页与结果页），连接界面也仍可选这四项，但后三者的测试覆盖远不如 MySQL，属于「能用但不保证」。删除它们需要改动 70 处 `switch (dbType)` 分支，风险大于收益，且残留的分支会退化成隐式 fallback
- **SSH 隧道保留**：`ssh2` 依赖、`src/service/tunnel/`、连接页的 SSH 隧道配置均未改动。SSH 隧道连 MySQL 是常见生产场景
- 配置项前缀保持 `database-client.*` 不变，以免已有用户的设置失效

[0.1.0]: https://github.com/jjb4150/mysql-custom/releases/tag/v0.1.0