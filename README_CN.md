# MySQL Custom

一个专注于 **MySQL / MariaDB** 的 VS Code 扩展，核心目标只有一个：让**超大、超复杂的 SQL 文件**读起来、跳起来、改起来舒服。

> 本项目是基于 [cweijan/vscode-database-client](https://github.com/cweijan/vscode-database-client) **v3.9.8**（MIT 协议，Copyright 2019-2021 Weijan Chen）的二次开发版。见[开源协议](#开源协议)。

---

## 为什么做这个

上游从 v4.7.0 起闭源。本项目以最后一个 MIT 版本（3.9.8）为基底——该版本**没有任何付费校验**——并针对一套真实的代码库做了定向改进：

- **1,093 个 MyBatis Mapper.xml、3,649 条 SQL**
- 平均长度 **568 字符**；最长 **19,419 字符、44 个 JOIN**；单条最多 **64 个 JOIN**
- 约 1/3 的语句有 JOIN，20.4% 用 GROUP BY，8.1% 用 FROM 子查询，31 条用 CTE（其中 13 条递归），56 条用窗口函数

下面所有能力都是照这个场景调出来的，不是拿玩具 SQL 试的。

## 功能

### SQL 编辑器

| 能力 | 说明 |
|---|---|
| **文件写长后补全依然有效** | 600 行以上照样能用，不只是文件开头 |
| `from` / `join` / `update` 后补全表名 | ✅ |
| `where a.` / `select a.` / `on a.` 补全列名 | ✅（上游这里完全无反应） |
| 有表无别名时补全列名 | 回退到当前语句所有表的列 |
| 多表插入带别名的列名 | 如 `a.store_name` |
| 模糊匹配 | 输入 `ai` 命中 `g_product_ai` |
| 中文表名 / 列名 | ✅ |
| CTE 别名（`WITH x AS (...)`） | 递归用显式列名，非递归从 SELECT 推导 |
| 派生表别名（`FROM (...) t1`） | 从内部 SELECT 推导列 |
| 关键字 / 函数补全 | 170+ 关键字、130+ 函数；函数只匹配后跟 `(` 的 |
| 排序分层 | 列(0) > 表(1) > 函数(2) > 关键字(3) |
| 长 JOIN 性能保护 | 最多取前 12 张表，并发 4 |

### 跳转

- **Ctrl+点表名** → 打开 DDL
- **Ctrl+点别名** → 解析到真实表
- **Ctrl+点 `别名.字段`** → 打开 DDL 并定位到该字段那一行
- **Ctrl+点裸字段** → 在当前语句各表里逐个找
- 大小写不敏感

### 结果页

- **Excel 式选区**：单击、拖动、Shift 扩展、`Ctrl` 追加离散单元格、`Ctrl+A`、`Ctrl+C` 复制 TSV
- **双击列头**选中整列；**Ctrl+双击**另一个列头可**追加**选中（离散多列，中间列不会被选进来）
- 双击单元格编辑，`Ctrl+S` 保存
- 列头两行显示**字段名 + 注释 + 类型**，带主键 / 非空标记
- 长内容查看器（JSON 自动美化）
- 按连接配置的首查 `LIMIT`（自动分页），`COUNT` 按需统计

### 执行

- **多语句脚本逐条执行**
  - 每条语句的结果各成一个 tab
  - 遇到首个错误即停止（与 `mysql` 命令行一致），**已成功的语句结果保留**
  - 失败时：结果面板底部红字 + SQL 编辑器对应行红波浪线 + **跳到出错行**链接
  - 成功时：**不显示任何提示**，直接出数据
- 识别 `DELIMITER`，`CREATE PROCEDURE ... BEGIN ... END` 不会被拆碎
- 字符串、反引号、三种 MySQL 注释里的分号不参与分句
- 漏写分号时按保守规则断句（四条防误拆规则）

### SQL 语法高亮

语法定义从「按关键字硬匹配」重写为「按 SQL 结构分层」：

| 元素 | scope |
|---|---|
| 表名（`CREATE TABLE` / `FROM` / `JOIN` / `UPDATE` / `ALTER TABLE`） | `entity.name.type.sql` |
| 列名、别名、字段 | `entity.name.variable.sql` |
| SQL 关键字 | `keyword.control.sql` |
| 数据类型 | `storage.modifier.sql` |
| DDL 约束（`NOT NULL` / `DEFAULT` / `COMMENT` / `KEY` / `ENGINE` / `CHARSET` …） | `entity.name.label.sql` |
| 函数 | `entity.name.function.sql`（130+，仅匹配后跟 `(` 的） |
| 注释 | `--`、`#`、`/* */` |

已用六个内置主题做配色交叉验证：`Dark 2026` / `Dark Modern` / `Light 2026` / `Light Modern` 下红色占比均为 **0%**。刻意避开 `keyword.*` 与 `storage.type.*`——VS Code 1.145 的默认深色主题下这两类是红色。

## 支持的数据库

正式支持 **MySQL / MariaDB**。`PostgreSQL`、`SQL Server`、`SQLite` 的连接代码保留着，但**不是重点**，测试覆盖也不如 MySQL。

不含 Redis、Elasticsearch、MongoDB、FTP 或 SSH 客户端功能。（数据库连接的 SSH **隧道**是支持的。）

## 快速开始

1. 打开左侧 **Database** 面板
2. 点 **+**，选 **MySQL**，填主机 / 端口 / 用户 / 密码
3. 库只在内网可达时，打开 **SSH Tunnel**
4. 点表名浏览数据，或点 **Open Query** 写绑定该连接的 SQL

## 配置

常用项（前缀统一为 `database-client.`，与上游扩展保持兼容）：

| 配置 | 默认 | 作用 |
|---|---|---|
| `database-client.defaultSelectLimit` | `100` | 首查自动追加的 `LIMIT` |
| `database-client.autoPagingSQL` | `true` | 是否启用自动分页 |
| `database-client.resultBelowEditor` | `true` | 结果面板在编辑器下方（否则侧边分栏） |
| `database-client.showColumnComment` | `true` | 列头是否显示字段注释 |

## 隐私

**无遥测。除连接你指定的数据库外，不发起任何网络请求。**

上游 README 曾声明会收集匿名使用数据。本版本**不含该代码**，相关声明已删除。不存在需要关闭的 `database-client.telemetry.*` 行为，因为没有任何东西在收集。

## 已知限制

- **AnalyticDB** 连接报 `[13000] Illegal database ''`。ADB 疑似要求连接时必须指定库名，未验证。
- 超大表 Excel 导出仍可能 OOM（`node-xlsx` 必须全量在内存里构建）。
- 没有「双击列头边框自动适配列宽」（AG Grid 有）。
- 没有连接池——与 `USE` 语义冲突。

## 开源协议

MIT。原始作品 Copyright (c) 2019-2021 Weijan Chen，修改部分 Copyright (c) 2026 junbiaojin。

```
This product is a derivative work based on cweijan/vscode-database-client version 3.9.8
```

完整协议见 [LICENSE](LICENSE)。