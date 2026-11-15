/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { t } = require('./localization.cjs');
const { mysql, pg } = require('./runtime/drivers.cjs');
const MAX_ROWS = 1000;
const MAX_BYTES = 4 * 1024 * 1024;
function configuration(value) {
	if (!value || !['mysql', 'postgres'].includes(value.engine)) { throw Error(t("Выберите MySQL/MariaDB или PostgreSQL.")); }
	const result = { engine: value.engine };
	for (const key of ['name', 'host', 'user', 'database']) {
		if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 512 || /[\0\r\n]/.test(value[key])) { throw Error(t("Заполните название, хост, пользователя и имя БД.")); }
		result[key] = value[key].trim();
	}
	result.port = Number(value.port);
	if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) { throw Error(t("Порт должен быть числом от 1 до 65535.")); }
	result.tls = value.tls === true;
	return result;
}
function cell(value) {
	if (value === null || value === undefined) { return { text: '', kind: 'null' }; }
	if (Buffer.isBuffer(value)) { return { text: value.toString('hex').slice(0, 256), kind: 'binary' }; }
	const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
	return { text: text.slice(0, 65536), kind: text.length > 65536 ? 'large' : 'text' };
}
class Database {
	constructor(config, password) { this.config = configuration(config); this.password = password; this.snapshot = undefined; }
	async connect() {
		const c = this.config;
		const options = { host: c.host, port: c.port, user: c.user, password: this.password, database: c.database, ssl: c.tls ? { rejectUnauthorized: true } : undefined };
		if (c.engine === 'mysql') {
			this.client = mysql.createConnection({ ...options, connectTimeout: 10000, multipleStatements: true, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true, charset: 'utf8mb4' });
			await new Promise((resolve, reject) => this.client.connect(error => error ? reject(error) : resolve()));
		} else {
			// Keep database values lossless, including bigint, decimal and timestamp.
			this.client = new pg.Client({ ...options, connectionTimeoutMillis: 10000, statement_timeout: 60000, lock_timeout: 10000, application_name: 'phpcode', types: { getTypeParser: () => value => value } });
			this.client.on('error', () => {});
			await this.client.connect();
		}
		this.password = undefined;
	}
	quote(name) { const q = this.config.engine === 'mysql' ? '`' : '"'; return q + name.replaceAll(q, q + q) + q; }
	qualified(table) { return this.quote(table.schema) + '.' + this.quote(table.name); }
	parameter(index) { return this.config.engine === 'mysql' ? '?' : '$' + index; }
	async query(sql, values = [], limit = MAX_ROWS) {
		if (typeof sql !== 'string' || !sql.trim() || sql.length > 2_000_000) { throw Error(t("Введите SQL-скрипт размером до 2 МБ.")); }
		let bytes = 0; let rowTotal = 0;
		const collect = (result, row) => {
			const size = row.reduce((n, value) => n + (value === null ? 4 : Buffer.isBuffer(value) ? value.length : String(value).length * 2), 0);
			if (result.rows.length < limit && rowTotal < 5000 && bytes + size < MAX_BYTES) { result.rows.push(row); bytes += size; rowTotal++; } else { result.truncated = true; }
		};
		if (this.config.engine === 'mysql') {
			return new Promise((resolve, reject) => {
				const results = []; let resultIndex = -1; const get = index => results[index] ||= { columns: [], rows: [], rowCount: 0 };
				const query = this.client.query({ sql, values, rowsAsArray: true });
				query.on('fields', fields => { get(++resultIndex).columns = fields ? fields.map(f => f.name) : []; });
				query.on('result', (row, index) => { const result = get(index ?? resultIndex); if (Array.isArray(row)) { result.rowCount++; collect(result, row); } else { result.rowCount = row.affectedRows || 0; result.command = 'OK'; } });
				query.on('error', reject); query.on('end', () => resolve(results));
			});
		}
		return new Promise((resolve, reject) => {
			const rows = new Map();
			const query = new pg.Query({ text: sql, ...(values.length ? { values } : {}), rowMode: 'array' });
			query.on('row', (row, result) => { if (!rows.has(result)) { rows.set(result, { rows: [] }); } collect(rows.get(result), row); });
			query.on('error', reject);
			query.on('end', result => resolve((Array.isArray(result) ? result : [result]).map(r => ({ columns: r.fields.map(f => f.name), rows: rows.get(r)?.rows || [], truncated: rows.get(r)?.truncated, rowCount: r.rowCount || 0, command: r.command }))));
			this.client.query(query);
		});
	}
	async rows(sql, values) { return (await this.query(sql, values, 6000))[0].rows; }
	async tables() {
		const mysql = this.config.engine === 'mysql';
		const rows = await this.rows(mysql ? 'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT 5000' : "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name LIMIT 5000", mysql ? [this.config.database] : []);
		return rows.map(([schema, name, type]) => ({ schema, name, view: type !== 'BASE TABLE' }));
	}
	async columns(table) {
		if (!table || typeof table.schema !== 'string' || typeof table.name !== 'string') { throw Error(t("Таблица не выбрана.")); }
		const mysql = this.config.engine === 'mysql';
		const rows = await this.rows(mysql ? 'SELECT COLUMN_NAME,COLUMN_TYPE,COLUMN_KEY,EXTRA,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION' : `SELECT c.column_name,c.data_type,CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON k.constraint_name=t.constraint_name AND k.constraint_schema=t.constraint_schema AND k.table_name=t.table_name WHERE t.constraint_type='PRIMARY KEY' AND t.table_schema=c.table_schema AND t.table_name=c.table_name AND k.column_name=c.column_name) THEN 'PRI' ELSE '' END,c.is_generated || ':' || c.is_identity,c.is_nullable FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position`, [table.schema, table.name]);
		return rows.map(([name, type, key, extra, nullable]) => ({ name, type, primary: key === 'PRI', generated: mysql ? /GENERATED/i.test(extra) : extra.startsWith('ALWAYS') || extra.endsWith(':YES'), nullable: nullable === 'YES' }));
	}
	async page(table, offset = 0, requested = {}) {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000000) { throw Error(t("Некорректная страница.")); }
		const columns = await this.columns(table); if (!columns.length) { throw Error(t("Таблица недоступна или удалена.")); }
		if (!requested || typeof requested !== 'object' || Array.isArray(requested)) { throw Error(t("Некорректные параметры поиска или сортировки.")); }
		const view = { search: requested.search ?? '', searchColumn: requested.searchColumn ?? null, sort: requested.sort ?? null };
		if (typeof view.search !== 'string' || view.search.length > 500 || view.searchColumn !== null && (!Number.isInteger(view.searchColumn) || !columns[view.searchColumn]) || view.sort !== null && (!Number.isInteger(view.sort.column) || !columns[view.sort.column] || !['asc', 'desc'].includes(view.sort.direction))) { throw Error(t("Некорректные параметры поиска или сортировки.")); }
		const keys = columns.filter(c => c.primary);
		const order = view.sort ? [this.quote(columns[view.sort.column].name) + (view.sort.direction === 'desc' ? ' DESC' : ' ASC'), ...keys.filter(c => c !== columns[view.sort.column]).map(c => this.quote(c.name) + ' ASC')] : (keys.length ? keys : columns.slice(0, 1)).map(c => this.quote(c.name) + ' ASC');
		const values = []; let where = '';
		if (view.search) {
			const pattern = '%' + view.search.replace(/[!%_]/g, '!$&') + '%';
			const searched = columns.filter((c, index) => (view.searchColumn === null || view.searchColumn === index) && !/blob|binary|bytea|geometry/i.test(c.type));
			const terms = searched.map(c => { values.push(pattern); const expression = this.config.engine === 'mysql' ? `CAST(${this.quote(c.name)} AS CHAR)` : `${this.quote(c.name)}::text`; return `${expression} ${this.config.engine === 'mysql' ? 'LIKE' : 'ILIKE'} ${this.parameter(values.length)} ESCAPE '!'`; });
			where = ' WHERE ' + (terms.length ? '(' + terms.join(' OR ') + ')' : '1=0');
		}
		const data = await this.rows(`SELECT ${columns.map(c => this.quote(c.name)).join(',')} FROM ${this.qualified(table)}${where} ORDER BY ${order.join(',')} LIMIT 201 OFFSET ${offset}`, values);
		this.snapshot = { table, columns, rows: data.slice(0, 200) };
		return { columns, rows: this.snapshot.rows.map(row => row.map(cell)), offset, hasMore: data.length > 200, editable: !table.view && keys.length > 0, view };
	}
	async change(changes) {
		const snapshot = this.snapshot;
		if (!snapshot || snapshot.table.view || !snapshot.columns.some(c => c.primary)) { throw Error(t("Редактирование доступно только таблицам с первичным ключом.")); }
		if (!Array.isArray(changes) || !changes.length || changes.length > 500) { throw Error(t("Нет изменений или превышен лимит 500 строк.")); }
		const { columns, table, rows } = snapshot; const seen = new Set();
		await this.query('BEGIN');
		try {
			for (const change of changes) {
				if (!['update', 'delete', 'insert'].includes(change.kind)) { throw Error(t("Неизвестное изменение.")); }
				const values = []; const bind = v => { values.push(v); return this.parameter(values.length); };
				const entries = Object.entries(change.values || {}).map(([index, value]) => {
					const c = columns[Number(index)];
					if (!c || c.generated || !/^(0|[1-9]\d*)$/.test(index) || value !== null && (typeof value !== 'string' || value.length > 65536)) { throw Error(t("Недопустимое значение ячейки.")); }
					return [Number(index), c, value];
				});
				let sql;
				if (change.kind === 'insert') {
					if (!entries.length) { throw Error(t("Заполните новую строку.")); }
					sql = `INSERT INTO ${this.qualified(table)} (${entries.map(e => this.quote(e[1].name)).join(',')}) VALUES (${entries.map(e => bind(e[2])).join(',')})`;
				} else {
					if (!Number.isInteger(change.row) || !rows[change.row] || seen.has(change.row)) { throw Error(t("Строка устарела. Обновите таблицу.")); } seen.add(change.row);
					const original = rows[change.row];
					if (change.kind === 'update' && !entries.length) { continue; }
					for (const [index] of entries) { if (!['text', 'null'].includes(cell(original[index]).kind)) { throw Error(t("Бинарные и большие значения редактируются через SQL.")); } }
					const set = entries.map(e => this.quote(e[1].name) + '=' + bind(e[2])).join(',');
					// Compare the original values too; never silently overwrite another client's edits.
					const guarded = columns.map((c, i) => ({ c, i })).filter(({ c, i }) => c.primary || (change.kind === 'delete' ? !/blob|binary|json|bytea|geometry/i.test(c.type) : entries.some(e => e[0] === i)));
					const where = guarded.map(({ c, i }) => `${this.quote(c.name)} ${this.config.engine === 'mysql' ? '<=>' : 'IS NOT DISTINCT FROM'} ${bind(original[i])}`).join(' AND ');
					sql = change.kind === 'delete' ? `DELETE FROM ${this.qualified(table)} WHERE ${where}` : `UPDATE ${this.qualified(table)} SET ${set} WHERE ${where}`;
				}
				const result = (await this.query(sql, values))[0];
				if (result.rowCount !== 1) { throw Error(t("Строка изменена другим клиентом. Изменения отменены; обновите таблицу.")); }
			}
			await this.query('COMMIT'); this.snapshot = undefined;
		} catch (error) { await this.query('ROLLBACK').catch(() => {}); throw error; }
	}
	async close() { if (this.client) { if (this.config.engine === 'mysql') { this.client.destroy(); } else { await this.client.end().catch(() => {}); } } }
}
module.exports = { Database, configuration, cell };
