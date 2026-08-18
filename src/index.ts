/**
 * dsh-sql —— 工程师级数据库工具插件（node 半身，配置走 cordis.patch.yml）。
 *
 * 插件导出 apply(ctx, config)：注册四个面向模型的工具（sql_list / sql_query /
 * sql_exec / sql_schema），支持 SQLite / MySQL / PostgreSQL 三引擎与多连接。
 * sql_exec 默认走宿主审批门（对齐 dsh-email 的发信审批），readOnly 模式可整体禁用写。
 *
 * @module dsh-sql
 */

import { resolveConfig, type SqlConfig } from './config.js'
import { buildSqlTools, type SqlToolDefinition } from './tools.js'

/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export const name = 'sql'
export const inject = ['tools']

/** 审批服务最小面（对齐 dsh-email）。 */
export interface SqlApproval {
  request(options: {
    agent?: unknown
    toolName?: unknown
    callId?: unknown
    reason: string
    signal?: unknown
  }): Promise<'allowed-once' | 'cancelled' | 'unavailable' | string>
}

/** 插件所需的最小 ctx 面。 */
export interface SqlPluginContext {
  tools: { register(definition: SqlToolDefinition, options?: { prepend?: boolean }): () => void }
  get?(name: 'approval'): SqlApproval | undefined
  on?(event: string, listener: () => void): () => void
}

/**
 * 插件入口：解析配置、构建四工具、给 sql_exec 注入审批门。
 */
export function apply(ctx: SqlPluginContext, config?: SqlConfig | null): void {
  let cfg
  try {
    cfg = resolveConfig(config)
  } catch (error) {
    console.warn('[dsh-sql] ' + (error instanceof Error ? error.message : String(error)))
    cfg = resolveConfig(null)
  }

  const { tools, adapters } = buildSqlTools(cfg)
  const disposers: Array<() => void> = []
  for (const definition of tools) {
    if (definition.name === 'sql_exec' && cfg.writeApproval) {
      const originalGate = definition.gate
      definition.gate = async (exec: unknown, next: () => Promise<unknown>) => {
        const approval = ctx.get?.('approval')
        if (approval === undefined) {
          return {
            kind: 'deny',
            reason: 'sql_exec 需要确认，但当前环境没有审批通道（如 headless）。如确定安全，可在配置中设置 writeApproval: false 后直接执行。',
          }
        }
        const execRecord = (typeof exec === 'object' && exec !== null ? exec : {}) as Record<string, unknown>
        const args = (typeof execRecord.args === 'object' && execRecord.args !== null ? execRecord.args : {}) as Record<string, unknown>
        const sql = typeof args.sql === 'string' ? args.sql : ''
        const outcome = await approval.request({
          agent: execRecord.agent,
          toolName: execRecord.name,
          callId: execRecord.callId,
          reason: '执行数据库写操作：' + sql.slice(0, 200) + (sql.length > 200 ? '…' : ''),
          signal: execRecord.signal,
        })
        if (outcome === 'allowed-once') return originalGate ? originalGate(exec, next) : next()
        if (outcome === 'cancelled') return { kind: 'deny', reason: '写操作确认被取消，SQL 未执行。' }
        if (outcome === 'unavailable') return { kind: 'deny', reason: '写操作确认不可用（没有可用的审批界面），SQL 未执行。' }
        return {
          kind: 'deny',
          reason: '写操作未获批准：要么你拒绝了，要么当前会话处于 Full Access（审批策略 never，不会弹框）。若在 Full Access：切到 Read Only / Write 再执行，或关闭 writeApproval（自行承担风险）。',
        }
      }
    }
    disposers.push(ctx.tools.register(definition, { prepend: true }))
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) dispose()
      for (const adapter of adapters.values()) void adapter.close()
    })
  }
}

export * from './adapters.js'
export * from './config.js'
export * from './tools.js'
