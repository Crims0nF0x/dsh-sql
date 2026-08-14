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
  query(sql: string): Promise<QueryResult>
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
  async query(sql: string) {
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>
    return rowsToColumns(rows)
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
  async query(sql: string) {
    const [rows] = await this.pool.query(sql) as unknown as [Array<Record<string, unknown>>, unknown]
    return rowsToColumns(rows)
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
    const result = await this.pool.query('SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', [name])
    return result.rows.map((row: Record<string, unknown>) => ({
      name: String(row.column_name),
      type: String(row.data_type ?? ''),
      notNull: String(row.is_nullable) === 'NO',
      primaryKey: false,
    }))
  }
  async query(sql: string) {
    const result = await this.pool.query(sql)
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
