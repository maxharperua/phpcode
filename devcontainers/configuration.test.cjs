/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jsonc = require('jsonc-parser');
const { readCustomizations, mergeSettingsDocument } = require('./configuration.cjs');
test('handles the actual CLI mergedConfiguration.customizations.vscode array', () => {
	assert.deepEqual(readCustomizations([{ settings: { 'editor.tabSize': 4 }, extensions: ['vendor.php', 'vendor.removed'] }, { settings: { 'editor.tabSize': 3 }, extensions: ['-vendor.removed', 'vendor.php@2.0.0'] }]), { settings: { 'editor.tabSize': 3 }, extensions: ['vendor.php@2.0.0'] });
});
test('accepts a single project configuration and skips malformed layers', () => {
	assert.deepEqual([readCustomizations({ settings: { 'files.autoSave': 'off' } }), readCustomizations([null, 3, { settings: [], extensions: [42] }])], [{ settings: { 'files.autoSave': 'off' }, extensions: [] }, { settings: {}, extensions: [] }]);
});
test('preserves JSONC comments and unrelated existing preferences', () => {
	const result = mergeSettingsDocument('// existing preference\n{ "files.autoSave": "off", "editor.tabSize": 7, }', { 'editor.tabSize': 3 }, jsonc);
	assert.match(result, /existing preference/);
	assert.deepEqual(jsonc.parse(result), { 'files.autoSave': 'off', 'editor.tabSize': 3 });
});
test('refuses malformed preferences and accepts a comment-only settings document', () => {
	assert.throws(() => mergeSettingsDocument('{ broken', { value: 1 }, jsonc), /invalid_remote_settings/);
	const result = mergeSettingsDocument('// keep comment', { 'editor.tabSize': 3 }, jsonc);
	assert.match(result, /keep comment/); assert.equal(jsonc.parse(result)['editor.tabSize'], 3);
});
