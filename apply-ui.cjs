const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, '\t') + '\n'); };
const themeRoot = path.join(root, 'extensions/theme-defaults');
writeJson(path.join(themeRoot, 'themes/phpcode-marsh.json'), JSON.parse(fs.readFileSync(path.join(__dirname, 'resources/themes/phpcode-marsh.json'), 'utf8')));
const iconsDir = path.join(themeRoot, 'icons/phpcode');
fs.mkdirSync(iconsDir, { recursive: true });
const definitions = {};
const addIcon = (name, body) => {
	fs.writeFileSync(path.join(iconsDir, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${body}</svg>\n`);
	definitions[name] = { iconPath: `./phpcode/${name}.svg` };
};
const folder = (color, open) => `<path d="M2 4.5h5l1.8 2H18v10H2z" fill="${color}" opacity="${open ? '.45' : '.85'}"/>${open ? `<path d="M2 9h17l-2.5 7.5H2z" fill="${color}"/>` : ''}`;
for (const [name, color] of [['folder', '#ffb86c'], ['source', '#8be9fd'], ['test', '#50fa7b']]) {
	addIcon(name, folder(color, false)); addIcon(name + '-open', folder(color, true));
}
for (const [name, label, color] of [
	['file', '', '#a4abc4'], ['php', 'php', '#bd93f9'], ['js', 'JS', '#f1fa8c'], ['ts', 'TS', '#8be9fd'],
	['json', '{}', '#f1fa8c'], ['css', '#', '#bd93f9'], ['html', '&lt;&gt;', '#ffb86c'], ['sql', 'SQL', '#8be9fd'],
	['markdown', 'M', '#a4abc4'], ['config', '=', '#ff79c6'], ['image', 'IMG', '#ff79c6'], ['shell', '$_', '#50fa7b']
]) {
	addIcon(name, `<path d="M4 1.5h8l4 4v13H4z" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width=".9"/><path d="M12 1.5v4h4" fill="none" stroke="${color}" stroke-width=".9"/><text x="10" y="13.3" text-anchor="middle" fill="${color}" font-size="${label.length > 2 ? 5.3 : 7}" font-family="Arial,sans-serif" font-weight="700">${label}</text>`);
}
writeJson(path.join(themeRoot, 'icons/phpcode-icons.json'), {
	iconDefinitions: definitions, file: 'file', folder: 'folder', folderExpanded: 'folder-open', rootFolder: 'folder', rootFolderExpanded: 'folder-open',
	folderNames: { src: 'source', app: 'source', lib: 'source', public: 'source', tests: 'test', test: 'test' },
	folderNamesExpanded: { src: 'source-open', app: 'source-open', lib: 'source-open', public: 'source-open', tests: 'test-open', test: 'test-open' },
	fileExtensions: { php: 'php', phtml: 'php', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', json: 'json', jsonc: 'json', css: 'css', scss: 'css', html: 'html', xml: 'html', sql: 'sql', sqlite: 'sql', db: 'sql', md: 'markdown', yaml: 'config', yml: 'config', toml: 'config', ini: 'config', env: 'config', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', svg: 'image', sh: 'shell', zsh: 'shell' },
	fileNames: { 'composer.json': 'php', 'composer.lock': 'php', Dockerfile: 'config', '.env': 'config', '.gitignore': 'config' }
});
const manifestFile = path.join(themeRoot, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.contributes.themes = manifest.contributes.themes.filter(theme => !['phpcode Dracula', 'phpcode Marsh'].includes(theme.id));
manifest.contributes.themes.push({ id: 'phpcode Marsh', label: 'phpcode Marsh', uiTheme: 'vs-dark', path: './themes/phpcode-marsh.json' });
manifest.contributes.iconThemes = [...(manifest.contributes.iconThemes || []).filter(theme => theme.id !== 'phpcode-icons'), { id: 'phpcode-icons', label: 'phpcode Project Icons', path: './icons/phpcode-icons.json' }];
writeJson(manifestFile, manifest);
const contribution = path.join(root, 'src/vs/workbench/contrib/phpcode/browser/phpcode.contribution.ts');
fs.mkdirSync(path.dirname(contribution), { recursive: true });
fs.writeFileSync(contribution, `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry } from '../../../common/views.js';
import { Extensions as MigrationExtensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';

Registry.as<IConfigurationMigrationRegistry>(MigrationExtensions.ConfigurationMigration).registerConfigurationMigrations(
	['workbench.colorTheme', 'workbench.preferredDarkColorTheme'].map(key => ({
		key, includeApplication: true,
		migrateFn: value => value === 'phpcode Dracula' ? { value: 'phpcode Marsh' } : []
	}))
);

// Product defaults remain overridable in the user's settings.json.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	source: 'phpcode',
	overrides: {
		'workbench.colorTheme': 'phpcode Marsh',
		'workbench.preferredDarkColorTheme': 'phpcode Marsh',
		'workbench.iconTheme': 'phpcode-icons',
		'workbench.editor.showTabs': 'multiple',
		'workbench.editor.enablePreview': false,
		'workbench.editor.restoreViewState': true,
		'workbench.tree.enableStickyScroll': true,
		'workbench.tree.renderIndentGuides': 'always',
		'workbench.list.smoothScrolling': true,
		'editor.smoothScrolling': true,
		'terminal.integrated.smoothScrolling': true,
		'files.hotExit': 'onExitAndWindowClose',
		'window.restoreWindows': 'all',
		'workbench.startupEditor': 'none',
		'chat.disableAIFeatures': true,
		'chat.copilotCliCommand.enabled': false
	}
}]);

// Product scope excludes debugger and Problems panes. Language diagnostics and
// extension-host services remain available to PHP analysis extensions.
const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
for (const id of ['workbench.view.debug', 'workbench.panel.repl', 'workbench.panel.markers']) {
	const container = containers.get(id);
	if (container) {
		views.deregisterViews(views.getViews(container), container);
		containers.deregisterViewContainer(container);
	}
}
`);
const mainFile = path.join(root, 'src/vs/workbench/workbench.common.main.ts');
let main = fs.readFileSync(mainFile, 'utf8');
const importLine = "import './contrib/phpcode/browser/phpcode.contribution.js';";
if (!main.includes(importLine)) { main += '\n// phpcode product defaults\n' + importLine + '\n'; fs.writeFileSync(mainFile, main); }
console.log('Applied phpcode built-in Marsh theme, project icons, and editor defaults.');

// phpcode has provider settings in the agent, without a distribution account.
// Keep extension authentication services available, but omit the unused global UI.
function patch(file, before, after) {
	const target = path.join(root, file);
	const source = fs.readFileSync(target, 'utf8');
	if (source.includes(after)) { return; }
	if (!source.includes(before)) { throw new Error(`Review phpcode UI patch for ${file}`); }
	fs.writeFileSync(target, source.replace(before, after));
}
const globalBar = 'src/vs/workbench/browser/parts/globalCompositeBar.ts';
patch(globalBar, "import './media/globalCompositeBar.css';", "import './media/globalCompositeBar.css';\nimport product from '../../../platform/product/common/product.js';");
patch(globalBar, 'export function isAccountsActionVisible(storageService: IStorageService): boolean {', 'export function isAccountsActionVisible(storageService: IStorageService): boolean {\n\tif (product.enableBuiltinCopilot === false) { return false; }');
patch(globalBar, '\tgetContextMenuActions(): IAction[] {', '\tgetContextMenuActions(): IAction[] {\n\t\tif (product.enableBuiltinCopilot === false) { return []; }');
patch(globalBar, 'function simpleActivityContextMenuActions(storageService: IStorageService, isAccount: boolean): IAction[] {', `function simpleActivityContextMenuActions(storageService: IStorageService, isAccount: boolean): IAction[] {
	if (product.enableBuiltinCopilot === false) {
		return [toAction({ id: 'toggle.hideManage', label: localize('manage', "Manage"), checked: true, enabled: false, run: () => { throw new Error('"Manage" can not be hidden'); } })];
	}`);
