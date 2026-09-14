/**
 * dsh-sql —— 工程师级数据库工具插件（node 半身，配置走 cordis.patch.yml）。
 *
 * 插件导出 apply(ctx, config)：注册六个面向模型的工具（sql_list / sql_query /
 * sql_exec / sql_schema / sql_stats / sql_health），支持 SQLite / MySQL / PostgreSQL
 * 三引擎与多连接。
 * sql_exec 默认走宿主审批门（对齐 dsh-email 的发信审批），readOnly 模式可整体禁用写。
 *
 * @module dsh-sql
 */

import { resolveConfig, type SqlConfig } from './config.js'
import { buildSqlTools, type SqlToolDefinition } from './tools.js'

/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export const name = 'sql'
export const inject = ['tools']

/** Harness `tools/pre-execute` 的决策结果。 */
type SqlPreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** 审批策略需要读取的 alpha.5 工具执行字段。 */
interface SqlToolExecution {
  readonly name: string
  readonly arguments: unknown
}

/** Harness `tools/pre-execute` waterfall 监听器。 */
type SqlPreExecuteListener = (
  exec: SqlToolExecution,
  next: () => Promise<SqlPreToolDecision>,
) => Promise<SqlPreToolDecision>

/** Harness 单调执行 guard：返回理由即拒绝，返回 undefined 表示不改变结论。 */
type SqlGuard = (execution: SqlToolExecution) => string | undefined

/** 插件所需的最小 ctx 面。 */
export interface SqlPluginContext {
  tools: {
    register(definition: SqlToolDefinition): () => void
    /**
     * Harness 的单调 guard（0.1.5 起提供）。与 `tools/pre-execute` 这种 waterfall 不同，
     * guard 只有拒绝语义、不能被别的监听器翻回放行，所以安全约束优先用它表达。
     */
    guard?(guard: SqlGuard): () => void
  }
  on(event: 'tools/pre-execute', listener: SqlPreExecuteListener): () => void
  on(event: 'dispose', listener: () => void): () => void
}

/**
 * 插件入口：解析配置、构建六工具、给 sql_exec 注入审批门。
 */
export function apply(ctx: SqlPluginContext, config?: SqlConfig | null): void {
  const cfg = resolveConfig(config)

  const { tools, adapters } = buildSqlTools(cfg)
  const disposers: Array<() => void> = []

  // readOnly 用单调 guard 表达：即使更早注册的插件在 pre-execute 里返回 allow，
  // 也无法把 sql_exec 翻回放行。
  if (cfg.readOnly && typeof ctx.tools.guard === 'function') {
    disposers.push(ctx.tools.guard((exec) => (
      exec.name === 'sql_exec' ? '当前配置 readOnly=true，sql_exec 已被禁用。' : undefined
    )))
  }

  if (cfg.writeApproval) {
    // 审批只能用 pre-execute 的 `ask` 决策表达（guard 没有 ask 语义）。
    // waterfall 是顺序短路：若更早注册的监听器不调 next() 直接返回 allow，本审批会被跳过。
    // 这是 Harness 层面的性质，插件侧消除不了，已在 README 的安全设计里写明。
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'sql_exec') return next()
      const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
      const sql = typeof args.sql === 'string' ? args.sql : ''
      return {
        kind: 'ask',
        reason: 'sql_exec 写操作需要确认：' + sql.slice(0, 200) + (sql.length > 200 ? '…' : ''),
      }
    })
  }

  for (const definition of tools) {
    disposers.push(ctx.tools.register(definition))
  }
  ctx.on('dispose', () => {
    for (const dispose of disposers) dispose()
    for (const adapter of adapters.values()) void adapter.close()
  })
}

export * from './adapters.js'
export * from './config.js'
export * from './tools.js'
