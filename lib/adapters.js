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
function abortReason(signal) {
    if (signal.reason !== undefined)
        return signal.reason;
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}
function toValue(value) {
    if (typeof value === 'bigint') {
        if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
            return Number(value);
        }
        return value.toString();
    }
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
function streamMysqlQuery(corePool, sql, limit, discard) {
    return new Promise((resolve, reject) => {
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
        // Consume the Readable, otherwise mysql2 pauses forever at highWaterMark.
        stream.on('data', (row) => {
            if (settled)
                return;
            if (columns.length === 0)
                columns = Object.keys(row);
            rows.push(columns.map((name) => toValue(row[name])));
            if (rows.length >= limit) {
                finish();
                stream.destroy();
                // mysql2 resumes its connection when only the Readable is destroyed.
                discard();
            }
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
/**
 * int8（OID 20）解析：安全整数返回 number，超出返回十进制字符串。
 *
 * pg 默认把 int8 一律解析成字符串 —— 连 `42::bigint` 都返回 "42"，与本插件「安全范围内输出
 * number、超出输出十进制字符串」的承诺不符（真实 PostgreSQL 16 实测确认）。
 */
function parseInt8(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
}
/**
 * 查询级类型解析器：只覆盖 int8，其余交回 pg 默认实现。
 * 走 QueryConfig.types 而不是改 `pg.types` 全局注册表，避免影响同进程其它 pg 使用者。
 */
const READ_TYPES = {
    getTypeParser: (oid, format) => (oid === 20 ? parseInt8 : pg.types.getTypeParser(oid, format)),
};
function readQueryConfig(sql) {
    return { text: sql, queryMode: 'extended', types: READ_TYPES };
}
/** pg's `rows` option is a page size; row events avoid its full result accumulator. */
function streamPostgresQuery(client, sql, limit, discard) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let columns = [];
        const rows = [];
        const query = new pg.Query(readQueryConfig(sql));
        query.on('row', (row, result) => {
            if (settled)
                return;
            if (columns.length === 0)
                columns = result?.fields.map((field) => field.name) ?? Object.keys(row);
            rows.push(columns.map((name) => toValue(row[name])));
            if (rows.length >= limit) {
                // Closing this dedicated connection stops server work and prevents reuse.
                settled = true;
                discard();
                resolve({ columns, rows });
            }
        });
        query.on('end', (result) => {
            if (settled)
                return;
            settled = true;
            if (columns.length === 0)
                columns = result.fields.map((field) => field.name);
            resolve({ columns, rows });
        });
        // Keep this listener after reaching the cap: destroying the client can emit
        // the driver's asynchronous connection-closed error on this active query.
        query.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        });
        client.query(query);
    });
}
/** SQLite 适配器（node:sqlite，零依赖）。 */
class SqliteAdapter {
    engine = 'sqlite';
    db;
    constructor(file) {
        this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
        this.db.exec('PRAGMA busy_timeout = 5000');
    }
    async listTables(signal) {
        signal?.throwIfAborted();
        const result = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        signal?.throwIfAborted();
        return result.map((row) => String(row.name));
    }
    async describeTable(table, signal) {
        signal?.throwIfAborted();
        const name = assertIdentifier(table, '表名');
        const rows = this.db.prepare('PRAGMA table_info(' + quoteSqliteIdentifier(name) + ')').all();
        signal?.throwIfAborted();
        return rows.map((row) => ({
            name: String(row.name),
            type: String(row.type ?? ''),
            notNull: Number(row.notnull) === 1,
            primaryKey: Number(row.pk) === 1,
        }));
    }
    async query(sql, limit, signal) {
        signal?.throwIfAborted();
        // 引擎级兜底：读取路径整段包在 query_only 里，即使词法守卫被绕过，改数据的语句也会被
        // SQLite 自己拒绝（query_only 拦不住 journal_mode(WAL)/optimize 这类 PRAGMA，那部分由
        // assertReadQuery 的 PRAGMA 规则负责）。
        // node:sqlite 全同步，这段没有 await，不会与 sql_exec 交错。
        this.db.exec('PRAGMA query_only = ON');
        try {
            const statement = this.db.prepare(sql);
            if (limit === undefined || limit <= 0) {
                const rows = statement.all();
                signal?.throwIfAborted();
                return rowsToColumns(rows);
            }
            const columns = statement.columns().map((column) => column.name);
            const rows = [];
            for (const raw of statement.iterate()) {
                const row = raw;
                rows.push(columns.map((name) => toValue(row[name])));
                signal?.throwIfAborted();
                if (rows.length >= limit)
                    break;
            }
            return { columns, rows };
        }
        finally {
            this.db.exec('PRAGMA query_only = OFF');
        }
    }
    async exec(sql, signal) {
        signal?.throwIfAborted();
        const single = sql.replace(/;\s*$/, '').trim();
        if (single.includes(';')) {
            this.db.exec(sql);
            signal?.throwIfAborted();
            return 0;
        }
        const result = this.db.prepare(single).run();
        signal?.throwIfAborted();
        return Number(result.changes);
    }
    async ping(signal) {
        signal?.throwIfAborted();
        this.db.prepare('SELECT 1').get();
        signal?.throwIfAborted();
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
            // 保持 mysql2 默认的单语句模式：这是 MySQL 侧的引擎级保证 —— 即使词法守卫被绕过，
            //  smuggled 的分号也无法变成第二条语句（只管 sql_exec 的多语句脚本会因此报错）。
            multipleStatements: false,
            // BIGINT 保真：默认配置下 9223372036854775807 会被静默读成 9223372036854776000
            // （真实 MySQL 8.0 实测）；这两个选项让超出安全整数范围的值以十进制字符串返回，
            // 范围内的仍是 number，与新描述一致。
            supportBigNumbers: true,
            bigNumberStrings: false,
        });
    }
    async withSignalConnection(signal, work) {
        signal?.throwIfAborted();
        const connection = await this.pool.getConnection();
        let destroyed = false;
        let rejectAbort = () => { };
        const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
        const discard = () => {
            if (destroyed)
                return;
            destroyed = true;
            connection.destroy();
        };
        const onAbort = () => {
            discard();
            rejectAbort(abortReason(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            signal?.throwIfAborted();
            return await Promise.race([work(connection, discard), aborted]);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            if (!destroyed)
                connection.release();
        }
    }
    async queryRows(sql, signal) {
        if (signal === undefined)
            return await this.pool.query(sql);
        return await this.withSignalConnection(signal, async (connection) => await connection.query(sql));
    }
    async listTables(signal) {
        const [rows] = await this.queryRows('SHOW TABLES', signal);
        return rows.map((row) => String(Object.values(row)[0] ?? ''));
    }
    async describeTable(table, signal) {
        const name = assertIdentifier(table, '表名');
        const [rows] = await this.queryRows('DESCRIBE `' + name + '`', signal);
        return rows.map((row) => ({
            name: String(row.Field),
            type: String(row.Type ?? ''),
            notNull: String(row.Null ?? '').toUpperCase() === 'NO',
            primaryKey: String(row.Key ?? '').toUpperCase() === 'PRI',
        }));
    }
    async query(sql, limit, signal) {
        if (limit === undefined || limit <= 0) {
            const [rows] = await this.queryRows(sql, signal);
            // 不产生结果集的语句（例如 `SELECT ... INTO OUTFILE`）返回的是 ResultSetHeader，
            // 不是行数组：直接喂给 rowsToColumns 会抛 `rows.map is not a function`（真实 MySQL 8.0 实测）。
            return rowsToColumns(Array.isArray(rows) ? rows : []);
        }
        // 流式读路径的前提是该语句会产生结果集。mysql2 的 Readable 只在核心命令 end 时收尾，
        // 而「只有 OK 包、没有结果集」的语句不会触发它 —— 那种语句在 sql_query 里已被守卫
        // （INTO / FOR UPDATE 等）挡掉，这里依赖该不变量。
        return await this.withSignalConnection(signal, async (connection, discard) => {
            const coreConnection = connection.connection;
            return await streamMysqlQuery(coreConnection, sql, limit, discard);
        });
    }
    async exec(sql, signal) {
        const [result] = await this.queryRows(sql, signal);
        return Number(result?.affectedRows ?? 0);
    }
    async ping(signal) {
        await this.queryRows('SELECT 1', signal);
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
    async withSignalClient(signal, work) {
        signal?.throwIfAborted();
        const client = await this.pool.connect();
        let destroyed = false;
        let rejectAbort = () => { };
        const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
        const discard = () => {
            if (destroyed)
                return;
            destroyed = true;
            client.release(true);
        };
        const onAbort = () => {
            discard();
            rejectAbort(abortReason(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            signal?.throwIfAborted();
            return await Promise.race([work(client, discard), aborted]);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            if (!destroyed)
                client.release();
        }
    }
    async queryWithSignal(query, values, signal) {
        const run = async (client) => {
            return values === undefined ? await client.query(query) : await client.query(query, values);
        };
        if (signal === undefined)
            return await run(this.pool);
        return await this.withSignalClient(signal, run);
    }
    async listTables(signal) {
        const result = await this.queryWithSignal("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name", undefined, signal);
        return result.rows.map((row) => String(row.table_name));
    }
    async describeTable(table, signal) {
        const name = assertIdentifier(table, '表名');
        const result = await this.queryWithSignal(`SELECT c.column_name, c.data_type, c.is_nullable,
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
        ORDER BY c.ordinal_position`, [name], signal);
        return result.rows.map((row) => ({
            name: String(row.column_name),
            type: String(row.data_type ?? ''),
            notNull: String(row.is_nullable) === 'NO',
            primaryKey: row.is_primary === true,
        }));
    }
    async query(sql, limit, signal) {
        if (limit === undefined || limit <= 0) {
            const result = await this.queryWithSignal(readQueryConfig(sql), undefined, signal);
            const rows = result.rows;
            return rowsToColumns(rows);
        }
        return await this.withSignalClient(signal, async (client, discard) => {
            return await streamPostgresQuery(client, sql, limit, discard);
        });
    }
    async exec(sql, signal) {
        const result = await this.queryWithSignal(sql, undefined, signal);
        return Number(result.rowCount ?? 0);
    }
    async ping(signal) {
        await this.queryWithSignal('SELECT 1', undefined, signal);
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
