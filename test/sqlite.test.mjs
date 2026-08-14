import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-int-'))
const file = join(dir, 'test.db')
const adapter = createAdapter({ name: 't', engine: 'sqlite', file })

test('SQLite：建表/插入/查询/描述/列表', async () => {
  await adapter.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL)')
  await adapter.exec("INSERT INTO users (name, score) VALUES ('张三', 99.5)")
  await adapter.exec("INSERT INTO users (name, score) VALUES ('李四', 88)")
  const result = await adapter.query('SELECT id, name, score FROM users ORDER BY id')
  assert.deepEqual(result.columns, ['id', 'name', 'score'])
  assert.equal(result.rows.length, 2)
  assert.deepEqual(result.rows[0], [1, '张三', 99.5])
  const tables = await adapter.listTables()
  assert.ok(tables.includes('users'))
  const columns = await adapter.describeTable('users')
  assert.equal(columns.length, 3)
  assert.equal(columns[0].primaryKey, true)
  assert.equal(columns[1].notNull, true)
})

test('SQLite：exec 返回 changes，多语句返回 0', async () => {
  const changes = await adapter.exec('UPDATE users SET score = 100 WHERE name = \'张三\'')
  assert.equal(changes, 1)
  const multi = await adapter.exec('CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER)')
  assert.equal(multi, 0)
})

test('SQLite：ping 与关闭', async () => {
  await adapter.ping()
  await adapter.close()
  await assert.rejects(() => adapter.ping())
})

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }) })
