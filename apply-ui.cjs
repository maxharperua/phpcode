const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, '\t') + '\n'); };
const themeRoot = path.join(root, 'extensions/theme-defaults');
const colors = {
	'foreground': '#f8f8f2', 'focusBorder': '#bd93f9', 'descriptionForeground': '#a4abc4',
	'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', 'editorCursor.foreground': '#f8f8f2',
	'editor.selectionBackground': '#44475a', 'editor.lineHighlightBackground': '#44475a60',
	'editorLineNumber.foreground': '#6272a4', 'editorLineNumber.activeForeground': '#f8f8f2',
	'editorIndentGuide.background1': '#44475a', 'editorIndentGuide.activeBackground1': '#6272a4',
	'activityBar.background': '#21222c', 'activityBar.foreground': '#f8f8f2', 'activityBar.activeBorder': '#bd93f9',
	'sideBar.background': '#21222c', 'sideBar.foreground': '#f8f8f2', 'sideBarSectionHeader.background': '#282a36',
	'list.activeSelectionBackground': '#44475a', 'list.activeSelectionForeground': '#f8f8f2',
	'list.inactiveSelectionBackground': '#44475a90', 'list.hoverBackground': '#44475a60', 'list.focusOutline': '#bd93f9',
	'editorGroupHeader.tabsBackground': '#21222c', 'tab.activeBackground': '#282a36', 'tab.inactiveBackground': '#21222c',
	'tab.activeBorderTop': '#bd93f9', 'tab.activeForeground': '#f8f8f2', 'tab.inactiveForeground': '#a4abc4',
	'titleBar.activeBackground': '#21222c', 'titleBar.activeForeground': '#f8f8f2', 'titleBar.inactiveBackground': '#21222c',
	'statusBar.background': '#21222c', 'statusBar.foreground': '#f8f8f2', 'statusBar.noFolderBackground': '#21222c',
	'panel.background': '#282a36', 'panel.border': '#44475a', 'panelTitle.activeBorder': '#bd93f9',
	'input.background': '#282a36', 'input.foreground': '#f8f8f2', 'input.border': '#44475a',
	'button.background': '#bd93f9', 'button.foreground': '#21222c', 'button.hoverBackground': '#caa6ff',
	'badge.background': '#bd93f9', 'badge.foreground': '#21222c', 'progressBar.background': '#bd93f9',
	'editorWidget.background': '#21222c', 'editorWidget.border': '#44475a', 'dropdown.background': '#282a36',
	'peekViewEditor.background': '#21222c', 'peekViewResult.background': '#21222c',
	'terminal.background': '#282a36', 'terminal.foreground': '#f8f8f2', 'terminalCursor.foreground': '#f8f8f2',
	'terminal.ansiBlack': '#21222c', 'terminal.ansiRed': '#ff5555', 'terminal.ansiGreen': '#50fa7b',
	'terminal.ansiYellow': '#f1fa8c', 'terminal.ansiBlue': '#bd93f9', 'terminal.ansiMagenta': '#ff79c6',
	'terminal.ansiCyan': '#8be9fd', 'terminal.ansiWhite': '#f8f8f2', 'terminal.ansiBrightBlack': '#6272a4',
	'terminal.ansiBrightRed': '#ff6e6e', 'terminal.ansiBrightGreen': '#69ff94', 'terminal.ansiBrightYellow': '#ffffa5',
	'terminal.ansiBrightBlue': '#d6acff', 'terminal.ansiBrightMagenta': '#ff92df', 'terminal.ansiBrightCyan': '#a4ffff', 'terminal.ansiBrightWhite': '#ffffff'
};
writeJson(path.join(themeRoot, 'themes/phpcode-dracula.json'), {
	name: 'phpcode Dracula', type: 'dark', colors,
	tokenColors: [
		{ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#6272a4', fontStyle: 'italic' } },
		{ scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#ff79c6' } },
		{ scope: ['string'], settings: { foreground: '#f1fa8c' } },
		{ scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#bd93f9' } },
		{ scope: ['entity.name.function', 'support.function'], settings: { foreground: '#50fa7b' } },
		{ scope: ['entity.name.type', 'support.type', 'support.class'], settings: { foreground: '#8be9fd' } },
		{ scope: ['variable.parameter'], settings: { foreground: '#ffb86c' } },
		{ scope: ['entity.name.tag'], settings: { foreground: '#ff79c6' } },
		{ scope: ['entity.other.attribute-name'], settings: { foreground: '#50fa7b' } }
	], semanticHighlighting: true
});
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
manifest.contributes.themes = manifest.contributes.themes.filter(theme => theme.id !== 'phpcode Dracula');
manifest.contributes.themes.push({ id: 'phpcode Dracula', label: 'phpcode Dracula', uiTheme: 'vs-dark', path: './themes/phpcode-dracula.json' });
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

// Product defaults remain overridable in the user's settings.json.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	source: 'phpcode',
	overrides: {
		'workbench.colorTheme': 'phpcode Dracula',
		'workbench.preferredDarkColorTheme': 'phpcode Dracula',
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
console.log('Applied phpcode built-in Dracula, project icons, and editor defaults.');
