/**
 * 数据库适配器层：sqlite（node:sqlite 内置）/ mysql（mysql2）/ postgres（pg）三实现。
 * 统一接口：listTables / describeTable / query / exec / ping / close。
 *
 * @module dsh-sql/adapters
 */
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { assertIdentifier } from './config.js';
function toValue(value) {
    if (typeof value === 'bigint')
        return Number(value);
    if (value instanceof Date)
        return value.toISOString();
    if (value instanceof Uint8Array)
        return Array.from(value);
    if (value instanceof Map)
        return Object.fromEntries(value);
    return value;
}
function rowsToColumns(rows) {
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const values = rows.map((row) => columns.map((column) => toValue(row[column])));
    return { columns, rows: values };
}
function quoteSqliteIdentifier(name) {
    return '"' + name.replace(/"/g, '""') + '"';
}
/** SQLite 适配器（node:sqlite，零依赖）。 */
class SqliteAdapter {
    engine = 'sqlite';
    db;
    constructor(file) {
        this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
        this.db.exec('PRAGMA busy_timeout = 5000');
    }
    async listTables() {
        const result = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        return result.map((row) => String(row.name));
    }
    async describeTable(table) {
        const name = assertIdentifier(table, '表名');
        const rows = this.db.prepare('PRAGMA table_info(' + quoteSqliteIdentifier(name) + ')').all();
        return rows.map((row) => ({
            name: String(row.name),
            type: String(row.type ?? ''),
            notNull: Number(row.notnull) === 1,
            primaryKey: Number(row.pk) === 1,
        }));
    }
    async query(sql, limit) {
        const statement = this.db.prepare(sql);
        if (limit === undefined || limit <= 0) {
            const rows = statement.all();
            return rowsToColumns(rows);
        }
        const columns = statement.columns().map((column) => column.name);
        const rows = [];
        for (const raw of statement.iterate()) {
            const row = raw;
            rows.push(columns.map((name) => toValue(row[name])));
            if (rows.length >= limit)
                break;
        }
        return { columns, rows };
    }
    async exec(sql) {
        const single = sql.replace(/;\s*$/, '').trim();
        if (single.includes(';')) {
            this.db.exec(sql);
            return 0;
        }
        const result = this.db.prepare(single).run();
        return Number(result.changes);
    }
    async ping() {
        this.db.prepare('SELECT 1').get();
    }
    async close() {
        this.db.close();
    }
}
/** MySQL 适配器（mysql2 连接池）。 */
class MysqlAdapter {
    engine = 'mysql';
    pool;
    constructor(connection) {
        this.pool = mysql.createPool({
            host: connection.host ?? 'localhost',
            port: connection.port ?? 3306,
            user: connection.user ?? '',
            password: connection.password ?? '',
            database: connection.database ?? '',
            connectionLimit: 5,
            enableKeepAlive: true,
        });
    }
    async listTables() {
        const [rows] = await this.pool.query('SHOW TABLES');
        return rows.map((row) => String(Object.values(row)[0] ?? ''));
    }
    async describeTable(table) {
        const name = assertIdentifier(table, '表名');
        const [rows] = await this.pool.query('DESCRIBE `' + name + '`');
        return rows.map((row) => ({
            name: String(row.Field),
            type: String(row.Type ?? ''),
            notNull: String(row.Null ?? '').toUpperCase() === 'NO',
            primaryKey: String(row.Key ?? '').toUpperCase() === 'PRI',
        }));
    }
    async query(sql, limit) {
        if (limit === undefined || limit <= 0) {
            const [rows] = await this.pool.query(sql);
            return rowsToColumns(rows);
        }
        const corePool = this.pool.pool;
        return await new Promise((resolve, reject) => {
            let settled = false;
            let columns = [];
            const rows = [];
            const stream = corePool.query(sql).stream({ highWaterMark: 64 });
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                resolve({ columns, rows });
            };
            stream.on('fields', (fields) => {
                columns = fields.map((field) => field.name);
            });
            stream.on('result', (row) => {
                if (columns.length === 0)
                    columns = Object.keys(row);
                rows.push(columns.map((name) => toValue(row[name])));
                if (rows.length >= limit)
                    stream.destroy();
            });
            stream.on('end', finish);
            stream.on('close', finish);
            stream.on('error', (error) => {
                if (settled)
                    return;
                settled = true;
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    async exec(sql) {
        const [result] = await this.pool.query(sql);
        return Number(result?.affectedRows ?? 0);
    }
    async ping() {
        await this.pool.query('SELECT 1');
    }
    async close() {
        await this.pool.end();
    }
}
/** PostgreSQL 适配器（pg 连接池）。 */
class PostgresAdapter {
    engine = 'postgres';
    pool;
    constructor(connection) {
        this.pool = new pg.Pool({
            host: connection.host ?? 'localhost',
            port: connection.port ?? 5432,
            user: connection.user ?? '',
            password: connection.password ?? '',
            database: connection.database ?? '',
            max: 5,
        });
    }
    async listTables() {
        const result = await this.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
        return result.rows.map((row) => String(row.table_name));
    }
    async describeTable(table) {
        const name = assertIdentifier(table, '表名');
        const result = await this.pool.query(`SELECT c.column_name, c.data_type, c.is_nullable,
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
        ORDER BY c.ordinal_position`, [name]);
        return result.rows.map((row) => ({
            name: String(row.column_name),
            type: String(row.data_type ?? ''),
            notNull: String(row.is_nullable) === 'NO',
            primaryKey: row.is_primary === true,
        }));
    }
    async query(sql, limit) {
        if (limit === undefined || limit <= 0) {
            const result = await this.pool.query(sql);
            const rows = result.rows;
            return rowsToColumns(rows);
        }
        const result = await this.pool.query({ text: sql, values: [], rows: limit });
        const rows = result.rows;
        return rowsToColumns(rows);
    }
    async exec(sql) {
        const result = await this.pool.query(sql);
        return Number(result.rowCount ?? 0);
    }
    async ping() {
        await this.pool.query('SELECT 1');
    }
    async close() {
        await this.pool.end();
    }
}
/** 按连接配置创建适配器。 */
export function createAdapter(connection) {
    if (connection.engine === 'sqlite')
        return new SqliteAdapter(connection.file ?? ':memory:');
    if (connection.engine === 'mysql')
        return new MysqlAdapter(connection);
    return new PostgresAdapter(connection);
}
