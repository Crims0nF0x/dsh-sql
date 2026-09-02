import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../lib/index.js'

function makeFakeCtx() {
  const registered = []
  const listeners = {}
  const ctx = {
    tools: {
      register(definition, ...extra) {
        registered.push({ definition, extra })
        return () => {
          const index = registered.findIndex((item) => item.definition === definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener)
      return () => {}
    },
  }
  return { ctx, registered, listeners }
}

test('inject 声明 tools', () => {
  assert.deepEqual(inject, ['tools'])
})

test('apply 注册 6 个工具（官方 register 签名）', () => {
  const { ctx, registered } = makeFakeCtx()
  apply(ctx, {})
  assert.equal(registered.length, 6)
  assert.ok(registered.every((item) => item.extra.length === 0))
  assert.ok(registered.every((item) => !Object.hasOwn(item.definition, 'gate')))
})

test('sql_exec 通过 tools/pre-execute 返回 ask，其他工具继续 waterfall', async () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, {})
  const preExecute = listeners['tools/pre-execute'][0]
  let delegated = false
  const ask = await preExecute(
    { name: 'sql_exec', arguments: { sql: 'DELETE FROM users' } },
    async () => { delegated = true; return { kind: 'allow' } },
  )
  assert.equal(ask.kind, 'ask')
  assert.ok(ask.reason.includes('DELETE FROM users'))
  assert.equal(delegated, false)

  const allowed = await preExecute(
    { name: 'sql_query', arguments: { sql: 'SELECT 1' } },
    async () => { delegated = true; return { kind: 'allow' } },
  )
  assert.deepEqual(allowed, { kind: 'allow' })
  assert.equal(delegated, true)
})

test('writeApproval=false 时不注册 pre-execute 审批策略', () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, { writeApproval: false })
  assert.equal(listeners['tools/pre-execute'], undefined)
})

test('dispose 卸载全部工具', () => {
  const { ctx, registered, listeners } = makeFakeCtx()
  apply(ctx, {})
  assert.equal(registered.length, 6)
  for (const listener of listeners.dispose ?? []) listener()
  assert.equal(registered.length, 0)
})
