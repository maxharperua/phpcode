/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const built = path.resolve(__dirname, '../../phpcode-oss/extensions/phpcode-database');
const { Database, configuration } = require(path.join(built, 'database.cjs'));
const { Session } = require(path.join(built, 'session.cjs'));
test('connection metadata excludes passwords and rejects invalid ports and blank identifiers', () => {
	const c = { engine: 'mysql', name: 'test', host: '127.0.0.1', user: 'root', database: 'db', port: 3306, password: 'never-store' };
	assert.ok(!Object.hasOwn(configuration(c), 'password')); assert.throws(() => configuration({ ...c, port: '3306;sql' })); assert.throws(() => configuration({ ...c, host: '' }));
});
for (const engine of ['mysql', 'postgres']) {
	test(`${engine}: real tables, quoted names, exact values, atomic edits, conflicts, scripts and cancellation`, async () => {
		const output = execFileSync('docker', ['port', 'phpcode-db-test-' + engine, engine === 'mysql' ? '3306' : '5432'], { encoding: 'utf8' });
		const config = { engine, name: engine, host: '127.0.0.1', port: Number(output.trim().split(':').at(-1)), user: engine === 'mysql' ? 'root' : 'postgres', database: 'phpcode_test' };
		const db = new Database(config, 'phpcode-test'); const other = new Database(config, 'phpcode-test');
		await db.connect(); await other.connect();
		const table = { schema: engine === 'mysql' ? 'phpcode_test' : 'public', name: 'odd"`table', view: false }; const qualified = db.qualified(table);
		try {
			await db.query(`DROP TABLE IF EXISTS ${qualified}; CREATE TABLE ${qualified}(id BIGINT PRIMARY KEY, name VARCHAR(100), amount DECIMAL(30,8), optional VARCHAR(100))`);
			await db.query(`INSERT INTO ${qualified} VALUES (9007199254740993,'first',12345678901234567890.12345678,NULL),(2,'second',1.5,'')`);
			assert.ok((await db.tables()).some(t => t.name === table.name));
			let page = await db.page(table, 0); assert.equal(page.editable, true); assert.equal(page.rows[1][0].text, '9007199254740993'); assert.equal(page.rows[1][2].text, '12345678901234567890.12345678'); assert.equal(page.rows[1][3].kind, 'null');
			await db.change([{ kind: 'update', row: 1, values: { 1: "quote '; DROP TABLE nope; --", 3: '' } }, { kind: 'insert', values: { 0: '3', 1: 'third', 2: '2.25', 3: null } }]);
			page = await db.page(table, 0); assert.equal(page.rows.length, 3); assert.equal(page.rows[2][1].text, "quote '; DROP TABLE nope; --"); assert.equal(page.rows[2][3].kind, 'text');
			await other.query(`UPDATE ${qualified} SET name='other client' WHERE id=9007199254740993`);
			await assert.rejects(db.change([{ kind: 'update', row: 0, values: { 1: 'must rollback' } }, { kind: 'update', row: 2, values: { 1: 'stale edit' } }]), /другим клиентом/);
			page = await db.page(table, 0); assert.equal(page.rows[0][1].text, 'second'); assert.equal(page.rows[2][1].text, 'other client');
			await db.change([{ kind: 'delete', row: 1 }]); assert.equal((await db.page(table, 0)).rows.length, 2);
			await db.query(`INSERT INTO ${qualified}(id,name,amount) VALUES ` + Array.from({ length: 600 }, (_, n) => `(${n + 100},'row-${String(n).padStart(3, '0')}',${n})`).join(','));
			await db.query(`UPDATE ${qualified} SET name=${db.parameter(1)} WHERE id=699`, ['late_%!entry']);
			const descending = await db.page(table, 0, { sort: { column: 0, direction: 'desc' } }); assert.equal(descending.rows[0][0].text, '9007199254740993'); assert.equal(descending.rows[1][0].text, '699'); assert.equal(descending.hasMore, true);
			const next = await db.page(table, 200, descending.view); assert.equal(next.rows[0][0].text, '500');
			const filtered = await db.page(table, 0, { search: 'late_%!entry', sort: { column: 0, direction: 'desc' } }); assert.equal(filtered.rows.length, 1); assert.equal(filtered.rows[0][0].text, '699');
			assert.equal((await db.page(table, 0, { search: '%', searchColumn: 1 })).rows.length, 1);
			assert.equal((await db.page(table, 0, { search: 'late_%!entry', searchColumn: 3 })).rows.length, 0);
			assert.equal((await db.page(table, 0, { search: "' OR 1=1 --" })).rows.length, 0);
			await db.change([{ kind: 'insert', values: { 0: '700', 1: 'edit under filter', 2: '0' } }]);
			await db.page(table, 0, { search: 'edit under filter' }); await db.change([{ kind: 'update', row: 0, values: { 1: 'saved filtered row' } }]); assert.equal((await db.page(table, 0, { search: 'saved filtered row' })).rows[0][0].text, '700');
			await assert.rejects(db.page(table, 0, { sort: { column: 99, direction: 'asc' } }), /Некорректные параметры/);
			await assert.rejects(db.page(table, 0, { sort: { column: 0, direction: 'desc; DROP TABLE' } }), /Некорректные параметры/);
			const script = await db.query('SELECT 1 AS one; SELECT 2 AS two;'); assert.deepEqual(script.map(r => r.columns), [['one'], ['two']]);
			const limited = await db.query(engine === 'mysql' ? 'SELECT seq FROM seq_1_to_1500' : 'SELECT generate_series(1,1500)'); assert.equal(limited[0].rows.length, 1000); assert.equal(limited[0].truncated, true);
			const worker = new Session(config, 'phpcode-test');
			try { const pending = worker.call('query', { sql: engine === 'mysql' ? 'SELECT SLEEP(30)' : 'SELECT pg_sleep(30)' }); setTimeout(() => worker.dispose(), 500); await assert.rejects(pending, /остановлена/); } finally { worker.dispose(); }
		} finally { await db.query(`DROP TABLE IF EXISTS ${qualified}`).catch(() => {}); await db.close(); await other.close(); }
	});
}
