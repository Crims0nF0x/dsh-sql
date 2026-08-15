[中文](README.md)

# dsh-sql

> **Your agent can query databases now**: SQLite / MySQL / PostgreSQL engines, read-only whitelist + write approval gate.

DSH (DeepSeek Harness) engineer-grade database plugin: four tools covering connection management, read-only queries, write operations, and schema introspection.

![npm version](https://img.shields.io/npm/v/dsh-sql?label=npm&color=blue) ![npm downloads](https://img.shields.io/npm/dm/dsh-sql) ![license](https://img.shields.io/npm/l/dsh-sql) ![stars](https://img.shields.io/github/stars/STARDUSTLC666/dsh-sql?style=social)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## Installation

```bash
dsh plugin --profile web add dsh-sql
```

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

- **Read-only whitelist**: sql_query only allows SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH; multi-statement queries are rejected outright
- **Write approval gate**: sql_exec asks for approval by default (mirroring dsh-email's send approval); headless environments without an approval channel are denied
- **readOnly mode**: lock out writes entirely for production databases
- **Row clamping**: maxRows capped at 10000, overflow flagged with truncated
- **Identifier validation**: table names restricted to alphanumerics and underscores — no schema injection
- **Secrets stay out of config**: passwords via `DSH_SQL_PASSWORD_<CONNECTION>` env vars

## Engines

- **SQLite**: built-in `node:sqlite` (Node 22.13+), zero dependencies
- **MySQL**: mysql2 pool
- **PostgreSQL**: pg pool

## Development

```bash
pnpm install
pnpm test       # build + 27 tests, including a real SQLite integration suite
```

## License

MIT
