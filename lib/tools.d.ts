/**
 * 六个面向模型的数据库工具：sql_list / sql_query / sql_exec / sql_schema / sql_stats / sql_health。
 *
 * @module dsh-sql/tools
 */
import { type DatabaseAdapter } from './adapters.js';
import { type ResolvedSqlConfig } from './config.js';
/** 模型可见的内容块。 */
export interface ContentBlock {
    type: 'text';
    text: string;
}
/** 注册给 ctx.tools.register 的原始工具定义。 */
export interface SqlToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): ContentBlock[];
    };
    execute(args: unknown, exec: unknown): Promise<unknown>;
    gate?(exec: unknown, next: () => Promise<unknown>): Promise<unknown>;
    timeoutMs?: number;
}
/** 校验只读查询：词法去噪后白名单开头 + 写关键字扫描 + 单语句。 */
export declare function assertReadQuery(sql: string): string;
/** 查询结果转 CSV 文本（RFC 4180 风格转义）。 */
export declare function toCsv(columns: string[], rows: unknown[][]): string;
/** 审批执行上下文的最小面。 */
export interface SqlExecGateContext {
    agent?: unknown;
    name?: unknown;
    callId?: unknown;
    signal?: unknown;
}
/** 构建四个工具定义；adapters 惰性创建并按连接名缓存。 */
export declare function buildSqlTools(config: ResolvedSqlConfig): {
    tools: SqlToolDefinition[];
    adapters: Map<string, DatabaseAdapter>;
};
