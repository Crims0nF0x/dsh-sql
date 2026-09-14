[English](README.en.md)

# dsh-sql

> **你的 agent 会查库了**：SQLite / MySQL / PostgreSQL 三引擎，只读白名单 + 写审批门。

DSH（DeepSeek Harness）工程师级数据库插件：六个工具覆盖连接管理、只读查询、写操作、结构探查、统计概览与健康自检。

![npm version](https://img.shields.io/npm/v/dsh-sql?label=npm&color=blue) ![npm downloads](https://img.shields.io/npm/dm/dsh-sql) ![license](https://img.shields.io/npm/l/dsh-sql) ![stars](https://img.shields.io/github/stars/STARDUSTLC666/dsh-sql?style=social)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## 兼容性

已在官方 `@deepseek-ai/dsh@0.1.5-rc.1`、Node `24.16.0` 上验证（2026-09-11）：18 个组件与 Modlens 同载，工具 schema、技能注册及离线只读调用检查通过。采用 `cordis.patch.yml` + `dsh.bundle.patch` 组合包模型。Node 要求与该版本 Harness 一致：22.19 及以上的 22.x，或 24 及以上。外部服务的实际业务操作需按各组件配置单独验证。

## 安装

```bash
dsh plugin --profile web add dsh-sql
```

## 卸载

```bash
dsh plugin --profile web remove dsh-sql
```

卸载后重启 Web 服务。如需彻底清理，可再手动删除自己 profile `cordis.patch.yml` 中覆盖的插件行。


## 配置

```yaml
- id: sql
  name: 'dsh-sql'
  config:
    connections:
      - name: local
        engine: sqlite
        file: E:\data\app.db          # 或 :memory:
      - name: prod
        engine: postgres
        host: db.internal
        database: app
        # password: xxx              # 推荐环境变量 DSH_SQL_PASSWORD_PROD
      - name: legacy
        engine: mysql
        host: 127.0.0.1
        port: 3306
        user: root
        database: legacy
    maxRows: 1000                     # 查询返回行数上限（1-10000）
    queryTimeoutMs: 60000             # 单次查询超时（默认 60 秒，5 秒 - 10 分钟）
    execTimeoutMs: 120000             # 单次写操作超时（默认 120 秒，5 秒 - 10 分钟）
    readOnly: false                   # true 时禁用 sql_exec
    writeApproval: true               # 写操作先弹审批（默认 true）
```

配置缺省时会提供一个 `:memory:` SQLite 连接；配置一旦给出但格式无效，插件会直接报错并停止加载，不会静默回退到内存库。

## 工具一览

| 工具 | 作用 | 安全 |
| :-- | :-- | :-- |
| `sql_list` | 列出连接 + 连通性测试 | — |
| `sql_query` | 只读查询（SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH）| 逐引擎词法校验 + 引擎级单语句强制 |
| `sql_exec` | 写操作/DDL（SQLite 支持多语句脚本）| readOnly 禁用 + 审批门 |
| `sql_schema` | 表清单 / 表结构 | 标识符白名单校验 |
| `sql_stats` | 表数量、行数与库体积概览 | 表名引用 + 查询失败隔离 |
| `sql_health` | 连接与安全配置自检 | 逐连接探活，不回显密码 |

### 示例

```text
sql_list {}
sql_schema {}                                  # 列出所有表
sql_schema { table: users }                    # 看 users 表结构
sql_stats {}                                   # 查看默认连接的数据规模
sql_health {}                                  # 检查连接和安全配置
sql_query { sql: SELECT * FROM orders WHERE status = 'pending' LIMIT 50 }
sql_exec { sql: UPDATE orders SET status = 'paid' WHERE id = 42 }
```

## 安全设计

- **逐引擎词法只读保护**：sql_query 按**目标引擎的真实词法**剥离字符串/注释后再校验（只有 MySQL 认反斜杠转义与 `#` 注释，只有 PostgreSQL 认 `$tag$`；MySQL 的 `/*!…*/` 可执行注释按代码扫描而不是当注释丢弃），拒绝 data-modifying CTE（WITH…DELETE/UPDATE）、SELECT INTO、FOR UPDATE/FOR SHARE、PRAGMA 赋值与括号写形式（`PRAGMA journal_mode(WAL)`）、写型 PRAGMA（`optimize` / `wal_checkpoint` 等）与多语句
- **引擎级兜底**（词法之外的第二道）：PostgreSQL 读查询走扩展协议（Parse/Bind/Execute），多语句由服务端报 `cannot insert multiple commands into a prepared statement` 拒绝；SQLite 读路径整段包在 `PRAGMA query_only` 里，改数据的语句由数据库自己拒绝；MySQL 驱动保持 `multipleStatements: false`
- **写审批门**：sql_exec 默认弹审批（对齐 dsh-email 的发信审批），headless 环境无审批通道时拒绝执行
- **审批门的边界**：审批只能用 `tools/pre-execute` 的 `ask` 决策表达（Harness 的单调 guard 没有 ask 语义），而 waterfall 是顺序短路 —— 若**更早注册**的第三方插件不调 `next()` 直接返回 allow，本审批会被跳过。这是 Harness 层面的性质、插件侧消除不了，因此 readOnly 这类纯拒绝约束用 `ctx.tools.guard()`（单调、只能拒绝、排序无法翻回放行）表达
- **readOnly 模式**：生产库可整体禁用写
- **流式行数钳制**：SQLite 迭代器 / MySQL Readable / PostgreSQL Query 行事件最多收集 maxRows+1 行，超量标记 truncated；MySQL 和 PostgreSQL 在达到上限时关闭该查询的专用连接，未达上限则正常归还连接池，避免全量结果驻留内存
- **可取消执行**：查询与写操作遵守 Harness 的 `exec.signal`；取消时会中止等待并销毁正在工作的 MySQL/PostgreSQL 专用连接
- **大整数无损**：数据库返回的 bigint 在 JavaScript 安全整数范围内输出 number，超出范围则输出十进制字符串，避免静默丢精度。PostgreSQL 侧用查询级 int8 类型解析器覆盖（pg 默认把 `42::bigint` 也返回字符串），MySQL 侧开启 `supportBigNumbers`（默认会把 `9223372036854775807` 静默读成 `9223372036854776000`）—— 两者均在真实 PostgreSQL 16 / MySQL 8.0 上验证
- **标识符校验**：表名只允许字母/数字/下划线，杜绝 schema 注入
- **密钥不落配置**：密码支持 `DSH_SQL_PASSWORD_<连接名>` 环境变量

## 引擎

- **SQLite**：Node 22.13+ 内置 `node:sqlite`，零依赖
- **MySQL**：mysql2 连接池
- **PostgreSQL**：pg 连接池

## 开发

```bash
pnpm install
pnpm test       # 构建 + 完整测试套件（含真实 SQLite 集成）
```

真实 PostgreSQL / MySQL 的集成测试默认跳过，设置环境变量后启用（Security 断言：服务端拒绝
多语句、int8/BIGINT 精度、走私 payload 被拒）：

```bash
docker run -d --name dsh-pg -e POSTGRES_USER=testuser -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_DB=testdb -p 15432:5432 postgres:16-alpine
docker run -d --name dsh-my -e MYSQL_ROOT_PASSWORD=rootpw -e MYSQL_DATABASE=testdb \
  -e MYSQL_USER=testuser -e MYSQL_PASSWORD=testpw -p 13307:3306 mysql:8.0

DSH_SQL_TEST_PG=postgres://testuser:testpw@127.0.0.1:15432/testdb \
DSH_SQL_TEST_MYSQL=mysql://testuser:testpw@127.0.0.1:13307/testdb \
node --test test/integration.test.mjs
```

## License

MIT
