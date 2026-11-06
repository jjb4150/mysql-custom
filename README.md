# MySQL Custom

A VS Code extension for **MySQL / MariaDB**, focused on one thing: making very large, very complex SQL files comfortable to read, navigate, and edit.

> This is a derivative work based on [cweijan/vscode-database-client](https://github.com/cweijan/vscode-database-client) **v3.9.8** (MIT licensed, Copyright 2019-2021 Weijan Chen). See [License](#license).

---

## Why this exists

The upstream project went closed-source from v4.7.0. This build starts from the last MIT release (3.9.8) — which has **no paid gating** — and adds a set of targeted improvements driven by a real codebase:

- **1,093 MyBatis Mapper.xml files, 3,649 SQL statements**
- Average length **568 characters**; longest **19,419 characters** with **44 JOINs**; max **64 JOINs** in one statement
- ~1/3 of statements use JOIN, 20.4% use GROUP BY, 8.1% use derived tables, 31 use CTEs (13 recursive), 56 use window functions

Everything below was tuned against that workload, not against toy queries.

## Features

### SQL editor

| Feature | Notes |
|---|---|
| **IntelliSense that survives long files** | Works at line 600+ of a large file, not just at the top |
| Table completion after `from` / `join` / `update` | ✅ |
| Column completion for `where a.`, `select a.`, `on a.` | ✅ (upstream returned nothing here) |
| Column completion without an alias | Falls back to all tables in the current statement |
| Auto-qualified insert (`a.store_name`) | When more than one table is in scope |
| Fuzzy matching | `ai` matches `g_product_ai` |
| Chinese table / column names | ✅ |
| CTE aliases (`WITH x AS (...)`) | Recursive CTEs use explicit column list; non-recursive derive from SELECT |
| Derived table aliases (`FROM (...) t1`) | Columns inferred from the inner SELECT |
| Keyword & function completion | ~170 keywords, 130+ functions; functions only match when followed by `(` |
| Ranking | column (0) > table (1) > function (2) > keyword (3) |
| Long-JOIN guard | Caps at 12 tables, concurrency 4 |

### Navigation

- **Ctrl+Click a table** → opens its DDL
- **Ctrl+Click an alias** → resolves to the real table
- **Ctrl+Click `alias.column`** → opens the DDL and jumps to that column's line
- **Ctrl+Click a bare column** → searches every table in the statement
- Case-insensitive

### Result grid

- **Excel-style selection**: click, drag, Shift to extend, `Ctrl` to add disjoint cells, `Ctrl+A`, `Ctrl+C` as TSV
- **Double-click a column header** to select the whole column; **Ctrl+double-click** another header to add it to the selection (disjoint columns, intermediate columns stay unselected)
- Double-click a cell to edit; `Ctrl+S` to save
- Column headers show **field name + comment + type**, with PK and NOT NULL markers
- Long values get a viewer with pretty-printed JSON
- Per-connection default `LIMIT` (auto-paging), on-demand `COUNT`

### Execution

- **Multi-statement scripts run statement by statement**
  - Each statement gets its own result tab
  - Execution stops at the first error, matching the `mysql` CLI; results for statements that already succeeded are kept
  - Failures show a red line at the bottom of the result panel, a squiggle in the SQL editor, and a **jump to error line** link
  - On success: **nothing is shown** — the data just appears
- `DELIMITER` is honoured, so `CREATE PROCEDURE ... BEGIN ... END` is not split apart
- Semicolons inside strings, backticks, and all three MySQL comment styles are ignored by the splitter
- Missing trailing semicolons are handled conservatively (four guard rules to avoid false splits)

### SQL highlighting

The syntax definition was rewritten from a flat keyword list into structural scopes:

| Element | Scope |
|---|---|
| Table names (`CREATE TABLE` / `FROM` / `JOIN` / `UPDATE` / `ALTER TABLE`) | `entity.name.type.sql` |
| Column names, aliases, fields | `entity.name.variable.sql` |
| SQL keywords | `keyword.control.sql` |
| Data types | `storage.modifier.sql` |
| DDL constraints (`NOT NULL` / `DEFAULT` / `COMMENT` / `KEY` / `ENGINE` / `CHARSET` …) | `entity.name.label.sql` |
| Functions | `entity.name.function.sql` (130+, only when followed by `(`) |
| Comments | `--`, `#`, `/* */` |

Validated against six built-in themes with a multi-theme colour matrix: **0% red coverage** under `Dark 2026` / `Dark Modern` / `Light 2026` / `Light Modern`. `keyword.*` and `storage.type.*` are deliberately avoided because they render red under the default dark theme in VS Code 1.145.

## Supported databases

**MySQL / MariaDB** is the supported target. `PostgreSQL`, `SQL Server`, and `SQLite` connection code is retained for internal reasons but is **not the focus** and not tested as thoroughly.

No Redis, Elasticsearch, MongoDB, FTP, or SSH-client features. (SSH **tunnels** for database connections are supported.)

## Getting started

1. Open the **Database** panel in the activity bar.
2. Click **+**, pick **MySQL**, fill in host / port / user / password.
3. Use **SSH Tunnel** if the database is only reachable through a bastion.
4. Click a table to browse it, or **Open Query** to write SQL bound to that connection.

## Configuration

Common settings (all prefixed `database-client.` for compatibility with the upstream extension):

| Setting | Default | What it does |
|---|---|---|
| `database-client.defaultSelectLimit` | `100` | Auto-appended `LIMIT` for first query |
| `database-client.autoPagingSQL` | `true` | Enable auto-paging |
| `database-client.resultBelowEditor` | `true` | Result panel below the editor instead of a side split |
| `database-client.showColumnComment` | `true` | Show column comments in headers |

## Privacy

**No telemetry. No network calls except to the databases you connect to.**

The upstream README advertised anonymous usage reporting. That code is not present in this build, and that claim has been removed. There is no `database-client.telemetry.*` behaviour to opt out of because there is nothing collecting.

## Known limitations

- **AnalyticDB** connections fail with `[13000] Illegal database ''`. ADB appears to require an explicit database name at connect time; unverified.
- Excel export of very large tables can still run out of memory (`node-xlsx` must materialise the whole sheet).
- Column-header double-click-to-autofit (as in AG Grid) is not implemented.
- No connection pooling — `USE` semantics conflict with it.

## License

MIT. Original work Copyright (c) 2019-2021 Weijan Chen. Modifications Copyright (c) 2026 junbiaojin.

```
This product is a derivative work based on cweijan/vscode-database-client version 3.9.8
```

See [LICENSE](LICENSE) for the full text.