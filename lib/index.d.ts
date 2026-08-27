/**
 * dsh-sql —— 工程师级数据库工具插件（node 半身，配置走 cordis.patch.yml）。
 *
 * 插件导出 apply(ctx, config)：注册四个面向模型的工具（sql_list / sql_query /
 * sql_exec / sql_schema），支持 SQLite / MySQL / PostgreSQL 三引擎与多连接。
 * sql_exec 默认走宿主审批门（对齐 dsh-email 的发信审批），readOnly 模式可整体禁用写。
 *
 * @module dsh-sql
 */
import { type SqlConfig } from './config.js';
import { type SqlToolDefinition } from './tools.js';
/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export declare const name = "sql";
export declare const inject: string[];
/** 审批服务最小面（对齐 dsh-email）。 */
export interface SqlApproval {
    request(options: {
        agent?: unknown;
        toolName?: unknown;
        callId?: unknown;
        reason: string;
        signal?: unknown;
    }): Promise<'allowed-once' | 'cancelled' | 'unavailable' | string>;
}
/** 插件所需的最小 ctx 面。 */
export interface SqlPluginContext {
    tools: {
        register(definition: SqlToolDefinition, options?: {
            prepend?: boolean;
        }): () => void;
    };
    get?(name: 'approval'): SqlApproval | undefined;
    on?(event: string, listener: () => void): () => void;
}
/**
 * 插件入口：解析配置、构建四工具、给 sql_exec 注入审批门。
 */
export declare function apply(ctx: SqlPluginContext, config?: SqlConfig | null): void;
export * from './adapters.js';
export * from './config.js';
export * from './tools.js';
