import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, assertIdentifier, passwordEnvName } from '../lib/index.js'

test('默认：内存 SQLite 兜底连接', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.connections.length, 1)
  assert.equal(cfg.connections[0].name, 'default')
  assert.equal(cfg.connections[0].engine, 'sqlite')
  assert.equal(cfg.connections[0].file, ':memory:')
  assert.equal(cfg.maxRows, 1000)
  assert.equal(cfg.writeApproval, true)
})

test('多连接解析 + 密码环境变量回退', () => {
  const cfg = resolveConfig({
    connections: [
      { name: 'local', engine: 'sqlite', file: './x.db' },
      { name: 'prod', engine: 'postgres', host: 'db.internal', database: 'app' },
    ],
  }, { DSH_SQL_PASSWORD_PROD: 'secret123' })
  assert.equal(cfg.connections.length, 2)
  const prod = cfg.connections[1]
  assert.equal(prod.port, 5432)
  assert.equal(prod.password, 'secret123')
  assert.equal(passwordEnvName('my-db'), 'DSH_SQL_PASSWORD_MY_DB')
})

test('配置非法抛中文错误', () => {
  assert.throws(() => resolveConfig({ connections: [{ name: '', engine: 'sqlite' }] }), /需要 name/)
  assert.throws(() => resolveConfig({ connections: [{ name: 'x', engine: 'oracle' }] }), /sqlite \/ mysql \/ postgres/)
  assert.throws(() => resolveConfig({ connections: [{ name: 'a', engine: 'sqlite' }, { name: 'A', engine: 'sqlite' }] }), /重复/)
  assert.throws(() => resolveConfig({ connections: [{ name: 'a', engine: 'mysql' }] }), /缺少 database/)
  assert.throws(() => resolveConfig({ maxRows: -1 }), /maxRows/)
})

test('maxRows 钳制到 10000；readOnly 解析', () => {
  assert.equal(resolveConfig({ maxRows: 999999 }).maxRows, 10000)
  assert.equal(resolveConfig({ readOnly: true }).readOnly, true)
})

test('assertIdentifier 防注入', () => {
  assert.equal(assertIdentifier('users', '表名'), 'users')
  assert.throws(() => assertIdentifier('users; DROP TABLE x', '表名'), /非法/)
  assert.throws(() => assertIdentifier('a b', '表名'), /非法/)
})
