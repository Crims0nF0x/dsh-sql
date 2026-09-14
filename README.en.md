[中文](README.md)

# dsh-sql

> **Your agent can query databases now**: SQLite / MySQL / PostgreSQL engines, read-only whitelist + write approval gate.

DSH (DeepSeek Harness) engineer-grade database plugin: six tools covering connection management, read-only queries, write operations, schema introspection, database statistics, and health checks.

![npm version](https://img.shields.io/npm/v/dsh-sql?label=npm&color=blue) ![npm downloads](https://img.shields.io/npm/dm/dsh-sql) ![license](https://img.shields.io/npm/l/dsh-sql) ![stars](https://img.shields.io/github/stars/STARDUSTLC666/dsh-sql?style=social)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## Compatibility

Verified with official `@deepseek-ai/dsh@0.1.5-rc.1` and Node `24.16.0` on 2026-09-11: all 18 components load alongside Modlens, with passing tool-schema, skill-registration and offline read-only invocation checks. Uses the `cordis.patch.yml` + `dsh.bundle.patch` bundle model. Node requirements match this Harness release: 22.19 or later within 22.x, or 24 or later. Live external-service workflows require separate configuration and validation.

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

With no connection configuration, the plugin provides a `:memory:` SQLite connection. If configuration is present but invalid, the plugin fails to load with the validation error instead of silently falling back to the in-memory database.

## Tools

| Tool | Purpose | Safety |
| :-- | :-- | :-- |
| `sql_list` | List connections + connectivity test | — |
| `sql_query` | Read-only queries (SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH) | Per-engine lexer + engine-enforced single statement |
| `sql_exec` | Writes / DDL (SQLite supports multi-statement scripts) | readOnly lock + approval gate |
| `sql_schema` | Table list / table structure | Identifier whitelist validation |
| `sql_stats` | Table counts, row estimates, and database size | Quoted identifiers + isolated query failures |
| `sql_health` | Connection and safety-configuration checks | Per-connection probe; passwords are never returned |

### Examples

```text
sql_list {}
sql_schema {}                                  # list all tables
sql_schema { table: users }                    # inspect the users table
sql_stats {}                                   # inspect the default connection's data size
sql_health {}                                  # check connections and safety settings
sql_query { sql: SELECT * FROM orders WHERE status = 'pending' LIMIT 50 }
sql_exec { sql: UPDATE orders SET status = 'paid' WHERE id = 42 }
```

## Safety

- **Per-engine lexer-grade read-only guard**: sql_query strips strings/comments using the **target engine's real lexical rules** before validation (only MySQL honours backslash escapes and `#` comments, only PostgreSQL honours `$tag$`; MySQL's executable `/*!…*/` comments are scanned as code instead of being discarded), then rejects data-modifying CTEs (WITH…DELETE/UPDATE), SELECT INTO, FOR UPDATE/FOR SHARE, PRAGMA assignment and parenthesised writes (`PRAGMA journal_mode(WAL)`), write-capable PRAGMAs (`optimize`, `wal_checkpoint`, …), and multi-statement input
- **Engine-level backstop** (a second layer beyond the lexer): PostgreSQL reads use the extended query protocol (Parse/Bind/Execute), so multi-statement input is rejected server-side with `cannot insert multiple commands into a prepared statement`; SQLite reads run inside `PRAGMA query_only`, so data-changing statements are refused by the database itself; the MySQL driver keeps `multipleStatements: false`
- **Write approval gate**: sql_exec asks for approval by default (mirroring dsh-email's send approval); headless environments without an approval channel are denied
- **Boundary of the approval gate**: approval can only be expressed as an `ask` decision on `tools/pre-execute` (Harness monotonic guards have no ask semantics), and that waterfall short-circuits — a third-party plugin registered **earlier** that returns `allow` without calling `next()` skips this approval. That is a Harness-level property this plugin cannot remove, so purely denying constraints such as readOnly are additionally expressed with `ctx.tools.guard()` (monotonic: deny-only, ordering cannot turn it back into permission)
- **readOnly mode**: lock out writes entirely for production databases
- **Streaming row cap**: SQLite iterators, MySQL Readables, and PostgreSQL Query row events collect at most maxRows+1 rows and flag overflow with truncated. MySQL and PostgreSQL close the query's dedicated connection at the cap; smaller results return the connection to the pool, without materializing the full result in memory
- **Cancellation-aware execution**: queries and writes observe Harness `exec.signal`; cancellation stops waiting and destroys the active dedicated MySQL/PostgreSQL connection
- **Lossless large integers**: bigint values within JavaScript's safe integer range are returned as numbers; larger values are returned as decimal strings instead of silently losing precision
- **Identifier validation**: table names restricted to alphanumerics and underscores — no schema injection
- **Secrets stay out of config**: passwords via `DSH_SQL_PASSWORD_<CONNECTION>` env vars

## Engines

- **SQLite**: built-in `node:sqlite` (Node 22.13+), zero dependencies
- **MySQL**: mysql2 pool
- **PostgreSQL**: pg pool

## Development

```bash
pnpm install
pnpm test       # build + full test suite, including a real SQLite integration suite
```

## License

MIT
