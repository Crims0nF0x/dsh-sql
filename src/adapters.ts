/**
 * 数据库适配器层：sqlite（node:sqlite 内置）/ mysql（mysql2）/ postgres（pg）三实现。
 * 统一接口：listTables / describeTable / query / exec / ping / close。
 *
 * @module dsh-sql/adapters
 */
import { DatabaseSync } from 'node:sqlite'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { assertIdentifier, type SqlConnectionConfig } from './config.js'

/** 查询结果：列名 + 行（值数组，损失 JSON 友好）。 */
export interface QueryResult {
  columns: string[]
  rows: unknown[][]
}

/** 表列信息。 */
export interface ColumnInfo {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
}

/** 统一适配器接口。 */
export interface DatabaseAdapter {
  engine: 'sqlite' | 'mysql' | 'postgres'
  listTables(): Promise<string[]>
  describeTable(table: string): Promise<ColumnInfo[]>
  query(sql: string, limit?: number): Promise<QueryResult>
  exec(sql: string): Promise<number>
  ping(): Promise<void>
  close(): Promise<void>
}

function toValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Array.from(value)
  if (value instanceof Map) return Object.fromEntries(value)
  return value
}

function rowsToColumns(rows: Array<Record<string, unknown>>): QueryResult {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const values = rows.map((row) => columns.map((column) => toValue(row[column])))
  return { columns, rows: values }
}

function quoteSqliteIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/** SQLite 适配器（node:sqlite，零依赖）。 */
class SqliteAdapter implements DatabaseAdapter {
  engine = 'sqlite' as const
  private db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : file)
    this.db.exec('PRAGMA busy_timeout = 5000')
  }
  async listTables() {
    const result = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<Record<string, unknown>>
    return result.map((row) => String(row.name))
  }
  async describeTable(table: string) {
    const name = assertIdentifier(table, '表名')
    const rows = this.db.prepare('PRAGMA table_info(' + quoteSqliteIdentifier(name) + ')').all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type ?? ''),
      notNull: Number(row.notnull) === 1,
      primaryKey: Number(row.pk) === 1,
    }))
  }
  async query(sql: string, limit?: number) {
    const statement = this.db.prepare(sql)
    if (limit === undefined || limit <= 0) {
      const rows = statement.all() as Array<Record<string, unknown>>
      return rowsToColumns(rows)
    }
    const columns = statement.columns().map((column) => column.name)
    const rows: unknown[][] = []
    for (const raw of statement.iterate()) {
      const row = raw as Record<string, unknown>
      rows.push(columns.map((name) => toValue(row[name])))
      if (rows.length >= limit) break
    }
    return { columns, rows }
  }
  async exec(sql: string) {
    const single = sql.replace(/;\s*$/, '').trim()
    if (single.includes(';')) {
      this.db.exec(sql)
      return 0
    }
    const result = this.db.prepare(single).run()
    return Number(result.changes)
  }
  async ping() {
    this.db.prepare('SELECT 1').get()
  }
  async close() {
    this.db.close()
  }
}

/** MySQL 适配器（mysql2 连接池）。 */
class MysqlAdapter implements DatabaseAdapter {
  engine = 'mysql' as const
  private pool: mysql.Pool
  constructor(connection: SqlConnectionConfig) {
    this.pool = mysql.createPool({
      host: connection.host ?? 'localhost',
      port: connection.port ?? 3306,
      user: connection.user ?? '',
      password: connection.password ?? '',
      database: connection.database ?? '',
      connectionLimit: 5,
      enableKeepAlive: true,
    })
  }
  async listTables() {
    const [rows] = await this.pool.query('SHOW TABLES') as unknown as [Array<Record<string, unknown>>, unknown]
    return rows.map((row) => String(Object.values(row)[0] ?? ''))
  }
  async describeTable(table: string) {
    const name = assertIdentifier(table, '表名')
    const [rows] = await this.pool.query('DESCRIBE `' + name + '`') as unknown as [Array<Record<string, unknown>>, unknown]
    return rows.map((row) => ({
      name: String(row.Field),
      type: String(row.Type ?? ''),
      notNull: String(row.Null ?? '').toUpperCase() === 'NO',
      primaryKey: String(row.Key ?? '').toUpperCase() === 'PRI',
    }))
  }
  async query(sql: string, limit?: number) {
    if (limit === undefined || limit <= 0) {
      const [rows] = await this.pool.query(sql) as unknown as [Array<Record<string, unknown>>, unknown]
      return rowsToColumns(rows)
    }
    const corePool = (this.pool as unknown as { pool: { query(querySql: string): any } }).pool
    return await new Promise<QueryResult>((resolve, reject) => {
      let settled = false
      let columns: string[] = []
      const rows: unknown[][] = []
      const stream = corePool.query(sql).stream({ highWaterMark: 64 })
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve({ columns, rows })
      }
      stream.on('fields', (fields: Array<{ name: string }>) => {
        columns = fields.map((field) => field.name)
      })
      stream.on('result', (row: Record<string, unknown>) => {
        if (columns.length === 0) columns = Object.keys(row)
        rows.push(columns.map((name) => toValue(row[name])))
        if (rows.length >= limit) stream.destroy()
      })
      stream.on('end', finish)
      stream.on('close', finish)
      stream.on('error', (error: unknown) => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }
  async exec(sql: string) {
    const [result] = await this.pool.query(sql) as unknown as [{ affectedRows?: number }, unknown]
    return Number(result?.affectedRows ?? 0)
  }
  async ping() {
    await this.pool.query('SELECT 1')
  }
  async close() {
    await this.pool.end()
  }
}

/** PostgreSQL 适配器（pg 连接池）。 */
class PostgresAdapter implements DatabaseAdapter {
  engine = 'postgres' as const
  private pool: pg.Pool
  constructor(connection: SqlConnectionConfig) {
    this.pool = new pg.Pool({
      host: connection.host ?? 'localhost',
      port: connection.port ?? 5432,
      user: connection.user ?? '',
      password: connection.password ?? '',
      database: connection.database ?? '',
      max: 5,
    })
  }
  async listTables() {
    const result = await this.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")
    return result.rows.map((row: Record<string, unknown>) => String(row.table_name))
  }
  async describeTable(table: string) {
    const name = assertIdentifier(table, '表名')
    const result = await this.pool.query(
      `SELECT c.column_name, c.data_type, c.is_nullable,
              EXISTS (
                SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND tc.constraint_type = 'PRIMARY KEY'
                  AND kcu.column_name = c.column_name
              ) AS is_primary
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = $1
        ORDER BY c.ordinal_position`,
      [name],
    )
    return result.rows.map((row: Record<string, unknown>) => ({
      name: String(row.column_name),
      type: String(row.data_type ?? ''),
      notNull: String(row.is_nullable) === 'NO',
      primaryKey: row.is_primary === true,
    }))
  }
  async query(sql: string, limit?: number) {
    if (limit === undefined || limit <= 0) {
      const result = await this.pool.query(sql)
      const rows = result.rows as Array<Record<string, unknown>>
      return rowsToColumns(rows)
    }
    const result = await this.pool.query({ text: sql, values: [], rows: limit } as any)
    const rows = result.rows as Array<Record<string, unknown>>
    return rowsToColumns(rows)
  }
  async exec(sql: string) {
    const result = await this.pool.query(sql)
    return Number(result.rowCount ?? 0)
  }
  async ping() {
    await this.pool.query('SELECT 1')
  }
  async close() {
    await this.pool.end()
  }
}

/** 按连接配置创建适配器。 */
export function createAdapter(connection: SqlConnectionConfig): DatabaseAdapter {
  if (connection.engine === 'sqlite') return new SqliteAdapter(connection.file ?? ':memory:')
  if (connection.engine === 'mysql') return new MysqlAdapter(connection)
  return new PostgresAdapter(connection)
}
