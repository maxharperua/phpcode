const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../phpcode-oss');
const { _electron } = createRequire(path.join(root, 'package.json'))('playwright');

(async () => {
	const fixture = fs.mkdtempSync('/private/tmp/phpcode-branding-');
	const profile = path.join(fixture, 'profile');
	fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
	// Exercise the product gate with a profile that previously enabled the vendor UI.
	fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': false, 'chat.copilotCliCommand.enabled': true }));
	const project = path.join(fixture, 'project');
	fs.mkdirSync(project);
	fs.writeFileSync(path.join(project, 'index.php'), '<?php\necho "phpcode";\n');
	const packaged = process.env.PHPCODE_PACKAGED_EXECUTABLE;
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	if (!packaged) { env.VSCODE_DEV = '1'; }
	const application = await _electron.launch({ executablePath: packaged || path.join(root, '.build/electron/phpcode.app/Contents/MacOS/phpcode'), args: [...(packaged ? [] : [root]), '--user-data-dir', profile, '--extensions-dir', path.join(fixture, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', project], env, timeout: 60000 });
	try {
		const page = await application.firstWindow();
		await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
		await page.locator('.part.statusbar').waitFor({ timeout: 30000 });
		const visibleText = () => page.evaluate(() => document.body.innerText + '\n' + [...document.querySelectorAll('[title], [aria-label]')].filter(element => element.getClientRects().length).map(element => `${element.getAttribute('title') || ''} ${element.getAttribute('aria-label') || ''}`).join('\n'));
		const nativeLabels = await application.evaluate(({ Menu }) => {
			const labels = [];
			const visit = menu => { for (const item of menu?.items || []) { labels.push(item.label); if (item.submenu) { visit(item.submenu); } } };
			visit(Menu.getApplicationMenu());
			return labels.join('\n');
		});
		assert.doesNotMatch(nativeLabels, /copilot/i, 'Native menus expose vendor labels');
		assert.doesNotMatch(await visibleText(), /copilot/i, 'Workbench exposes vendor text');
		assert.equal(await page.locator('.codicon-copilot:visible').count(), 0, 'Vendor icon is visible');
		await page.keyboard.press('Meta+Shift+P');
		const palette = page.locator('.quick-input-widget input').first();
		await palette.waitFor({ state: 'visible' });
		await palette.fill('>Copilot');
		await page.waitForTimeout(500);
		assert.doesNotMatch((await page.locator('.quick-input-widget .monaco-list-row').allTextContents()).join('\n'), /copilot/i, 'Command palette exposes vendor commands');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Meta+Shift+P');
		await palette.fill('>Terminal: Create New Terminal');
		await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'Terminal: Create New Terminal' }).first().waitFor({ state: 'visible' });
		await page.keyboard.press('Enter');
		await page.locator('.terminal-wrapper .xterm').first().waitFor({ state: 'visible', timeout: 30000 });
		await page.waitForTimeout(1500);
		const terminalText = await visibleText();
		if (/copilot/i.test(terminalText)) { console.error(terminalText.split('\n').filter(line => /copilot/i.test(line)).join('\n')); }
		assert.doesNotMatch(terminalText, /copilot/i, 'Terminal exposes vendor hints');
		const screenshot = path.join(__dirname, 'release/phpcode-no-copilot-preview.png');
		fs.mkdirSync(path.dirname(screenshot), { recursive: true });
		await page.screenshot({ path: screenshot });
		console.log(JSON.stringify({ ok: true, checks: ['native application menus', 'workbench text and tooltips', 'vendor icon absent', 'command palette', 'terminal hints', 'previously enabled profile'], screenshot }, null, 2));
	} finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
