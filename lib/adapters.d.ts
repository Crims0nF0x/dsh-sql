import { type SqlConnectionConfig } from './config.js';
/** 查询结果：列名 + 行（值数组，损失 JSON 友好）。 */
export interface QueryResult {
    columns: string[];
    rows: unknown[][];
}
/** 表列信息。 */
export interface ColumnInfo {
    name: string;
    type: string;
    notNull: boolean;
    primaryKey: boolean;
}
/** 统一适配器接口。 */
export interface DatabaseAdapter {
    engine: 'sqlite' | 'mysql' | 'postgres';
    listTables(): Promise<string[]>;
    describeTable(table: string): Promise<ColumnInfo[]>;
    query(sql: string, limit?: number): Promise<QueryResult>;
    exec(sql: string): Promise<number>;
    ping(): Promise<void>;
    close(): Promise<void>;
}
/** 按连接配置创建适配器。 */
export declare function createAdapter(connection: SqlConnectionConfig): DatabaseAdapter;
