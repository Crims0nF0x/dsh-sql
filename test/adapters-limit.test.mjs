import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAdapter } from '../lib/index.js'

test('PostgreSQL：query(limit) 用 portal rows 限制返回行数', async () => {
  const adapter = createAdapter({ name: 'pg', engine: 'postgres', database: 'app' })
  const calls = []
  adapter.pool.query = async (config) => {
    calls.push(config)
    return { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }
  }
  const result = await adapter.query('SELECT a FROM t ORDER BY a', 3)
  assert.deepEqual(calls[0], { text: 'SELECT a FROM t ORDER BY a', values: [], rows: 3 })
  assert.deepEqual(result.columns, ['a'])
  assert.equal(result.rows.length, 3)
})

test('MySQL：query(limit) 走 stream，到达上限立即 destroy', async () => {
  const adapter = createAdapter({ name: 'my', engine: 'mysql', database: 'app' })
  const stream = new EventEmitter()
  stream.destroy = () => {
    stream.emit('close')
  }
  adapter.pool = {
    pool: {
      query(sql) {
        assert.equal(sql, 'SELECT a FROM t ORDER BY a')
        return { stream: () => stream }
      },
    },
  }
  const pending = adapter.query('SELECT a FROM t ORDER BY a', 2)
  stream.emit('fields', [{ name: 'a' }])
  stream.emit('result', { a: 1 })
  stream.emit('result', { a: 2 })
  const result = await pending
  assert.deepEqual(result.columns, ['a'])
  assert.deepEqual(result.rows, [[1], [2]])
})
