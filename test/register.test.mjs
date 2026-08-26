import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../lib/index.js'

function makeFakeCtx(approval) {
  const registered = []
  const listeners = {}
  const ctx = {
    tools: {
      register(definition, options) {
        registered.push({ definition, options })
        return () => {
          const index = registered.findIndex((item) => item.definition === definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    get(name) {
      if (name === 'approval') return approval
      return undefined
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

test('apply 注册 6 个工具（prepend 审批门）', () => {
  const { ctx, registered } = makeFakeCtx({ request: async () => 'allowed-once' })
  apply(ctx, {})
  assert.equal(registered.length, 6)
  assert.equal(registered[0].options.prepend, true)
})

test('审批门：allowed-once 放行；拒绝时返回 deny 原因', async () => {
  const { ctx, registered } = makeFakeCtx({ request: async () => 'allowed-once' })
  apply(ctx, {})
  const execTool = registered.find((item) => item.definition.name === 'sql_exec').definition
  const result = await execTool.gate({ args: { sql: 'DELETE FROM x' } }, async () => 'EXECUTED')
  assert.equal(result, 'EXECUTED')

  const { ctx: ctx2, registered: reg2 } = makeFakeCtx({ request: async () => 'rejected' })
  apply(ctx2, {})
  const execTool2 = reg2.find((item) => item.definition.name === 'sql_exec').definition
  const denied = await execTool2.gate({ args: { sql: 'DELETE FROM x' } }, async () => 'EXECUTED')
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes('未获批准'))
})

test('无审批通道时 deny 并给出指引', async () => {
  const { ctx, registered } = makeFakeCtx(undefined)
  apply(ctx, {})
  const execTool = registered.find((item) => item.definition.name === 'sql_exec').definition
  const denied = await execTool.gate({ args: { sql: 'x' } }, async () => 'EXECUTED')
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes('writeApproval'))
})

test('writeApproval=false 时不注入审批门', async () => {
  const { ctx, registered } = makeFakeCtx(undefined)
  apply(ctx, { writeApproval: false })
  const execTool = registered.find((item) => item.definition.name === 'sql_exec').definition
  const result = await execTool.gate({ args: { sql: 'x' } }, async () => 'EXECUTED')
  assert.equal(result, 'EXECUTED')
})

test('dispose 卸载全部工具', () => {
  const { ctx, registered, listeners } = makeFakeCtx({ request: async () => 'allowed-once' })
  apply(ctx, {})
  assert.equal(registered.length, 6)
  for (const listener of listeners.dispose ?? []) listener()
  assert.equal(registered.length, 0)
})
