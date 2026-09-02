[中文](README.md)

# dsh-sql

> **Your agent can query databases now**: SQLite / MySQL / PostgreSQL engines, read-only whitelist + write approval gate.

DSH (DeepSeek Harness) engineer-grade database plugin: four tools covering connection management, read-only queries, write operations, and schema introspection.

![npm version](https://img.shields.io/npm/v/dsh-sql?label=npm&color=blue) ![npm downloads](https://img.shields.io/npm/dm/dsh-sql) ![license](https://img.shields.io/npm/l/dsh-sql) ![stars](https://img.shields.io/github/stars/STARDUSTLC666/dsh-sql?style=social)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## Compatibility

Verified against source-run `@deepseek-ai/dsh@0.1.2-alpha.4` on 2026-09-02. Built for the cordis patch-bundle plugin model (`cordis.patch.yml` + `dsh.bundle.patch`). No runtime imports of `@deepseek-ai/*` internals.

## Installation

```bash
dsh plugin --profile web add dsh-sql
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-sql
```

Then restart the web service. To clean up fully, also remove the plugin entry from your profile `cordis.patch.yml` if you overrode it.


## Configuration

```yaml
- id: sql
  name: 'dsh-sql'
  config:
    connections:
      - name: local
        engine: sqlite
        file: E:\data\app.db          # or :memory:
      - name: prod
        engine: postgres
        host: db.internal
        database: app
        # password: xxx              # prefer env var DSH_SQL_PASSWORD_PROD
      - name: legacy
        engine: mysql
        host: 127.0.0.1
        port: 3306
        user: root
        database: legacy
    maxRows: 1000                     # query row cap (1-10000)
    queryTimeoutMs: 60000             # per-query timeout (default 60s, 5s - 10min)
    execTimeoutMs: 120000             # per-write timeout (default 120s, 5s - 10min)
    readOnly: false                   # true disables sql_exec
    writeApproval: true               # approve write operations first (default true)
```

## Tools

| Tool | Purpose | Safety |
| :-- | :-- | :-- |
| `sql_list` | List connections + connectivity test | — |
| `sql_query` | Read-only queries (SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH) | Keyword whitelist + rejects multi-statement |
| `sql_exec` | Writes / DDL (multi-statement scripts allowed) | readOnly lock + approval gate |
| `sql_schema` | Table list / table structure | Identifier whitelist validation |

### Examples

```text
sql_list {}
sql_schema {}                                  # list all tables
sql_schema { table: users }                    # inspect the users table
sql_query { sql: SELECT * FROM orders WHERE status = 'pending' LIMIT 50 }
sql_exec { sql: UPDATE orders SET status = 'paid' WHERE id = 42 }
```

## Safety

- **Lexer-grade read-only guard**: sql_query strips strings/comments before validation, then rejects data-modifying CTEs (WITH…DELETE/UPDATE), SELECT INTO, FOR UPDATE/FOR SHARE, PRAGMA assignment, and multi-statement input
- **Write approval gate**: sql_exec asks for approval by default (mirroring dsh-email's send approval); headless environments without an approval channel are denied
- **readOnly mode**: lock out writes entirely for production databases
- **Streaming row cap**: SQLite iterator / MySQL stream / PostgreSQL portal all stop at maxRows+1, so large queries are never fully materialized; overflow is flagged with truncated
- **Identifier validation**: table names restricted to alphanumerics and underscores — no schema injection
- **Secrets stay out of config**: passwords via `DSH_SQL_PASSWORD_<CONNECTION>` env vars

## Engines

- **SQLite**: built-in `node:sqlite` (Node 22.13+), zero dependencies
- **MySQL**: mysql2 pool
- **PostgreSQL**: pg pool

## Development

```bash
pnpm install
pnpm test       # build + 35 tests, including a real SQLite integration suite
```

## License

MIT
