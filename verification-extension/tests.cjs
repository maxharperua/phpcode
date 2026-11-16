const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
	const resultFile = process.env.PHPCODE_VERIFICATION_RESULT;
	try {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(root, 'Verification workspace is open');
		const a = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'index.php'));
		const b = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'README.md'));
		await vscode.window.showTextDocument(a, { preview: false });
		await vscode.window.showTextDocument(b, { preview: false });
		assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && [a.uri.toString(), b.uri.toString()].includes(tab.input.uri.toString())).length, 2);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(a.uri, new vscode.Position(1, 0), '// unsaved verification\n');
		assert.equal(await vscode.workspace.applyEdit(edit), true);
		assert.equal(a.isDirty, true);
		const first = vscode.window.createTerminal({ name: 'phpcode verification A' });
		const second = vscode.window.createTerminal({ name: 'phpcode verification B' });
		assert.ok(vscode.window.terminals.includes(first) && vscode.window.terminals.includes(second));
		assert.equal(vscode.extensions.getExtension('github.copilot-chat'), undefined, 'Excluded built-in provider is absent');
		const git = vscode.extensions.getExtension('vscode.git');
		assert.ok(git, 'Bundled Git extension is present');
		await git.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['workbench.action.quickOpen', 'workbench.action.findInFiles', 'workbench.action.splitEditor', 'workbench.action.openSettingsJson', 'git.refresh']) {
			assert.ok(commands.includes(command), `${command} registered`);
		}
		await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(process.env.PHPCODE_VERIFICATION_VSIX), { donotSync: true });
		for (let attempt = 0; attempt < 40 && !vscode.extensions.getExtension('phpcode.phpcode-install-check'); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const installed = vscode.extensions.getExtension('phpcode.phpcode-install-check');
		assert.ok(installed, 'Local VSIX is installed');
		assert.equal((await installed.activate()).installed, true);
		const config = vscode.workspace.getConfiguration();
		assert.deepStrictEqual({ theme: config.get('workbench.colorTheme'), icons: config.get('workbench.iconTheme'), tabs: config.get('workbench.editor.showTabs'), editorScroll: config.get('editor.smoothScrolling'), treeScroll: config.get('workbench.list.smoothScrolling') }, { theme: 'phpcode Marsh', icons: 'phpcode-icons', tabs: 'multiple', editorScroll: true, treeScroll: true });
		assert.equal(config.get('chat.disableAIFeatures'), true);
		assert.equal(config.get('chat.copilotCliCommand.enabled'), false);
		await vscode.commands.executeCommand('workbench.action.openRawDefaultSettings');
		const defaults = vscode.window.activeTextEditor?.document.getText();
		assert.ok(defaults?.includes('editor.fontSize'), 'Default settings document is open');
		assert.doesNotMatch(defaults, /copilot/i, 'Default settings do not advertise the excluded provider');
		first.dispose(); second.dispose();
		// The temporary fixture is saved to avoid a shutdown prompt in automated mode.
		await a.save();
		fs.writeFileSync(resultFile, JSON.stringify({ ok: true, checks: ['extension host API', 'two persistent file tabs', 'workspace edits', 'multiple terminals', 'Git activation', 'local VSIX installation and activation', 'search and settings commands', 'Marsh and scrolling defaults', 'excluded built-in provider absent', 'provider defaults disabled', 'default settings without vendor mentions'] }, null, 2));
	} catch (error) {
		if (resultFile) { fs.writeFileSync(resultFile, JSON.stringify({ ok: false, message: error.stack || error.message }, null, 2)); }
		throw error;
	}
};
