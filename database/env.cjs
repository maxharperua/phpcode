/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { parseEnv } = require('node:util');
const { t } = require('./localization.cjs');

/** Read data only; dotenv contents are never sourced or evaluated as shell code. */
function connectionFromEnv(text, projectName) {
	if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) { throw Error(t("Файл .env превышает допустимый размер 1 МБ.")); }
	const values = parseEnv(text); const resolved = new Map();
	const literal = new Set([...text.matchAll(/(?:^|\n)[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*'/g)].map(m => m[1]));
	const read = (key, stack = []) => {
		if (resolved.has(key)) { return resolved.get(key); }
		if (!Object.hasOwn(values, key) || stack.includes(key) || stack.length > 20) { throw Error(t("Не удалось разрешить ссылки на переменные в параметрах БД из .env.")); }
		const value = literal.has(key) ? values[key] : values[key].replace(/\$\{([\w.-]+)\}/g, (_, name) => read(name, [...stack, key]));
		resolved.set(key, value); return value;
	};
	let data;
	const engineName = values.DB_CONNECTION?.trim().toLowerCase();
	const engines = { mysql: 'mysql', mariadb: 'mysql', pgsql: 'postgres', postgres: 'postgres', postgresql: 'postgres' };
	if (engineName && !engines[engineName]) { return undefined; }
	const urlKey = values.DB_URL ? 'DB_URL' : values.DATABASE_URL ? 'DATABASE_URL' : undefined;
	if (urlKey) {
		try {
			const url = new URL(read(urlKey)); const engine = engines[url.protocol.slice(0, -1)]; if (!engine) { return undefined; }
			data = { engine, host: url.hostname, port: Number(url.port || (engine === 'mysql' ? 3306 : 5432)), user: decodeURIComponent(url.username), database: decodeURIComponent(url.pathname.slice(1)), password: decodeURIComponent(url.password), tls: ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')) };
		} catch { throw Error(t("Некорректный адрес подключения к БД в .env.")); }
	} else {
		if (!['DB_HOST', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD'].every(key => Object.hasOwn(values, key))) { return undefined; }
		const engine = engines[engineName] || 'mysql';
		data = { engine, host: read('DB_HOST'), port: Number(values.DB_PORT ? read('DB_PORT') : engine === 'mysql' ? 3306 : 5432), user: read('DB_USERNAME'), database: read('DB_DATABASE'), password: read('DB_PASSWORD'), tls: false };
	}
	const { password, ...config } = data;
	if (password.length > 4096) { throw Error(t("Некорректный пароль в .env.")); }
	return { config: { ...config, name: `${projectName} · ${data.database} (.env)` }, password };
}
module.exports = { connectionFromEnv };
