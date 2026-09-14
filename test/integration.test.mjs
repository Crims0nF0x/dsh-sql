/**
 * 真实数据库集成测试（可选）。
 *
 * 单元测试用假服务端验证协议行为，这里补上「真实服务端」的一半：PostgreSQL 的扩展协议
 * 到底会不会拒绝多语句、int8 到底以什么类型返回、MySQL 的 BIGINT 会不会丢精度。
 *
 * 未设置环境变量时整组跳过，`pnpm test` 在无数据库环境仍然全绿：
 *
 *   docker run -d --name dsh-pg -e POSTGRES_USER=testuser -e POSTGRES_PASSWORD=testpw \
 *     -e POSTGRES_DB=testdb -p 15432:5432 postgres:16-alpine
 *   docker run -d --name dsh-my -e MYSQL_ROOT_PASSWORD=rootpw -e MYSQL_DATABASE=testdb \
 *     -e MYSQL_USER=testuser -e MYSQL_PASSWORD=testpw -p 13307:3306 mysql:8.0
 *
 *   DSH_SQL_TEST_PG=postgres://testuser:testpw@127.0.0.1:15432/testdb \
 *   DSH_SQL_TEST_MYSQL=mysql://testuser:testpw@127.0.0.1:13307/testdb \
 *   node --test test/integration.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSqlTools, createAdapter, resolveConfig } from '../lib/index.js'

/** 把连接 URL 转成插件连接配置。 */
function fromUrl(name, engine, url) {
  const parsed = new URL(url)
  return {
    name,
    engine,
    host: parsed.hostname,
    port: parsed.port === '' ? undefined : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  }
}

const PG_URL = process.env.DSH_SQL_TEST_PG
const MY_URL = process.env.DSH_SQL_TEST_MYSQL
const skipPg = PG_URL === undefined ? 'DSH_SQL_TEST_PG 未设置' : false
const skipMy = MY_URL === undefined ? 'DSH_SQL_TEST_MYSQL 未设置' : false

const CONNECTIONS = [
  ...(PG_URL ? [fromUrl('pg', 'postgres', PG_URL)] : []),
  ...(MY_URL ? [fromUrl('my', 'mysql', MY_URL)] : []),
]

/** 修复前可通过守卫、并在真实 PostgreSQL 上真的执行了第二条语句的 payload。 */
const SMUGGLING = [
  'SELECT 1 # 2; DELETE FROM dsh_it_victim',
  "SELECT '\\'; DELETE FROM dsh_it_victim; --'",
]

function toolsFor(extra = {}) {
  return buildSqlTools(resolveConfig({ connections: CONNECTIONS, ...extra }))
}

async function seed(adapter) {
  await adapter.exec('DROP TABLE IF EXISTS dsh_it_victim')
  await adapter.exec('CREATE TABLE dsh_it_victim (id int)')
  await adapter.exec('INSERT INTO dsh_it_victim (id) VALUES (1), (2), (3)')
}

async function count(adapter) {
  const result = await adapter.query('SELECT COUNT(*) FROM dsh_it_victim', 1)
  return Number(result.rows[0][0])
}

test('PostgreSQL：分号走私被守卫拒绝，且服务端本身拒绝多语句', { skip: skipPg }, async () => {
  const connection = fromUrl('pg', 'postgres', PG_URL)
  const adapter = createAdapter(connection)
  const { tools, adapters } = toolsFor()
  const query = tools.find((t) => t.name === 'sql_query')
  try {
    await seed(adapter)
    for (const sql of SMUGGLING) {
      await assert.rejects(() => query.execute({ sql, connection: 'pg' }), /一条语句/, sql)
    }
    assert.equal(await count(adapter), 3, 'payload 不应改动数据')
    // 绕过客户端守卫直连适配器：这一半必须由服务端挡住（扩展协议）
    await assert.rejects(
      () => adapter.query('SELECT 1; DELETE FROM dsh_it_victim', 10),
      /cannot insert multiple commands/,
    )
    assert.equal(await count(adapter), 3, '服务端拒绝后数据必须完好')
  } finally {
    await adapter.exec('DROP TABLE IF EXISTS dsh_it_victim').catch(() => {})
    await adapter.close()
    for (const a of adapters.values()) await a.close()
  }
})

test('PostgreSQL：int8 安全整数返回 number，超出返回字符串', { skip: skipPg }, async () => {
  const adapter = createAdapter(fromUrl('pg', 'postgres', PG_URL))
  try {
    const small = await adapter.query('SELECT 42::bigint', 1)
    assert.equal(typeof small.rows[0][0], 'number')
    assert.equal(small.rows[0][0], 42)
    const huge = await adapter.query('SELECT 9223372036854775807::bigint', 1)
    assert.equal(huge.rows[0][0], '9223372036854775807', '不能静默丢精度')
  } finally {
    await adapter.close()
  }
})

test('MySQL：BIGINT 不丢精度，多语句被驱动拒绝', { skip: skipMy }, async () => {
  const connection = fromUrl('my', 'mysql', MY_URL)
  const adapter = createAdapter(connection)
  try {
    await seed(adapter)
    const small = await adapter.query('SELECT CAST(42 AS SIGNED)', 1)
    assert.equal(small.rows[0][0], 42)
    const huge = await adapter.query('SELECT CAST(9223372036854775807 AS SIGNED)', 1)
    assert.equal(huge.rows[0][0], '9223372036854775807', '默认配置会读成 ...776000')
    await assert.rejects(() => adapter.query('SELECT 1; DELETE FROM dsh_it_victim', 10))
    assert.equal(await count(adapter), 3)
    // 不产生结果集的语句（ResultSetHeader 而非行数组）不能把读路径打崩
    const noResultSet = await adapter.query('SELECT 1 INTO @dsh_it_probe')
    assert.equal(noResultSet.rows.length, 0)
  } finally {
    await adapter.exec('DROP TABLE IF EXISTS dsh_it_victim').catch(() => {})
    await adapter.close()
  }
})

test('SQLite：读路径写语句被 query_only 拒绝且状态会复位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-it-'))
  const adapter = createAdapter({ name: 'lite', engine: 'sqlite', file: join(dir, 'it.db') })
  try {
    await seed(adapter)
    await assert.rejects(() => adapter.query('DELETE FROM dsh_it_victim'), /readonly database/i)
    assert.equal(await count(adapter), 3)
    await adapter.exec('INSERT INTO dsh_it_victim (id) VALUES (4)')
    assert.equal(await count(adapter), 4, 'query_only 必须在 finally 里复位')
  } finally {
    await adapter.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实连接下的六工具基本往返', { skip: skipPg && skipMy }, async () => {
  const { tools, adapters } = toolsFor({ maxRows: 2 })
  try {
    const list = await tools.find((t) => t.name === 'sql_list').execute({}, {})
    assert.equal(list.connections.length, CONNECTIONS.length)
    for (const connection of CONNECTIONS) {
      const health = await tools.find((t) => t.name === 'sql_health').execute({ connection: connection.name }, {})
      assert.equal(health.ok, true, connection.name + ' 应连通')
      const exec = await tools.find((t) => t.name === 'sql_exec')
      await exec.execute({ sql: 'DROP TABLE IF EXISTS dsh_it_round', connection: connection.name }, {})
      await exec.execute({ sql: 'CREATE TABLE dsh_it_round (a int)', connection: connection.name }, {})
      const insert = await exec.execute({ sql: 'INSERT INTO dsh_it_round (a) VALUES (1), (2), (3)', connection: connection.name }, {})
      assert.equal(insert.changes, 3)
      const schema = await tools.find((t) => t.name === 'sql_schema').execute({ connection: connection.name, table: 'dsh_it_round' }, {})
      assert.equal(schema.columns.length, 1)
      const query = await tools.find((t) => t.name === 'sql_query').execute({ sql: 'SELECT * FROM dsh_it_round ORDER BY a', connection: connection.name }, {})
      assert.equal(query.rows.length, 2, 'maxRows=2 应截断')
      assert.equal(query.truncated, true)
      const csv = await tools.find((t) => t.name === 'sql_query').execute({ sql: 'SELECT * FROM dsh_it_round ORDER BY a', connection: connection.name, format: 'csv' }, {})
      assert.match(csv.formatted, /^a\n1\n2/)
      await exec.execute({ sql: 'DROP TABLE dsh_it_round', connection: connection.name }, {})
    }
  } finally {
    for (const a of adapters.values()) await a.close()
  }
})
