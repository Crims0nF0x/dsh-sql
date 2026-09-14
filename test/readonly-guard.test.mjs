/**
 * 只读守卫回归测试。
 *
 * 每个 payload 都来自一次真实审计：修复前它们能通过词法守卫并抵达数据库
 * （PostgreSQL 侧经驱动报文验证，见审计 PoC），因此这些用例是防止回归的锚点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, assertReadQuery, buildSqlTools, createAdapter, resolveConfig } from '../lib/index.js'

/** 修复前可通过 PostgreSQL 守卫的「分号走私」payload。 */
const PG_SMUGGLING = [
  ['# 被误当注释（PG 里是异或运算符）', 'SELECT 1 # 2; DELETE FROM t'],
  ['反斜杠被误当转义（PG 里 \\ 是普通字符）', "SELECT '\\'; DELETE FROM t; --'"],
  ['DROP 变体', "SELECT '\\'; DROP TABLE users; --'"],
  ['方括号标识符跨过分号', "SELECT a[1]; DELETE FROM t WHERE b = ']'"],
]

// ---------- 词法守卫：逐引擎方言 ----------

test('PostgreSQL：分号走私 payload 一律被拒', () => {
  for (const [label, sql] of PG_SMUGGLING) {
    assert.throws(() => assertReadQuery(sql, 'postgres'), /一条语句/, label + ' 应被拒绝')
  }
})

test('PostgreSQL：合法读语句不被误伤', () => {
  assert.equal(assertReadQuery('SELECT 1 # 2', 'postgres'), 'SELECT 1 # 2')
  assert.equal(assertReadQuery('SELECT $tag$; x$tag$ AS body', 'postgres'), 'SELECT $tag$; x$tag$ AS body')
  assert.equal(assertReadQuery("SELECT data #>> '{a,b}' FROM t", 'postgres'), "SELECT data #>> '{a,b}' FROM t")
  assert.equal(assertReadQuery('SELECT a[1] FROM t', 'postgres'), 'SELECT a[1] FROM t')
  assert.equal(assertReadQuery('SELECT 1 /* 普通注释 ; delete */', 'postgres'), 'SELECT 1 /* 普通注释 ; delete */')
})

test('MySQL：可执行注释 /*!...*/ 按代码扫描，不能用来走私', () => {
  assert.throws(() => assertReadQuery("SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", 'mysql'), /INTO/)
  assert.throws(() => assertReadQuery('SELECT 1 /*!50000 FOR UPDATE */', 'mysql'), /FOR UPDATE/)
  assert.throws(() => assertReadQuery('SELECT 1 /*!50000 ; DELETE FROM t */', 'mysql'), /一条语句/)
})

test('MySQL：合法读与 MySQL 真实词法不被误伤', () => {
  assert.equal(assertReadQuery('SELECT 1 # 行注释', 'mysql'), 'SELECT 1 # 行注释')
  assert.equal(assertReadQuery("SELECT 'a\\'b' AS x", 'mysql'), "SELECT 'a\\'b' AS x")
  assert.equal(assertReadQuery('SELECT /*!40001 SQL_NO_CACHE */ * FROM t', 'mysql'), 'SELECT /*!40001 SQL_NO_CACHE */ * FROM t')
})

test('MySQL：同一 payload 在 MySQL 里本就是单条语句（方言忠实而非一刀切）', () => {
  // PG 的绕过 payload 在 MySQL 中整体是一个字符串字面量，不存在第二条语句，
  // 所以守卫放行是正确的；MySQL 侧另有 multipleStatements:false 作引擎级兜底。
  assert.equal(assertReadQuery("SELECT '\\'; DELETE FROM t; --'", 'mysql'), "SELECT '\\'; DELETE FROM t; --'")
})

test('MySQL：`--x` 不算注释（MySQL 要求 -- 后跟空白）', () => {
  assert.throws(() => assertReadQuery('SELECT 1--x; DELETE FROM t', 'mysql'), /一条语句/)
})

test('SQLite：PRAGMA 括号写形式与写型 PRAGMA 被拒，读形式放行', () => {
  assert.throws(() => assertReadQuery('PRAGMA journal_mode(WAL)', 'sqlite'), /PRAGMA/)
  assert.throws(() => assertReadQuery('PRAGMA optimize', 'sqlite'), /PRAGMA/)
  assert.throws(() => assertReadQuery('PRAGMA wal_checkpoint(TRUNCATE)', 'sqlite'), /PRAGMA/)
  assert.throws(() => assertReadQuery('PRAGMA incremental_vacuum', 'sqlite'), /PRAGMA/)
  assert.throws(() => assertReadQuery('PRAGMA user_version(7)', 'sqlite'), /PRAGMA/)
  assert.equal(assertReadQuery('PRAGMA journal_mode', 'sqlite'), 'PRAGMA journal_mode')
  assert.equal(assertReadQuery('PRAGMA table_info(users)', 'sqlite'), 'PRAGMA table_info(users)')
  assert.equal(assertReadQuery('PRAGMA page_count', 'sqlite'), 'PRAGMA page_count')
})

test('未指定引擎时用最保守方言：不把 PG/MySQL 专有词法当字符串或注释', () => {
  assert.throws(() => assertReadQuery("SELECT '\\'; DELETE FROM t; --'"), /一条语句/)
  assert.throws(() => assertReadQuery('SELECT 1 # 2; DELETE FROM t'), /一条语句/)
  assert.throws(() => assertReadQuery('SELECT $tag$; DELETE FROM t$tag$'), /一条语句/)
})

test('已有规则未被削弱：data-modifying CTE / INTO / 行锁 / 白名单', () => {
  assert.throws(() => assertReadQuery('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone', 'postgres'), /DELETE/)
  assert.throws(() => assertReadQuery("SELECT * FROM t INTO OUTFILE '/tmp/x'", 'mysql'), /INTO/)
  assert.throws(() => assertReadQuery('SELECT * FROM t FOR UPDATE', 'postgres'), /FOR UPDATE/)
  assert.throws(() => assertReadQuery('DELETE FROM t', 'postgres'), /只接受只读语句/)
  assert.equal(assertReadQuery('SHOW CREATE TABLE users', 'mysql'), 'SHOW CREATE TABLE users')
  assert.equal(assertReadQuery('EXPLAIN SELECT 1', 'postgres'), 'EXPLAIN SELECT 1')
})

// ---------- 引擎级兜底 ----------

test('SQLite 读路径有引擎级兜底：写语句被数据库拒绝且 query_only 会复位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-ro-'))
  const adapter = createAdapter({ name: 'ro', engine: 'sqlite', file: join(dir, 'x.db') })
  try {
    await adapter.exec('CREATE TABLE t (a INTEGER)')
    await adapter.exec('INSERT INTO t VALUES (1)')
    // 直接绕过词法守卫调用适配器：写必须被 SQLite 自己挡下
    await assert.rejects(() => adapter.query('DELETE FROM t'), /readonly database/i)
    const kept = await adapter.query('SELECT COUNT(*) AS c FROM t', 1)
    assert.equal(Number(kept.rows[0][0]), 1, '数据未被删除')
    // finally 必须复位 query_only，否则之后的 sql_exec 会全部失效
    await adapter.exec('INSERT INTO t VALUES (2)')
    const after = await adapter.query('SELECT COUNT(*) AS c FROM t', 1)
    assert.equal(Number(after.rows[0][0]), 2)
    assert.ok((await adapter.query('PRAGMA table_info(t)', 10)).rows.length >= 1, '读 PRAGMA 仍可用')
    assert.ok((await adapter.query('SELECT 1 AS one')).rows.length === 1, '无 limit 的读路径同样可用')
  } finally {
    await adapter.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 假 PostgreSQL 服务端：只记录客户端发来的报文类型与 Query 文本。 */
function fakePostgres(seen, queries) {
  const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
  const msg = (t, body) => Buffer.concat([Buffer.from(t), i32(body.length + 4), body])
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    let buf = Buffer.alloc(0)
    let ready = false
    sock.on('error', () => {})
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!ready) {
        if (buf.length < 4) return
        const len = buf.readInt32BE(0)
        if (buf.length < len) return
        buf = buf.subarray(len)
        ready = true
        sock.write(Buffer.concat([
          Buffer.concat([Buffer.from('R'), i32(8), i32(0)]),
          msg('S', Buffer.from('server_version\0fake\0')),
          Buffer.concat([Buffer.from('K'), i32(12), i32(1), i32(2)]),
          Buffer.concat([Buffer.from('Z'), i32(5), Buffer.from('I')]),
        ]))
      }
      while (buf.length >= 5) {
        const type = String.fromCharCode(buf[0])
        const mlen = buf.readInt32BE(1)
        if (buf.length < mlen + 1) break
        const body = buf.subarray(5, mlen + 1)
        buf = buf.subarray(mlen + 1)
        seen.push(type)
        if (type === 'Q') {
          queries.push(body.subarray(0, body.length - 1).toString('utf8'))
          const tag = Buffer.from('SELECT 1\0')
          sock.write(Buffer.concat([Buffer.from('C'), i32(4 + tag.length), tag]))
          sock.write(Buffer.concat([Buffer.from('Z'), i32(5), Buffer.from('I')]))
        }
        if (type === 'P') sock.write(Buffer.concat([Buffer.from('1'), i32(4)]))
        if (type === 'B') sock.write(Buffer.concat([Buffer.from('2'), i32(4)]))
        if (type === 'D') sock.write(Buffer.concat([Buffer.from('n'), i32(4)]))
        if (type === 'E') { const tag = Buffer.from('SELECT 1\0'); sock.write(Buffer.concat([Buffer.from('C'), i32(4 + tag.length), tag])) }
        if (type === 'S') sock.write(Buffer.concat([Buffer.from('Z'), i32(5), Buffer.from('I')]))
        if (type === 'X') sock.end()
      }
    })
  })
  return {
    server,
    /** 确定性收尾：先销毁残留连接再关监听，否则 keep-alive socket 会吊住进程。 */
    async close() {
      for (const sock of sockets) sock.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

test('PostgreSQL 读路径走扩展协议（Parse），服务端因此拒绝多语句', async () => {
  const seen = []
  const queries = []
  const fake = fakePostgres(seen, queries)
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve))
  const adapter = createAdapter({ name: 'pg', engine: 'postgres', host: '127.0.0.1', port: fake.server.address().port, user: 'u', password: 'p', database: 'd' })
  try {
    await adapter.query('SELECT 1', 10)                    // 走 sql_query 的流式读路径
    assert.ok(seen.includes('P'), '读路径必须发 Parse（扩展协议），实际: ' + seen.join(''))
    assert.equal(seen.includes('Q'), false, '读路径不应发 simple query 的 Query 报文')
    // sql_exec 必须保持 simple query，否则多语句 DDL 脚本会被服务端拒绝
    seen.length = 0
    await adapter.exec('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')
    assert.ok(seen.includes('Q'), 'sql_exec 仍应走 simple query，实际: ' + seen.join(''))
    assert.deepEqual(queries, ['INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)'])
  } finally {
    await adapter.close()
    await fake.close()
  }
})

// ---------- 工具层与插件层 ----------

test('sql_query 工具层：写 payload 在建立连接之前就被拒绝', async () => {
  const cfg = resolveConfig({
    connections: [
      { name: 'pg', engine: 'postgres', host: '127.0.0.1', port: 1, user: 'u', database: 'd' },
      { name: 'my', engine: 'mysql', host: '127.0.0.1', port: 1, user: 'u', database: 'd' },
    ],
  })
  const { tools, adapters } = buildSqlTools(cfg)
  const query = tools.find((t) => t.name === 'sql_query')
  try {
    await assert.rejects(() => query.execute({ sql: "SELECT '\\'; DROP TABLE users; --'", connection: 'pg' }), /一条语句/)
    await assert.rejects(() => query.execute({ sql: 'SELECT 1 # 2; DELETE FROM t', connection: 'pg' }), /一条语句/)
    await assert.rejects(() => query.execute({ sql: "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", connection: 'my' }), /INTO/)
    assert.equal(adapters.size, 0, '守卫必须在建连之前拦下')
    await assert.rejects(() => query.execute({ sql: 'SELECT 1', connection: 'nope' }), /未找到名为 nope/)
  } finally {
    for (const adapter of adapters.values()) await adapter.close()
  }
})

function makeFakeCtx() {
  const registered = []
  const listeners = {}
  const guards = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
      guard(check) {
        guards.push(check)
        return () => {
          const index = guards.indexOf(check)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener)
      return () => {}
    },
  }
  return { ctx, registered, listeners, guards }
}

test('readOnly 用单调 guard 表达：sql_exec 被拒且 sql_query 不受影响', () => {
  const { ctx, guards } = makeFakeCtx()
  apply(ctx, { readOnly: true })
  assert.equal(guards.length, 1, 'readOnly 应注册一个 guard')
  assert.match(guards[0]({ name: 'sql_exec', arguments: {} }), /readOnly=true/)
  assert.equal(guards[0]({ name: 'sql_query', arguments: {} }), undefined)
  assert.equal(guards[0]({ name: 'sql_list', arguments: {} }), undefined)
})

test('非 readOnly 时不注册 guard；dispose 会一并卸载 guard', () => {
  const { ctx, guards, registered, listeners } = makeFakeCtx()
  apply(ctx, {})
  assert.equal(guards.length, 0)
  assert.equal(registered.length, 6)
  const ro = makeFakeCtx()
  apply(ro.ctx, { readOnly: true })
  assert.equal(ro.guards.length, 1)
  for (const listener of ro.listeners.dispose ?? []) listener()
  assert.equal(ro.guards.length, 0, 'dispose 后 guard 必须卸载')
  assert.equal(ro.registered.length, 0)
  for (const listener of listeners.dispose ?? []) listener()
})
