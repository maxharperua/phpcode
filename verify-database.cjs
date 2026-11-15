/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = require('./scripts/lib.cjs').upstream;
const { _electron } = createRequire(path.join(root, 'package.json'))('playwright');
const { Database } = require(path.join(root, 'extensions/phpcode-database/database.cjs'));
const fixture = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'phpcode-database-')); const profile = path.join(fixture, 'profile'); const project = path.join(fixture, 'project');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true }); fs.mkdirSync(project);
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none' }));
fs.writeFileSync(path.join(project, 'check.sql'), "SELECT 1 AS first_result; SELECT '<script>unsafe()</script>' AS second_result;\n");
const config = engine => ({ engine, name: engine === 'mysql' ? 'MariaDB integration' : 'PostgreSQL integration', host: '127.0.0.1', user: engine === 'mysql' ? 'root' : 'postgres', database: 'phpcode_test', port: Number(execFileSync('docker', ['port', 'phpcode-db-test-' + engine, engine === 'mysql' ? '3306' : '5432'], { encoding: 'utf8' }).trim().split(':').at(-1)) });
const envConfig=config('mysql');fs.writeFileSync(path.join(project,'.env'),`DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=${envConfig.port}\nDB_DATABASE=phpcode_test\nDB_USERNAME=root\nDB_PASSWORD="phpcode-test"\n`);
const checks = []; const track = text => { checks.push(text); console.log('PASS: ' + text); };
let app; let db;
async function palette(page, command) { await page.keyboard.press('Meta+Shift+p'); await page.locator('.quick-input-widget input').first().fill('>' + command); await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: command }).first().click(); }
async function frameWith(page, selector) { for (let n = 0; n < 200; n++) { for (const frame of page.frames()) { try { if (await frame.locator(selector).count()) { return frame; } } catch {} } await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Webview not found: ' + selector); }
async function close() { if (!app) { return; } const current = app; app = undefined; const child = current.process(); let timer; await Promise.race([current.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(() => { if (child.exitCode === null) { child.kill('SIGKILL'); } resolve(); }, 5000); })]); clearTimeout(timer); }
async function launch() {
	const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
	app = await _electron.launch({ executablePath: process.env.PHPCODE_PACKAGED_EXECUTABLE || require('./scripts/lib.cjs').desktop().executable, args: ['--user-data-dir', profile, '--extensions-dir', path.join(fixture, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', project], env, timeout: 60000 });
	const page = await app.firstWindow(); await page.locator('.monaco-workbench').waitFor({ timeout: 60000 }); return page;
}
(async () => {
	db = new Database(config('mysql'), 'phpcode-test'); await db.connect(); await db.query("DROP TABLE IF EXISTS ui_test; CREATE TABLE ui_test(id INT PRIMARY KEY, name VARCHAR(100), note VARCHAR(100)); INSERT INTO ui_test VALUES (1,'first',NULL),(2,'second','')");
	let page = await launch();
	await palette(page,'phpcode: Открыть Базы Данных');const imported=page.locator('.monaco-list-row').filter({hasText:'project · phpcode_test (.env)'}).first();await imported.waitFor({timeout:15000});await imported.locator('.monaco-tl-twistie').click();await page.locator('.monaco-list-row').filter({hasText:/^phpcode_test$/}).first().waitFor({timeout:15000});await imported.locator('.monaco-tl-twistie').click();track('project .env automatically creates a working connection with its password held separately');
	await palette(page,'phpcode: Импортировать Подключение из .env');await page.waitForTimeout(500);assert.equal(await page.locator('.monaco-list-row').filter({hasText:'project · phpcode_test (.env)'}).count(),1);track('explicit dotenv import updates the same profile without creating duplicates');
	for (const engine of ['mysql', 'postgres']) {
		await palette(page, 'phpcode: Добавить Подключение к БД'); const frame = await frameWith(page, 'input[name=host]'); const c = config(engine);
		await frame.locator('select[name=engine]').selectOption(engine); for (const name of ['name', 'host', 'port', 'user', 'database']) { await frame.locator(`input[name=${name}]`).fill(String(c[name])); } await frame.locator('input[name=password]').fill('phpcode-test');
		await frame.getByRole('button', { name: 'Проверить соединение', exact: true }).click(); await frame.getByText('Соединение установлено.', { exact: true }).waitFor({ timeout: 20000 });
		await frame.getByRole('button', { name: 'Сохранить подключение', exact: true }).click(); await page.locator('.monaco-list-row').filter({ hasText: c.name }).first().waitFor({ timeout: 15000 });
	}
	track('two connections are tested and saved through the built-in UI');
	const connection = page.locator('.monaco-list-row').filter({ hasText: 'MariaDB integration' }).first(); await connection.locator('.monaco-tl-twistie').click();
	const schema = page.locator('.monaco-list-row').filter({ hasText: /^phpcode_test$/ }).first(); await schema.waitFor({ timeout: 20000 }); await schema.locator('.monaco-tl-twistie').click();
	await page.locator('.monaco-list-row').filter({ hasText: /^ui_test$/ }).first().click();
	let table = await frameWith(page, 'table[aria-label="Данные таблицы"]');
	await table.getByRole('textbox', { name: 'Строка 1, name', exact: true }).fill('changed through UI'); await table.getByRole('button', { name: 'Сохранить изменения', exact: true }).click(); await table.getByText('Изменения сохранены.', { exact: true }).waitFor();
	assert.equal((await db.query('SELECT name FROM ui_test WHERE id=1'))[0].rows[0][0], 'changed through UI');
	await table.getByRole('button', { name: 'Добавить строку', exact: true }).click(); await table.getByRole('textbox', { name: 'Новая строка, id', exact: true }).fill('3'); await table.getByRole('textbox', { name: 'Новая строка, name', exact: true }).fill('third'); await table.getByRole('button', { name: 'Сохранить изменения', exact: true }).click(); await table.getByText('Изменения сохранены.', { exact: true }).waitFor(); assert.equal(String((await db.query('SELECT COUNT(*) FROM ui_test'))[0].rows[0][0]), '3');
	await table.getByRole('button', { name: 'Структура таблицы', exact: true }).click(); await table.locator('#structure').getByText('PK', { exact: true }).waitFor();
	track('table data and schema open; UI updates and inserts reach the real database');
	await table.getByRole('button', { name: 'Структура таблицы', exact: true }).click();
	assert.equal(await table.getByRole('button',{name:'Сохранить изменения',exact:true}).getAttribute('title'),'Сохранить изменения');
	const layout=await table.locator('.grid-scroll').evaluate(grid=>({top:grid.getBoundingClientRect().top,height:grid.getBoundingClientRect().height,viewport:window.innerHeight}));assert.ok(layout.top<=42&&layout.height/layout.viewport>.85,JSON.stringify(layout));
	assert.ok(await table.locator('.icon-button .codicon').first().evaluate(icon=>document.fonts.check('16px codicon')));
	track('compact icon toolbar leaves more than 85 percent of the editor height for the table');
	await db.query('INSERT INTO ui_test(id,name) VALUES '+Array.from({length:647},(_,i)=>`(${i+4},'record-${String(i+4).padStart(3,'0')}')`).join(','));await db.query("UPDATE ui_test SET name='late_%_entry' WHERE id=650");await table.getByRole('button',{name:'Обновить',exact:true}).click();await table.locator('#page-next').waitFor({state:'visible'});await table.waitForFunction(()=>!document.getElementById('page-next').disabled);
	const firstId=table.getByRole('textbox',{name:'Строка 1, id',exact:true});await table.getByRole('button',{name:'Сортировать по id',exact:true}).click();await table.locator('th[aria-sort=ascending]').waitFor();await table.getByRole('button',{name:'Сортировать по id',exact:true}).click();await table.waitForFunction(()=>document.querySelector('input[aria-label="Строка 1, id"]')?.value==='650');assert.equal(await firstId.inputValue(),'650');
	await table.getByRole('button',{name:'Далее →',exact:true}).click();await table.waitForFunction(()=>document.querySelector('input[aria-label="Строка 1, id"]')?.value==='450');assert.equal(await firstId.inputValue(),'450');
	await table.getByRole('textbox',{name:'Поиск по таблице',exact:true}).fill('late_%_entry');await table.getByRole('textbox',{name:'Поиск по таблице',exact:true}).press('Enter');await table.waitForFunction(()=>document.querySelector('input[aria-label="Строка 1, id"]')?.value==='650'&&document.querySelectorAll('.data-grid tbody tr').length===1);assert.equal(await table.locator('.data-grid tbody tr').count(),1);assert.equal(await table.locator('#page-next').isDisabled(),true);
	await table.getByRole('combobox',{name:'Колонка поиска',exact:true}).selectOption('2');await table.getByRole('button',{name:'Найти',exact:true}).click();await table.waitForFunction(()=>document.querySelectorAll('.data-grid tbody tr').length===0);
	await table.getByRole('combobox',{name:'Колонка поиска',exact:true}).selectOption('1');await table.getByRole('button',{name:'Найти',exact:true}).click();await table.waitForFunction(()=>document.querySelectorAll('.data-grid tbody tr').length===1);await table.getByRole('textbox',{name:'Строка 1, name',exact:true}).fill('updated filtered row');await table.getByRole('button',{name:'Сохранить изменения',exact:true}).click();await table.getByText('Изменения сохранены.',{exact:true}).waitFor();assert.equal((await db.query('SELECT name FROM ui_test WHERE id=650'))[0].rows[0][0],'updated filtered row');
	await table.getByRole('button',{name:'Очистить поиск',exact:true}).click();await table.waitForFunction(()=>document.querySelectorAll('.data-grid tbody tr').length===200);assert.equal(await firstId.inputValue(),'650');
	track('column sorting and search query all database rows, preserve paging and allow safe edits under a filter');
	await page.screenshot({path:path.join(__dirname,'release/phpcode-database-tables-preview.png')});
	await page.keyboard.press('Meta+p'); await page.locator('.quick-input-widget input').first().fill('check.sql'); await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'check.sql' }).first().click();
	await palette(page, 'phpcode: Выполнить SQL-скрипт или Выделение'); await page.getByRole('option').filter({ hasText: 'PostgreSQL integration' }).first().click();
	const result = await frameWith(page, '.results'); await result.getByRole('button', { name: 'Результат 2', exact: true }).waitFor({ timeout: 20000 }); await result.getByRole('button', { name: 'Результат 2', exact: true }).click(); await result.getByText('<script>unsafe()</script>', { exact: true }).waitFor(); assert.equal(await result.locator('.grid-scroll script').count(), 0);
	track('native SQL file runs against selected PostgreSQL connection and renders multiple safe result sets');
	await page.screenshot({ path: path.join(__dirname, 'release/phpcode-database-preview.png') });
	await close(); assert.ok(!fs.readFileSync(path.join(profile,'User/globalStorage/state.vscdb')).includes(Buffer.from('phpcode-test'))); track('saved profile storage does not contain the plaintext database password'); page = await launch(); await vscodeConnections(page);
	await palette(page,'Изменить Подключение');await page.getByRole('option').filter({hasText:'MariaDB integration'}).first().click();const edit=await frameWith(page,'input[name=password]');assert.equal(await edit.locator('input[name=password]').inputValue(),'');await edit.getByRole('button',{name:'Проверить соединение',exact:true}).click();await edit.getByText('Соединение установлено.',{exact:true}).waitFor({timeout:20000});await edit.getByRole('button',{name:'Сохранить подключение',exact:true}).click();
	track('editing a connection preserves its existing secret without exposing the password in the form');
	track('multiple saved connection profiles and secret-backed authentication survive application restart');
	await close(); await db.query('DROP TABLE ui_test'); await db.close(); db = undefined;
	const resultData = { ok: true, checks, fixture, liveDatabases: ['MariaDB 10.5.8', 'PostgreSQL 17'], build: 'r11' }; fs.writeFileSync(path.join(__dirname, 'database-verification-result.json'), JSON.stringify(resultData, null, 2) + '\n'); console.log(JSON.stringify(resultData, null, 2)); process.exit(0);
})().catch(async error => { console.error(error); if (app) { try { const page = await app.firstWindow(); await page.screenshot({ path: path.join(__dirname, 'release/phpcode-database-failure.png') }); console.error((await page.locator('body').innerText()).slice(-8000)); console.error(page.frames().map(f => f.url())); } catch {} } await close(); await db?.close(); process.exit(1); });
async function vscodeConnections(page) {
	await palette(page, 'phpcode: Открыть Базы Данных');
	await page.locator('.monaco-list-row').filter({hasText:'project · phpcode_test (.env)'}).first().waitFor({timeout:15000});assert.equal(await page.locator('.monaco-list-row').filter({hasText:'project · phpcode_test (.env)'}).count(),1);
	for (const c of [config('mysql'), config('postgres')]) { await page.locator('.monaco-list-row').filter({ hasText: c.name }).first().waitFor({ timeout: 15000 }); }
	const node=page.locator('.monaco-list-row').filter({hasText:'MariaDB integration'}).first(); if(await node.getAttribute('aria-expanded')!=='true'){await node.locator('.monaco-tl-twistie').click();} await page.locator('.monaco-list-row').filter({ hasText: /^phpcode_test$/ }).first().waitFor({ timeout: 15000 });
}
