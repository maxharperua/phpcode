/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The CLI combines image/feature/project customizations into an ordered array. */
exports.readCustomizations = value => {
	const layers = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
	const settings = {}; const extensions = new Map();
	for (const layer of layers) {
		if (!layer || typeof layer !== 'object' || Array.isArray(layer)) { continue; }
		if (layer.settings && typeof layer.settings === 'object' && !Array.isArray(layer.settings)) { Object.assign(settings, layer.settings); }
		for (const id of Array.isArray(layer.extensions) ? layer.extensions : []) {
			if (typeof id !== 'string') { continue; }
			const name = id.replace(/^-/, '').split('@')[0].toLowerCase();
			extensions.set(name, id.startsWith('-') ? undefined : id);
		}
	}
	return { settings, extensions: [...extensions.values()].filter(Boolean) };
};

/** Preserve comments and unrelated preferences when applying container customizations. */
exports.mergeSettingsDocument = (text, settings, jsonc) => {
	const errors = [];
	const parsed = jsonc.parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
	if (errors.length || (parsed !== undefined && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))) { throw new Error('invalid_remote_settings'); }
	let result = parsed === undefined ? text + '\n{}\n' : text;
	for (const [key, value] of Object.entries(settings)) {
		result = jsonc.applyEdits(result, jsonc.modify(result, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
	}
	return result;
};
