/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { readCustomizations, mergeSettingsDocument } = require('./configuration.cjs');
const jsonc = require('./runtime/jsonc-parser');

const PREFIX = 'phpcode-container+';
const sh = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
let context;
let output;
let status;
let opening = false;
let notified = false;
const children = new Set();
const resolves = new Map();

function dockerPath() {
	const configured = vscode.workspace.getConfiguration('phpcode.devcontainers').get('dockerPath', '');
	return configured || ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'].find(file => fs.existsSync(file)) || 'docker';
}
function nodeEnvironment() { return { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; }
function terminate(child) {
	if (!child.pid) { return; }
	try { if (process.platform !== 'win32') { process.kill(-child.pid, 'SIGTERM'); } else { child.kill(); } } catch { /* Already exited. */ }
}
function run(executable, args, { signal, input, timeout = 120000, log = false } = {}) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error(vscode.l10n.t('Операция отменена.'))); return; }
		const child = spawn(executable, args, { env: nodeEnvironment(), detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
		children.add(child); let stdout = ''; let stderr = ''; let settled = false;
		const abort = () => { terminate(child); finish(new Error(vscode.l10n.t('Операция отменена.'))); };
		const timer = setTimeout(() => { terminate(child); finish(new Error(vscode.l10n.t('Превышено время ожидания Dev Container. Подробности — в журнале.'))); }, timeout);
		const finish = error => {
			if (settled) { return; } settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); children.delete(child);
			if (error) { reject(error); } else { resolve(stdout); }
		};
		child.stdout.on('data', data => { stdout += data; if (stdout.length > 16_000_000) { terminate(child); finish(new Error('Dev Container response is too large')); } });
		child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); if (log) { output.append(data.toString()); } });
		child.on('error', error => finish(error));
		child.on('close', code => finish(code === 0 ? undefined : new Error(vscode.l10n.t('Команда Dev Container завершилась с кодом {0}. {1}', code ?? '?', stderr.slice(-3000)))));
		child.stdin.on('error', () => { /* Close/error is reported by the process. */ });
		child.stdin.end(input);
		signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); }
	});
}
function cli(args, options) {
	return run(process.execPath, [path.join(context.extensionPath, 'runtime/cli.js'), args[0], '--docker-path', dockerPath(), ...args.slice(1)], options);
}
function cliArgs(record) {
	// Compose can reuse a running container that has no devcontainer.* labels.
	// Keep the identity returned by `up` instead of trying to discover it again.
	return ['--container-id', record.containerId, '--workspace-folder', record.workspaceFolder, '--config', record.configFile, '--log-level', 'info'];
}
function exec(record, command, options = {}) { return cli(['exec', ...cliArgs(record), '/bin/sh', '-c', command], options); }
function records() { return context.globalState.get('connections', {}); }
async function saveRecord(record) { await context.globalState.update('connections', { ...records(), [record.id]: record }); }
function currentRecord() {
	const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority || '';
	return authority.startsWith(PREFIX) ? records()[authority.slice(PREFIX.length)] : undefined;
}
function configurations(root) {
	const result = [path.join(root, '.devcontainer/devcontainer.json'), path.join(root, '.devcontainer.json')];
	try { for (const entry of fs.readdirSync(path.join(root, '.devcontainer'), { withFileTypes: true })) { if (entry.isDirectory()) { result.push(path.join(root, '.devcontainer', entry.name, 'devcontainer.json')); } } } catch { /* Optional directory. */ }
	return result.filter(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
}
async function provision(record, signal, progress) {
	progress?.report({ message: vscode.l10n.t('Сборка и запуск окружения…') });
	output.appendLine(vscode.l10n.t('Dev Container: {0}', record.configFile));
	const upText = await cli(['up', '--workspace-folder', record.workspaceFolder, '--config', record.configFile, '--include-merged-configuration', '--log-level', 'info', '--log-format', 'json'], { signal, timeout: 20 * 60 * 1000, log: true });
	let up;
	for (const line of upText.trim().split('\n').reverse()) { try { const value = JSON.parse(line); if (value.outcome === 'success') { up = value; break; } } catch { /* CLI progress is not the result object. */ } }
	if (!up || !/^[a-f0-9]{12,64}$/i.test(up.containerId) || typeof up.remoteWorkspaceFolder !== 'string' || !up.remoteWorkspaceFolder.startsWith('/') || typeof up.remoteUser !== 'string') { throw new Error(vscode.l10n.t('Dev Containers CLI не вернул корректное окружение проекта.')); }
	record.containerId = up.containerId; record.remoteUser = up.remoteUser; record.remoteWorkspaceFolder = up.remoteWorkspaceFolder;
	const info = JSON.parse((await exec(record, 'printf "{\\"arch\\":\\"%s\\",\\"platform\\":\\"%s\\",\\"home\\":\\"%s\\"}" "$(uname -m)" "$([ -f /etc/alpine-release ] && echo alpine || echo linux)" "$HOME"', { signal })).trim());
	const arch = info.arch === 'aarch64' || info.arch === 'arm64' ? 'arm64' : info.arch === 'x86_64' ? 'x64' : undefined;
	const platform = `${info.platform}-${arch}`;
	const manifest = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'assets/servers.json'), 'utf8'))[platform];
	if (!manifest) { throw new Error(vscode.l10n.t('В этой сборке пока нет сервера phpcode для {0}. Контейнер запущен, но проект остаётся локальным.', platform)); }
	const archive = path.join(context.extensionPath, 'assets', manifest.file);
	if (crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== manifest.sha256) { throw new Error(vscode.l10n.t('Контрольная сумма сервера phpcode не совпадает. Переустановите приложение.')); }
	if (typeof info.home !== 'string' || !info.home.startsWith('/') || /[\r\n\0]/.test(info.home)) { throw new Error('Invalid container home directory'); }
	const home = info.home.replace(/\/$/, '') + '/.phpcode-server';
	// A live socket from another server build must never satisfy this build's probe.
	const runtimeId = record.id + '-' + manifest.sha256.slice(0, 12);
	record.serverDir = `${home}/bin/${manifest.commit}-${manifest.sha256.slice(0, 12)}`;
	record.nodePath = `${record.serverDir}/node`; record.socketPath = `${home}/run/${runtimeId}.sock`; record.tokenFile = `${home}/run/${runtimeId}.token`;
	const installed = await exec(record, `[ -x ${sh(record.nodePath)} ] && [ -f ${sh(record.serverDir + '/out/server-main.js')} ] && printf installed || true`, { signal });
	if (installed.trim() !== 'installed') {
		progress?.report({ message: vscode.l10n.t('Установка сервера phpcode внутри контейнера…') });
		const temporary = `${home}/run/server-${record.id}.tar.gz`;
		await exec(record, `umask 077; mkdir -p ${sh(home + '/run')} ${sh(record.serverDir)}`, { signal });
		await run(dockerPath(), ['cp', archive, `${record.containerId}:${temporary}`], { signal });
		await exec(record, `umask 077; mkdir -p ${sh(record.serverDir)} && tar -xzf ${sh(temporary)} -C ${sh(record.serverDir)} && rm -f ${sh(temporary)}`, { signal, timeout: 180000 });
	}
	let token = await context.secrets.get('connection.' + record.id);
	if (!token) { token = crypto.randomBytes(32).toString('hex'); await context.secrets.store('connection.' + record.id, token); }
	await exec(record, `umask 077; mkdir -p ${sh(home + '/run')}; cat > ${sh(record.tokenFile)}`, { signal, input: token });
	const customization = readCustomizations(up.mergedConfiguration?.customizations?.vscode);
	const settings = customization.settings;
	const customizationHash = crypto.createHash('sha256').update(JSON.stringify(customization)).digest('hex');
	if (record.customizationHash !== customizationHash) {
		const failedExtensions = [];
		const settingsFile = home + '/data/Machine/settings.json';
		const previous = await exec(record, `if [ -f ${sh(settingsFile)} ]; then cat ${sh(settingsFile)}; else printf '{}'; fi`, { signal });
		let merged;
		try { merged = mergeSettingsDocument(previous, settings, jsonc); } catch { throw new Error(vscode.l10n.t('Настройки контейнера содержат ошибку JSONC. Исходный файл сохранён; исправьте его и повторите подключение.')); }
		const expected = crypto.createHash('sha256').update(previous).digest('hex');
		const apply = 'const fs=require("fs"),p=require("path"),c=require("crypto");let v="";process.stdin.on("data",d=>v+=d);process.stdin.on("end",()=>{const f=process.argv[1],old=fs.existsSync(f)?fs.readFileSync(f):Buffer.from("{}");if(c.createHash("sha256").update(old).digest("hex")!==process.argv[2]){throw Error("Remote settings changed; retry without overwriting new edits")}fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,v)});';
		await exec(record, `${sh(record.nodePath)} -e ${sh(apply)} ${sh(settingsFile)} ${sh(expected)}`, { signal, input: merged });
		for (const id of Array.isArray(customization.extensions) ? customization.extensions : []) {
			if (typeof id === 'string' && /^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d.-]*(?:@[\w.+-]+)?$/i.test(id)) {
				if (['github.copilot', 'github.copilot-chat'].includes(id.split('@')[0].toLowerCase())) { continue; }
				progress?.report({ message: vscode.l10n.t('Установка расширения {0}…', id) });
				try { await exec(record, `${sh(record.nodePath)} ${sh(record.serverDir + '/out/server-main.js')} --install-extension ${sh(id)} --server-data-dir ${sh(home)} --accept-server-license-terms`, { signal, timeout: 180000, log: true }); } catch (error) {
					if (signal?.aborted) { throw error; }
					failedExtensions.push(id); output.appendLine(vscode.l10n.t('Не удалось установить {0}: {1}', id, error.message));
				}
			}
		}
		record.failedExtensions = failedExtensions;
		record.customizationHash = failedExtensions.length ? undefined : customizationHash;
	}
	progress?.report({ message: vscode.l10n.t('Подключение редактора…') });
	const probe = 'const s=require("net").createConnection(process.argv[1]);s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),2000);';
	const boot = `umask 077; if ! ${sh(record.nodePath)} -e ${sh(probe)} ${sh(record.socketPath)}; then rm -f ${sh(record.socketPath)}; nohup ${sh(record.nodePath)} ${sh(record.serverDir + '/out/server-main.js')} --start-server --socket-path ${sh(record.socketPath)} --connection-token-file ${sh(record.tokenFile)} --server-data-dir ${sh(home)} --accept-server-license-terms --disable-telemetry --disable-experiments --force-disable-user-env > ${sh(home + '/run/' + runtimeId + '.log')} 2>&1 < /dev/null & fi; i=0; while [ ! -S ${sh(record.socketPath)} ]; do i=$((i+1)); if [ "$i" -ge 100 ]; then tail -n 30 ${sh(home + '/run/' + runtimeId + '.log')}; exit 1; fi; sleep 0.2; done`;
	await exec(record, boot, { signal, timeout: 45000 });
	record.serverHash = manifest.sha256; record.platform = platform;
	await saveRecord(record); return { ...record, token };
}
function connection(record) {
	return new Promise((resolve, reject) => {
		const data = new vscode.EventEmitter(); const closed = new vscode.EventEmitter(); const ended = new vscode.EventEmitter();
		const bridge = 'const s=require("net").createConnection(process.argv[1]);s.on("connect",()=>{process.stderr.write("PHPCODE_READY\\n");process.stdin.pipe(s);s.pipe(process.stdout)});s.on("error",()=>process.exit(1));s.on("close",()=>process.exit());process.stdin.on("end",()=>s.end());';
		const child = spawn(dockerPath(), ['exec', '-i', '--user', record.remoteUser, record.containerId, record.nodePath, '-e', bridge, record.socketPath], { env: nodeEnvironment(), detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		children.add(child); let ready = false; let errorText = '';
		const timer = setTimeout(() => { terminate(child); reject(new Error('Container transport timed out')); }, 30000);
		child.stdout.on('data', chunk => data.fire(chunk));
		child.stdin.on('error', () => { /* Process close reports the disconnected transport. */ });
		child.stderr.on('data', chunk => {
			errorText = (errorText + chunk).slice(-2000);
			if (!ready && errorText.includes('PHPCODE_READY')) {
				ready = true; clearTimeout(timer);
				resolve({ onDidReceiveMessage: data.event, onDidClose: closed.event, onDidEnd: ended.event, send: chunk => child.stdin.write(chunk), end: () => child.stdin.end(), drain: () => child.stdin.writableNeedDrain ? new Promise(done => child.stdin.once('drain', done)) : Promise.resolve() });
			}
		});
		child.on('error', error => { clearTimeout(timer); reject(error); closed.fire(error); });
		child.on('close', code => {
			clearTimeout(timer); children.delete(child);
			if (!ready) { reject(new Error(vscode.l10n.t('Не удалось подключить транспорт контейнера (код {0}).', code ?? '?'))); }
			else { ended.fire(); closed.fire(undefined); }
			queueMicrotask(() => { data.dispose(); closed.dispose(); ended.dispose(); });
		});
	});
}
async function open() {
	if (opening) { return; }
	if (currentRecord()) { vscode.window.showInformationMessage(vscode.l10n.t('Проект уже открыт в Dev Container.')); return; }
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || folder.uri.scheme !== 'file') { vscode.window.showInformationMessage(vscode.l10n.t('Откройте локальную папку проекта с devcontainer.json.')); return; }
	if (!vscode.workspace.isTrusted) { vscode.window.showInformationMessage(vscode.l10n.t('Для запуска конфигурации Dev Container сначала разрешите доверие к проекту.')); return; }
	const configs = configurations(folder.uri.fsPath);
	if (!configs.length) { vscode.window.showInformationMessage(vscode.l10n.t('Конфигурация .devcontainer/devcontainer.json или .devcontainer.json не найдена.')); return; }
	const configFile = configs.length === 1 ? configs[0] : (await vscode.window.showQuickPick(configs.map(file => ({ label: path.relative(folder.uri.fsPath, file), file })), { placeHolder: vscode.l10n.t('Выберите конфигурацию Dev Container') }))?.file;
	if (!configFile) { return; }
	opening = true;
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Открытие Dev Container'), cancellable: true }, async (progress, cancellation) => {
			const abort = new AbortController(); const subscription = cancellation.onCancellationRequested(() => abort.abort());
			try {
				const existing = Object.values(records()).find(record => record.workspaceFolder === folder.uri.fsPath && record.configFile === configFile);
				const record = existing || { id: crypto.randomUUID(), workspaceFolder: folder.uri.fsPath, configFile };
				const resolved = await provision(record, abort.signal, progress);
				if (abort.signal.aborted) { return; }
				const payload = await vscode.commands.executeCommand('phpcode.agent.exportWorkspaceState');
				if (typeof payload === 'string') { await context.globalState.update('handoff.' + record.id, { target: 'remote', payload }); }
				resolves.set(record.id, Promise.resolve(resolved));
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: PREFIX + record.id, path: resolved.remoteWorkspaceFolder }), { forceReuseWindow: true });
			} finally { subscription.dispose(); }
		});
	} catch (error) {
		opening = false;
		if (error.message === vscode.l10n.t('Операция отменена.')) { return; }
		output.appendLine(error.message);
		const showLog = vscode.l10n.t('Открыть журнал');
		if (await vscode.window.showErrorMessage(error.message, showLog) === showLog) { output.show(true); }
	} finally { opening = false; }
}
async function refresh(prompt = false) {
	const remote = currentRecord();
	if (remote?.failedExtensions?.length) {
		const message = vscode.l10n.t('Dev Container открыт, но не установлены расширения: {0}. Подробности — в журнале.', remote.failedExtensions.join(', '));
		output.appendLine(message); void vscode.window.showWarningMessage(message);
	}
	status.text = remote ? '$(remote) Dev Container: ' + path.basename(remote.workspaceFolder) : '$(remote) Dev Container';
	status.tooltip = remote ? vscode.l10n.t('Проект работает внутри контейнера. Нажмите для действий.') : vscode.l10n.t('Открыть проект в Dev Container');
	status.command = remote ? 'phpcode.devcontainers.actions' : 'phpcode.devcontainers.open'; status.show();
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!prompt || notified || remote || !folder || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted || !vscode.workspace.getConfiguration('phpcode.devcontainers').get('promptOnOpen', true) || !configurations(folder.uri.fsPath).length) { return; }
	notified = true;
	const yes = vscode.l10n.t('Открыть в Dev Container');
	if (await vscode.window.showInformationMessage(vscode.l10n.t('В проекте найдена конфигурация Dev Container. Открыть проект внутри контейнера?'), yes, vscode.l10n.t('Позже')) === yes) { await open(); }
}
exports.activate = async extensionContext => {
	context = extensionContext; output = vscode.window.createOutputChannel('phpcode Dev Container');
	status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45); status.name = 'Dev Container';
	context.subscriptions.push(output, status,
		vscode.commands.registerCommand('phpcode.devcontainers.open', open),
		vscode.commands.registerCommand('phpcode.devcontainers.log', () => output.show(true)),
		vscode.commands.registerCommand('phpcode.devcontainers.local', async () => {
			const record = currentRecord();
			if (record) {
				const payload = await vscode.commands.executeCommand('phpcode.agent.exportWorkspaceState');
				if (typeof payload === 'string') { await context.globalState.update('handoff.' + record.id, { target: 'local', payload }); }
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(record.workspaceFolder), { forceReuseWindow: true });
			}
		}),
		vscode.commands.registerCommand('phpcode.devcontainers.actions', async () => {
			const picked = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Открыть проект локально'), command: 'phpcode.devcontainers.local' }, { label: vscode.l10n.t('Журнал Dev Container'), command: 'phpcode.devcontainers.log' }]);
			if (picked) { await vscode.commands.executeCommand(picked.command); }
		}),
		vscode.workspace.registerRemoteAuthorityResolver('phpcode-container', {
			resolve: async (authority, resolveContext) => {
				const id = authority.slice(PREFIX.length); const record = records()[id];
				if (!authority.startsWith(PREFIX) || !record) { throw vscode.RemoteAuthorityResolverError.NotAvailable(vscode.l10n.t('Соединение Dev Container не найдено. Откройте локальный проект и нажмите Dev Container.')); }
				if (resolveContext.resolveAttempt > 1) { resolves.delete(id); }
				if (!resolves.has(id)) {
					resolves.set(id, (async () => {
						const manifest = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'assets/servers.json'), 'utf8'))[record.platform];
						const token = await context.secrets.get('connection.' + record.id);
						if (token && manifest && manifest.sha256 === record.serverHash && record.nodePath && record.socketPath?.endsWith('/' + record.id + '-' + manifest.sha256.slice(0, 12) + '.sock')) {
							try {
								const probe = 'const s=require("net").createConnection(process.argv[1]);s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),2000);';
								await run(dockerPath(), ['exec', '--user', record.remoteUser, record.containerId, record.nodePath, '-e', probe, record.socketPath], { timeout: 10000 });
								return { ...record, token };
							} catch { /* Re-create the environment if its server/container stopped. */ }
						}
						return provision(record);
					})().catch(error => { resolves.delete(id); throw error; }));
				}
				const ready = await resolves.get(id);
				return Object.assign(new vscode.ManagedResolvedAuthority(() => connection(ready), ready.token), { isTrusted: true });
			},
			getCanonicalURI: async uri => uri,
		}),
		vscode.workspace.onDidGrantWorkspaceTrust(() => refresh(true)),
	);
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder?.uri.scheme === 'file') {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '{.devcontainer.json,.devcontainer/**/devcontainer.json}'));
		context.subscriptions.push(watcher, watcher.onDidCreate(() => refresh(true)), watcher.onDidDelete(() => refresh(false)));
	}
	const remote = currentRecord();
	const local = vscode.workspace.workspaceFolders?.[0]?.uri;
	const transferred = remote || Object.values(records()).find(record => local?.scheme === 'file' && record.workspaceFolder === local.fsPath && context.globalState.get('handoff.' + record.id)?.target === 'local');
	if (transferred) {
		const handoff = context.globalState.get('handoff.' + transferred.id);
		if (handoff?.target === (remote ? 'remote' : 'local') && typeof handoff.payload === 'string') {
			try { await vscode.commands.executeCommand('phpcode.agent.importWorkspaceState', handoff.payload); await context.globalState.update('handoff.' + transferred.id, undefined); } catch (error) { output.appendLine(vscode.l10n.t('Не удалось перенести историю чатов: {0}', error.message)); }
		}
	}
	void refresh(true);
};
exports.deactivate = () => { for (const child of children) { terminate(child); } children.clear(); };
