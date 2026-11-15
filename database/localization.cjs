/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { workerData } = require('node:worker_threads');
let localization;
try { localization = require('vscode').l10n; } catch { /* Driver tests and workers use the supplied bundle. */ }
const bundle = () => localization?.bundle || workerData?.localization || {};
function t(message, ...args) {
	if (localization) { return localization.t(message, ...args); }
	return (bundle()[message] || message).replace(/\{(\d+)\}/g, (match, index) => index < args.length ? String(args[index]) : match);
}
module.exports = { t, bundle };
