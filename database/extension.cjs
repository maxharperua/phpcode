/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { t } = require('./localization.cjs');
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Session } = require('./session.cjs');
const { configuration } = require('./database.cjs');
const { connectionFromEnv } = require('./env.cjs');
let context, tree, resultsView, status;
let latest = { kind: 'results', title: t("Результаты SQL"), results: [], message: t("Откройте SQL-файл, выберите подключение и нажмите ⌘Enter / Ctrl+Enter.") };
const sessions = new Set(); const sqlSessions = new Map(); const bindings = new Map(); const panels = new Map();
const changed = new vscode.EventEmitter();
let importingEnv = false;
const connections = () => context.globalState.get('connections', []);
const get = id => { const c = connections().find(c => c.id === id); if (!c) { throw Error(t("Подключение удалено.")); } return c; };
const secretKey = id => 'database.password.' + id;
const cleanError = (error, password) => { let text = String(error.message || error).slice(0, 2000); if (password) { text = text.replaceAll(password, '••••'); } return text; };
async function session(id) { const config = get(id); const value = new Session(config, await context.secrets.get(secretKey(id)) || ''); sessions.add(value); return value; }
function release(value) { value?.dispose(); sessions.delete(value); }
function closeConnection(id) {
	for (const [key, item] of sqlSessions) { if (item.id === id) { release(item.session); sqlSessions.delete(key); } }
	for (const item of [...panels.values()]) { if (item.id === id) { item.panel.dispose(); } }
}
async function saveConnection(config, password, id, envSource) {
	const previous = await context.secrets.get(secretKey(id)); await context.secrets.store(secretKey(id), password);
	try { await context.globalState.update('connections', [...connections().filter(c => c.id !== id), { ...config, id, ...(envSource ? { envSource } : {}) }]); }
	catch (error) { if (previous === undefined) { await context.secrets.delete(secretKey(id)); } else { await context.secrets.store(secretKey(id), previous); } throw error; }
	closeConnection(id); changed.fire(); updateStatus();
}
async function importEnv(explicit = false) {
	if (importingEnv || !vscode.workspace.isTrusted) { return; } importingEnv = true;
	let imported = 0;
	try {
		for (const folder of vscode.workspace.workspaceFolders || []) {
			const uri = vscode.Uri.joinPath(folder.uri, '.env'); const source = uri.toString();
			if (!explicit && (connections().some(c => c.envSource === source) || context.globalState.get('ignoredEnvSources', []).includes(source))) { continue; }
			let bytes;
			try { const info = await vscode.workspace.fs.stat(uri); if (info.size > 1024 * 1024) { throw Error('env_too_large'); } bytes = await vscode.workspace.fs.readFile(uri); }
			catch (error) { if (error.code === 'FileNotFound') { continue; } throw error; }
			const parsed = connectionFromEnv(Buffer.from(bytes).toString('utf8'), folder.name); if (!parsed) { continue; }
			const config = configuration(parsed.config); const existing = connections().find(c => c.envSource === source);
			await saveConnection(config, parsed.password, existing?.id || crypto.randomUUID(), source);
			await context.globalState.update('ignoredEnvSources', context.globalState.get('ignoredEnvSources', []).filter(value => value !== source)); imported++;
		}
		if (imported) {
			if (explicit) { await vscode.commands.executeCommand('phpcode.database.connections.focus'); }
			else { const open = t("Открыть базы данных"); void vscode.window.showInformationMessage(t("Подключение к БД создано из .env проекта. Пароль сохранён в защищённом хранилище."), open).then(picked => { if (picked === open) { return vscode.commands.executeCommand('phpcode.database.connections.focus'); } }); }
		} else if (explicit) { void vscode.window.showInformationMessage(t("В корне проекта не найден .env с полными параметрами MySQL/MariaDB или PostgreSQL.")); }
	} catch { void vscode.window.showWarningMessage(t("Не удалось импортировать подключение из .env. Проверьте формат DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME и DB_PASSWORD; исходный файл не изменён.")); }
	finally { importingEnv = false; }
}
function html(webview) {
	const nonce = crypto.randomBytes(24).toString('base64');
	const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name)).toString();
	return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('codicon.css')}"><link rel="stylesheet" href="${asset('database.css')}"></head><body><main id="app"></main><script nonce="${nonce}" src="${asset('database.js')}"></script></body></html>`;
}
function configure(webview) { webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }; webview.html = html(webview); }
function post(webview, value) { return webview.postMessage({ ...value, localization: vscode.l10n.bundle || {} }); }
async function choose(node) {
	if (node?.id) { return get(node.id); }
	const picked = await vscode.window.showQuickPick(connections().map(c => ({ label: c.name, description: `${c.engine} · ${c.host}:${c.port}/${c.database}`, id: c.id })), { placeHolder: t("Подключение для SQL-скрипта") });
	return picked ? get(picked.id) : undefined;
}
function manager(existing) {
	const key = 'connection:' + (existing?.id || 'new'); if (panels.has(key)) { panels.get(key).panel.reveal(); return; }
	const panel = vscode.window.createWebviewPanel('phpcode.database.connection', existing ? t("БД: ") + existing.name : t("Новое подключение"), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
	panels.set(key, { panel, id: existing?.id }); configure(panel.webview); let busy = false; let disposed = false;
	const send = value => disposed ? Promise.resolve(false) : post(panel.webview, value);
	const listener = panel.webview.onDidReceiveMessage(async message => {
		if (message.type === 'ready') { await send({ kind: 'connection', config: existing || { engine: 'mysql', name: '', host: '127.0.0.1', port: 3306, user: '', database: '', tls: false }, hasPassword: !!(existing && await context.secrets.get(secretKey(existing.id))), remote: vscode.env.remoteName || '' }); return; }
		if (busy || !['save', 'test'].includes(message.type)) { return; } busy = true;
		let value;
		try {
			const config = configuration(message.config); const id = existing?.id || crypto.randomUUID();
			const password = message.password === undefined && existing ? await context.secrets.get(secretKey(id)) || '' : message.password;
			if (typeof password !== 'string' || password.length > 4096) { throw Error(t("Некорректный пароль.")); }
			if (message.type === 'test') { value = new Session(config, password); sessions.add(value); await value.call('test'); await send({ event: 'success', message: t("Соединение установлено.") }); }
			else {
				if (existing) { get(existing.id); }
				await saveConnection(config, password, id, existing?.envSource); panel.dispose(); await vscode.commands.executeCommand('phpcode.database.connections.focus');
			}
		} catch (error) { await send({ event: 'error', message: cleanError(error, message.password) }); }
		finally { if (value) { release(value); } busy = false; await send({ event: 'idle' }); }
	});
	panel.onDidDispose(() => { disposed = true; listener.dispose(); panels.delete(key); });
}
async function tableEditor(node) {
	if (!node?.table) { await vscode.commands.executeCommand('phpcode.database.connections.focus'); return; }
	const config = get(node.id); const table = node.table;
	const key = JSON.stringify([node.id, table.schema, table.name]); if (panels.has(key)) { panels.get(key).panel.reveal(); return; }
	const panel = vscode.window.createWebviewPanel('phpcode.database.table', `${table.name} — ${config.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
	panels.set(key, { panel, id: node.id }); configure(panel.webview); let current; let busy = false; let offset = 0; let view = {}; let disposed = false;
	const send = value => disposed ? undefined : post(panel.webview, value);
	const load = async (nextOffset = offset, nextView = view) => { if (disposed) { return; } if (!current || current.closed) { release(current); current = await session(node.id); if (disposed) { release(current); return; } } const data = await current.call('page', { table, offset: nextOffset, view: nextView }); offset = data.offset; view = data.view; await send({ kind: 'table', title: table.schema + '.' + table.name, connection: config.name, ...data }); };
	const listener = panel.webview.onDidReceiveMessage(async message => {
		if (message.type === 'cancel') { release(current); return; }
		if (message.type === 'query') { await newQuery({ id: node.id }, `SELECT * FROM ${config.engine === 'mysql' ? '`' + table.schema.replaceAll('`','``') + '`.`' + table.name.replaceAll('`','``') + '`' : '"' + table.schema.replaceAll('"','""') + '"."' + table.name.replaceAll('"','""') + '"'} LIMIT 200;`); return; }
		if (busy || !['ready', 'page', 'apply'].includes(message.type)) { return; } busy = true;
		try {
			if (message.type === 'apply') {
				if (!current || !Array.isArray(message.changes)) { throw Error(t("Обновите таблицу.")); }
				await current.call('change', { changes: message.changes }); await load(); await send({ event: 'success', message: t("Изменения сохранены.") });
			} else { await load(message.type === 'page' ? message.offset : offset, message.view ?? view); }
		} catch (error) { await send({ event: 'error', message: cleanError(error, await context.secrets.get(secretKey(node.id))) }); }
		finally { busy = false; await send({ event: 'idle' }); }
	});
	panel.onDidDispose(() => { disposed = true; listener.dispose(); release(current); panels.delete(key); });
}
async function showResults(value) { latest = value; await vscode.commands.executeCommand('phpcode.database.results.focus'); if (resultsView) { await post(resultsView.webview, value); } }
function updateStatus() {
	const editor = vscode.window.activeTextEditor;
	if (editor?.document.languageId !== 'sql') { status.hide(); return; }
	const config = connections().find(c => c.id === bindings.get(editor.document.uri.toString()));
	status.text = '$(database) ' + (config?.name || t("Выбрать подключение")); status.tooltip = t("Подключение для активного SQL-файла"); status.show();
}
async function selectConnection() {
	const editor = vscode.window.activeTextEditor; if (!editor || editor.document.languageId !== 'sql') { return; }
	const config = await choose(); if (!config) { return; }
	const key = editor.document.uri.toString(); release(sqlSessions.get(key)?.session); sqlSessions.delete(key); bindings.set(key, config.id); updateStatus();
}
async function newQuery(node, text = '') {
	const config = await choose(node); if (!config) { if (!connections().length) { manager(); } return; }
	const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: text || '-- ' + config.name.replace(/[\r\n]/g,' ') + '\nSELECT 1;\n' });
	bindings.set(doc.uri.toString(), config.id); await vscode.window.showTextDocument(doc); updateStatus();
}
async function runSQL() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'sql') { vscode.window.showInformationMessage(t("Откройте SQL-файл для выполнения.")); return; }
	const key = editor.document.uri.toString(); let id = bindings.get(key);
	if (!connections().some(c => c.id === id)) { const config = await choose(); if (!config) { if (!connections().length) { manager(); } return; } id = config.id; bindings.set(key, id); updateStatus(); }
	const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
	let item = sqlSessions.get(key); if (item?.busy) { vscode.window.showInformationMessage(t("Запрос уже выполняется. Можно остановить его в панели результатов.")); return; }
	if (!item || item.session.closed) { release(item?.session); item = { id, session: await session(id), busy: false }; sqlSessions.set(key, item); }
	item.busy = true;
	await showResults({ kind: 'results', title: get(id).name, results: [], busy: true, message: t("Выполняется SQL… Команды применяются согласно SQL; автоматического отката скрипта нет.") });
	try { const result = await item.session.call('query', { sql }); await showResults({ kind: 'results', title: get(id).name, ...result, message: t("Готово · {0} мс", result.elapsed) }); changed.fire(); }
	catch (error) { await showResults({ kind: 'results', title: t("Ошибка SQL"), results: [], error: cleanError(error, await context.secrets.get(secretKey(id))) }); }
	finally { item.busy = false; }
}
exports.activate = extensionContext => {
	context = extensionContext;
	status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 70); status.command = 'phpcode.database.connection'; status.name = 'SQL Connection';
	tree = vscode.window.createTreeView('phpcode.database.connections', { treeDataProvider: {
		onDidChangeTreeData: changed.event,
		getTreeItem: node => {
			const item = new vscode.TreeItem(node.label, node.kind === 'column' ? vscode.TreeItemCollapsibleState.None : node.kind === 'table' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
			item.contextValue = node.kind === 'connection' ? 'databaseConnection' : node.kind;
			item.iconPath = new vscode.ThemeIcon(node.kind === 'connection' ? 'database' : node.kind === 'table' ? (node.table.view ? 'preview' : 'table') : 'folder');
			item.description = node.description;
			if (node.kind === 'table') { item.command = { command: 'phpcode.database.table', title: t("Открыть таблицу"), arguments: [node] }; }
			return item;
		},
		getChildren: async node => {
			if (!node) { return connections().map(c => ({ kind: 'connection', id: c.id, label: c.name, description: `${c.engine} · ${c.host}:${c.port}/${c.database}` })); }
			if (node.kind === 'schema') { return node.tables.map(table => ({ kind: 'table', id: node.id, label: table.name, table })); }
			if (node.kind !== 'connection') { return []; }
			let value;
			try { value = await session(node.id); const tables = await value.call('tables'); return [...new Set(tables.map(t => t.schema))].map(schema => ({ kind: 'schema', id: node.id, label: schema, tables: tables.filter(t => t.schema === schema) })); }
			catch (error) { vscode.window.showErrorMessage(cleanError(error, await context.secrets.get(secretKey(node.id)))); return []; }
			finally { release(value); }
		}
	} });
	context.subscriptions.push(changed, status, tree,
		vscode.window.registerWebviewViewProvider('phpcode.database.results', { resolveWebviewView(view) { resultsView = view; configure(view.webview); const listener = view.webview.onDidReceiveMessage(message => { if (message.type === 'ready') { void post(view.webview, latest); } else if (message.type === 'cancel') { for (const item of sqlSessions.values()) { if (item.busy) { release(item.session); } } } }); view.onDidDispose(() => { listener.dispose(); if (resultsView === view) { resultsView = undefined; } }); } }, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('phpcode.database.add', () => manager()),
		vscode.commands.registerCommand('phpcode.database.open', () => vscode.commands.executeCommand('phpcode.database.connections.focus')),
		vscode.commands.registerCommand('phpcode.database.importEnv', () => importEnv(true)),
		vscode.commands.registerCommand('phpcode.database.edit', async node => { const config = await choose(node); if (config) { manager(config); } }),
		vscode.commands.registerCommand('phpcode.database.remove', async node => { const c = await choose(node); if (!c || await vscode.window.showWarningMessage(t("Удалить подключение «{0}»? Данные в БД останутся.", c.name), { modal: true }, t("Удалить")) !== t("Удалить")) { return; } closeConnection(c.id); if (c.envSource) { await context.globalState.update('ignoredEnvSources', [...new Set([...context.globalState.get('ignoredEnvSources', []), c.envSource])]); } await context.globalState.update('connections', connections().filter(item => item.id !== c.id)); await context.secrets.delete(secretKey(c.id)); changed.fire(); updateStatus(); }),
		vscode.commands.registerCommand('phpcode.database.refresh', () => changed.fire()),
		vscode.commands.registerCommand('phpcode.database.query', newQuery),
		vscode.commands.registerCommand('phpcode.database.table', tableEditor),
		vscode.commands.registerCommand('phpcode.database.run', runSQL),
		vscode.commands.registerCommand('phpcode.database.connection', selectConnection),
		vscode.commands.registerCommand('phpcode.database.cancel', () => { for (const item of sqlSessions.values()) { if (item.busy) { release(item.session); } } }),
		vscode.window.onDidChangeActiveTextEditor(updateStatus),
		vscode.workspace.onDidCloseTextDocument(doc => { const key = doc.uri.toString(); release(sqlSessions.get(key)?.session); sqlSessions.delete(key); bindings.delete(key); }),
		vscode.workspace.onDidSaveTextDocument(doc => { if (doc.languageId === 'sql') { updateStatus(); } }),
		{ dispose() { for (const panel of [...panels.values()]) { panel.panel.dispose(); } for (const value of sessions) { value.dispose(); } sessions.clear(); } }
	);
	updateStatus();
	for (const folder of vscode.workspace.workspaceFolders || []) {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.env'));
		context.subscriptions.push(watcher, watcher.onDidCreate(() => void importEnv()), watcher.onDidChange(() => void importEnv()));
	}
	void importEnv();
};
exports.deactivate = () => { for (const value of sessions) { value.dispose(); } sessions.clear(); };
