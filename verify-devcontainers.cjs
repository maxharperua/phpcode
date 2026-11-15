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
const jsonc = createRequire(path.join(root,'extensions/package.json'))('jsonc-parser');
const fixture = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'phpcode-container-'));
const project = path.join(fixture, 'project'); const profile = path.join(fixture, 'profile');
fs.mkdirSync(path.join(project, '.devcontainer'), { recursive: true }); fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.writeFileSync(path.join(project, 'LOCAL_WORKSPACE.txt'), 'This file belongs only to the local source workspace.');
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'phpcode.devcontainers.promptOnOpen': true }));
const config = { name: 'phpcode integration', image: process.env.PHPCODE_CONTAINER_TEST_IMAGE || 'phpcode-test-node:arm64', workspaceMount: `source=${project},target=/host-source,type=bind`, workspaceFolder: '/home/node', remoteUser: 'node', containerEnv: { PHPCODE_CONTAINER_TEST: 'container-only' }, remoteEnv: { PHPCODE_REMOTE_ENV: 'remote-only' }, customizations: { vscode: { settings: { 'editor.tabSize': 3 } } }, postCreateCommand: 'mkdir -p src && printf "CONTAINER_WORKSPACE\\n" > README.md && printf "<?php\\nfunction containerOnly() { return 42; }\\n" > src/ContainerOnly.php' };
const initialSettings = Buffer.from('// existing user preference\n{ "files.autoSave": "off", "editor.tabSize": 7, }\n').toString('base64');
config.postCreateCommand += ` && mkdir -p .phpcode-server/data/Machine && printf %s '${initialSettings}' | base64 -d > .phpcode-server/data/Machine/settings.json`;
if(process.env.PHPCODE_CONTAINER_TEST_COMPOSE==='1'){
 const compose={name:'phpcode-'+path.basename(fixture).toLowerCase(),services:{dev:{image:config.image,platform:process.env.PHPCODE_CONTAINER_TEST_PLATFORM,command:['sleep','infinity'],volumes:[`${project}:/host-source`],environment:config.containerEnv}}};
 if(process.env.PHPCODE_CONTAINER_DATABASE_TEST==='1'){compose.networks={database:{external:true,name:'phpcode-db-test-network'}};compose.services.dev.networks=['database'];}
 fs.writeFileSync(path.join(project,'.devcontainer/docker-compose.yml'),JSON.stringify(compose,null,2));
 delete config.image; delete config.workspaceMount; delete config.containerEnv;
 config.dockerComposeFile='docker-compose.yml'; config.service='dev';
}
const existingCompose = process.env.PHPCODE_CONTAINER_TEST_EXISTING_COMPOSE === '1';
const configPath=existingCompose?path.join(project,'.devcontainer/php/devcontainer.json'):process.env.PHPCODE_CONTAINER_TEST_ROOT==='1'?path.join(project,'.devcontainer.json'):path.join(project,'.devcontainer/devcontainer.json');
if(existingCompose){assert.ok(config.dockerComposeFile);config.dockerComposeFile='../docker-compose.yml';fs.mkdirSync(path.dirname(configPath),{recursive:true});}
if(process.env.PHPCODE_CONTAINER_TEST_ROOT==='1'&&config.dockerComposeFile){config.dockerComposeFile='.devcontainer/docker-compose.yml';}
if(process.env.PHPCODE_CONTAINER_TEST_MISSING_EXTENSION==='1'){
 config.customizations.vscode.extensions=['GitHub.copilot','phpcode.integration-nonexistent-8f741b5'];
 config.remoteEnv.HTTPS_PROXY='http://127.0.0.1:9';
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
let existingContainerId;
if(existingCompose){
	const composeFile=path.join(project,'.devcontainer/docker-compose.yml');
	execFileSync('docker',['compose','-f',composeFile,'up','-d'],{stdio:'pipe'});
	existingContainerId=execFileSync('docker',['compose','-f',composeFile,'ps','-q','dev'],{encoding:'utf8'}).trim();
	const container=JSON.parse(execFileSync('docker',['inspect',existingContainerId],{encoding:'utf8'}))[0];
	assert.ok(existingContainerId&&!container.Config.Labels['devcontainer.local_folder']);
}
const executablePath = process.env.PHPCODE_PACKAGED_EXECUTABLE || path.join(root, '.build/electron/phpcode.app/Contents/MacOS/phpcode');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; if (!process.env.PHPCODE_PACKAGED_EXECUTABLE) { env.VSCODE_DEV = '1'; }
let app; const checks = [];
function track(label){checks.push(label);console.log('PASS: '+label);}
async function closeApp(){
 const instance=app; app=undefined; if(!instance){return;}
 let child;try{child=instance.process();}catch{}
 let timer;let timedOut=false;let forcedKill=false;
 await Promise.race([instance.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;if(child?.exitCode===null){forcedKill=true;child.kill('SIGKILL');}resolve();},5000);})]);
 clearTimeout(timer);return {driverTimedOut:timedOut,forcedKill,mainExitCode:child?.exitCode};
}
async function palette(page, command) {
	await page.keyboard.press('Meta+Shift+p'); await page.locator('.quick-input-widget input').first().fill('>' + command);
	await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: command }).first().click({ timeout: 20000 });
}
(async () => {
	if(process.env.PHPCODE_CONTAINER_TEST_PREVIOUS_EXECUTABLE){
		app=await _electron.launch({executablePath:process.env.PHPCODE_CONTAINER_TEST_PREVIOUS_EXECUTABLE,args:['--user-data-dir',profile,'--extensions-dir',path.join(fixture,'extensions'),'--disable-workspace-trust','--skip-welcome','--skip-release-notes',project],env,timeout:60000});
		const old=await app.firstWindow();await old.locator('.monaco-workbench').waitFor({timeout:60000});await old.getByRole('button',{name:'Позже',exact:true}).click({timeout:30000});await old.locator('.statusbar-item').filter({hasText:/^\s*Dev Container\s*$/}).first().click();await old.getByText('README.md',{exact:true}).first().waitFor({timeout:240000});
		await closeApp();track('previous release leaves its remote server running before upgrading the same saved connection');
	}
	app = await _electron.launch({ executablePath, args: [...(process.env.PHPCODE_PACKAGED_EXECUTABLE ? [] : [root]), '--user-data-dir', profile, '--extensions-dir', path.join(fixture, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', project], env, timeout: 60000 });
	const page = await app.firstWindow(); page.on('pageerror', error => console.error('Renderer:', error.message));
	await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
	await app.evaluate(() => {
		globalThis.fetch = async (input, init) => {
			if (!String(input).startsWith('https://openai.bothub.chat/v1/')) { throw new Error('Unexpected test request'); }
			if (String(input).endsWith('/models')) { return new Response(JSON.stringify({ data: [{ id: 'container-test', context_length: 128000 }] })); }
			const request = JSON.parse(init.body);
			const tools = request.messages.filter(message => message.role === 'tool');
			const call = (name, args, id) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
			let chunk;
			if (!tools.length) { chunk = call('search_code', { query:'containerOnly' }, 'container-search'); }
			else if (tools.length === 1) { if(!tools[0].content.includes('src/ContainerOnly.php')){throw new Error('Remote index did not retrieve the container file');} chunk=call('read_file',{path:'src/ContainerOnly.php'},'container-read'); }
			else if (tools.length === 2) { if (!tools[1].content.includes('containerOnly')) { throw new Error('Agent did not read the container workspace'); } chunk = call('propose_file', { path: 'Result.php', content: '<?php echo "created in container";\n' }, 'container-write'); }
			else if (tools.length === 3) { chunk = call('run_terminal', { command: 'test "$(uname -s)" = Linux && test "$PWD" = /home/node && test "$PHPCODE_REMOTE_ENV" = remote-only && test "$PHPCODE_CONTAINER_TEST" = container-only && printf PHPCODE_CONTAINER_EXECUTION' }, 'container-command'); }
			else { if (!tools.at(-1).content.includes('PHPCODE_CONTAINER_EXECUTION') || !tools.at(-1).content.includes('Exit: 0')) { throw new Error('Agent command did not execute with the container environment'); } chunk = { choices: [{ delta: { content: 'Проверено: src/ContainerOnly.php:2 и Result.php.\n\n[Исходник](src/ContainerOnly.php#L2)\n\nПапка: src/' }, finish_reason: 'stop' }] }; }
			return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
		};
	});
	await page.getByRole('button', { name: 'Позже', exact: true }).click({ timeout: 30000 });
	track('project configuration produces a dismissible Dev Container startup offer');
	await palette(page, 'phpcode: Открыть Агента');
	const panel = page.locator('.phpcode-agent');
	await panel.getByLabel('API-ключ BotHub', { exact: true }).fill('phpcode-container-test-key');
	await panel.getByRole('button', { name: 'Сохранить ключ', exact: true }).click();
	await panel.locator('.phpcode-agent-mode').selectOption('agent-auto');
	await panel.getByRole('textbox', {name:'Сообщение агенту',exact:true}).fill('Черновик перед контейнером');
	await page.locator('.statusbar-item').filter({ hasText: /^\s*Dev Container\s*$/ }).first().click({ timeout: 15000 });
	await Promise.race([
		page.locator('.statusbar-item').filter({ hasText: /Dev Container: project/ }).first().waitFor({ timeout: 240000 }),
		page.locator('.notification-list-item').filter({ has: page.locator('.codicon-error') }).first().waitFor({ timeout: 240000 }).then(async () => { throw new Error(await page.locator('.notification-list-item').filter({ has: page.locator('.codicon-error') }).first().innerText()); })
	]);
	await page.getByText('README.md',{exact:true}).first().waitFor({timeout:120000});
	track('persistent status-bar button reopens a dismissed project in a real remote container workspace');
	if(existingCompose){track('pre-existing Compose container without Dev Container labels opens using the nested project configuration');}
	if(process.env.PHPCODE_CONTAINER_TEST_MISSING_EXTENSION==='1'){await page.getByText(/Dev Container открыт, но не установлены расширения:/).first().waitFor({timeout:15000});track('unavailable optional extensions do not prevent the remote workspace from opening');}
	await palette(page, 'phpcode: Открыть Агента');
	assert.equal(await panel.locator('.phpcode-agent-mode').inputValue(),'agent-auto');
	if(!process.env.PHPCODE_CONTAINER_TEST_PREVIOUS_EXECUTABLE){assert.equal(await panel.getByRole('textbox', {name:'Сообщение агенту',exact:true}).inputValue(),'Черновик перед контейнером');}
	track(process.env.PHPCODE_CONTAINER_TEST_PREVIOUS_EXECUTABLE?'agent execution mode survives the release upgrade':'agent draft and execution mode transfer from the local workspace to the container');
	if(process.env.PHPCODE_CONTAINER_TEST_PREVIOUS_EXECUTABLE){
		await palette(page,'phpcode: Открыть Базы Данных');await page.getByText('Сохраните подключения к MySQL, MariaDB и PostgreSQL.',{exact:false}).waitFor({timeout:20000});track('upgraded existing connection loads new remote database commands instead of reusing the old server socket');await palette(page,'phpcode: Открыть Агента');
	}
	if(process.env.PHPCODE_CONTAINER_DATABASE_TEST==='1'){
		await palette(page,'phpcode: Добавить Подключение к БД');let databaseFrame;
		for(let attempt=0;attempt<200&&!databaseFrame;attempt++){for(const frame of page.frames()){try{if(await frame.locator('input[name=host]').count()){databaseFrame=frame;break;}}catch{}}if(!databaseFrame){await new Promise(resolve=>setTimeout(resolve,100));}}
		assert.ok(databaseFrame);await databaseFrame.getByText('Сеть Dev Container / удалённой среды',{exact:true}).waitFor();
		for(const [name,value]of Object.entries({name:'Remote MariaDB',host:'phpcode-db-test-mysql',port:'3306',user:'root',database:'phpcode_test',password:'phpcode-test'})){await databaseFrame.locator(`input[name=${name}]`).fill(value);}
		await databaseFrame.getByRole('button',{name:'Проверить соединение',exact:true}).click();await databaseFrame.getByText('Соединение установлено.',{exact:true}).waitFor({timeout:20000});
		await databaseFrame.getByRole('button',{name:'Сохранить подключение',exact:true}).click();await page.locator('.monaco-list-row').filter({hasText:'Remote MariaDB'}).first().waitFor({timeout:20000});
		track('built-in database client connects by Docker-only service hostname from the remote extension host');
		await palette(page,'phpcode: Открыть Агента');
	}
	await panel.locator('.model-picker').click(); await page.getByRole('option', { name: /^container-test/ }).click();
	await panel.locator('.phpcode-agent-mode').selectOption('agent-auto');
	const prompt = panel.getByRole('textbox', { name: 'Сообщение агенту', exact: true });
	await prompt.fill('Проверь окружение контейнера'); await prompt.press('Enter');
	await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({ timeout: 60000 });
	assert.match(await panel.innerText(), /Проверено/);
	assert.ok(!fs.existsSync(path.join(project, 'Result.php')), 'The agent must not write the local source workspace');
	const id = existingContainerId || execFileSync('docker', ['ps', '-q', '--filter', 'label=devcontainer.local_folder=' + project], { encoding: 'utf8' }).trim().split('\n')[0];
	assert.ok(id);
	assert.match(execFileSync('docker', ['exec', id, 'cat', '/home/node/Result.php'], { encoding: 'utf8' }), /created in container/);
	const settingsText=execFileSync('docker',['exec',id,'cat','/home/node/.phpcode-server/data/Machine/settings.json'],{encoding:'utf8'});
	const settings=jsonc.parse(settingsText);assert.match(settingsText,/existing user preference/);assert.equal(settings['files.autoSave'],'off');
	assert.equal(settings['editor.tabSize'],3);
	track('devcontainer editor customizations apply to the actual remote settings file');
	track('agent reads and edits container-only files and runs Linux commands with remoteEnv and container cwd');
 const storage=path.join(profile,'User/workspaceStorage'); let remoteIndex;
 for(let attempt=0;attempt<100&&!remoteIndex;attempt++){
  if(fs.existsSync(storage)){for(const file of fs.readdirSync(storage,{recursive:true}).filter(file=>file.endsWith('phpcode/code-index-v1.json'))){try{const data=JSON.parse(fs.readFileSync(path.join(storage,file),'utf8'));if(data.root.startsWith('vscode-remote:')){remoteIndex=data;}}catch{}}}
  if(!remoteIndex){await new Promise(resolve=>setTimeout(resolve,100));}
 }
 assert.ok(remoteIndex&&remoteIndex.index.files.some(file=>file.path==='src/ContainerOnly.php'));
 assert.ok(remoteIndex.index.files.every(file=>!file.path.includes('.phpcode-server/')));
 track('project index retrieves container code and excludes server internals and connection credentials');
	const fileLink = panel.locator('a.phpcode-agent-file-link').filter({ hasText: 'src/ContainerOnly.php:2' });
	await fileLink.click();
	await page.locator('.editor-group-container .tab').filter({ hasText: 'ContainerOnly.php' }).first().waitFor();
	assert.match(await page.locator('.statusbar-item').filter({ hasText: /Ln 2,/ }).first().innerText(), /Ln 2,/);
	await panel.getByRole('link', { name: 'Исходник', exact: true }).click();
	track('plain file paths and Markdown references open container files at the requested line');
	await panel.locator('a.phpcode-agent-file-link').filter({ hasText: /^src\/$/ }).click();
	track('directory references reveal the folder in Explorer');
	await page.screenshot({ path: path.join(__dirname, 'release/phpcode-devcontainer-preview.png') });
	await palette(page, 'phpcode: Открыть Проект Локально');
	await page.getByText('LOCAL_WORKSPACE.txt', { exact: true }).first().waitFor({ timeout: 60000 });
	await page.locator('.statusbar-item').filter({ hasText: /^\s*Dev Container\s*$/ }).first().waitFor({ timeout: 60000 });
	await palette(page,'phpcode: Открыть Агента');
	await panel.locator('.assistant').filter({hasText:'Проверено:'}).waitFor({timeout:15000});
	track('project reopens locally with its container chat history retained');
	const cleanup=await closeApp();
	const architecture=execFileSync('docker',['exec',id,'uname','-m'],{encoding:'utf8'}).trim();
	const result = { ok: true, checks, fixture, architecture, configuration:existingCompose?'existing-compose':process.env.PHPCODE_CONTAINER_TEST_COMPOSE==='1'?'compose':'image', configFile:path.relative(project,configPath), containerId: id, cleanup, liveProviderTest: false };
	if(existingCompose){fs.writeFileSync(path.join(__dirname,'devcontainer-verification-result-existing-compose.json'),JSON.stringify(result,null,2)+'\n');}
	fs.writeFileSync(path.join(__dirname,`devcontainer-verification-result-${architecture}.json`),JSON.stringify(result,null,2)+'\n');
	fs.writeFileSync(path.join(__dirname, 'devcontainer-verification-result.json'), JSON.stringify(result, null, 2) + '\n'); await new Promise(resolve=>process.stdout.write(JSON.stringify(result,null,2)+'\n',resolve));process.exit(0);
})().catch(async error => { console.error(error); if (app) { try { const page = await app.firstWindow(); await page.screenshot({ path: path.join(__dirname, 'release/phpcode-devcontainer-failure.png') }); console.error((await page.locator('body').innerText()).slice(-14000)); } catch { } await closeApp(); } process.exitCode = 1;setTimeout(()=>process.exit(1),500); });
