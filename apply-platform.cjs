/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
function replace(relative, before, after) {
	const file = path.join(root, relative);
	const source = fs.readFileSync(file, 'utf8');
	if (source.includes(after)) { return; }
	if (!source.includes(before)) { throw new Error(`Review platform branding anchor: ${relative}`); }
	fs.writeFileSync(file, source.replace(before, after));
}
replace('build/lib/electron.ts', "companyName: 'Microsoft Corporation'", "companyName: 'phpcode'");
replace('build/lib/electron.ts', "copyright: 'Copyright (C) 2026 Microsoft. All rights reserved'", "copyright: 'Copyright (C) 2026 phpcode contributors. Portions Copyright (C) Microsoft Corporation.'");
replace('build/win32/code.iss', 'AppPublisher=Microsoft Corporation', 'AppPublisher=phpcode');
replace('build/win32/code.iss', 'AppPublisherURL=https://code.visualstudio.com/', 'AppPublisherURL=https://github.com/maxharperua/phpcode');
console.log('Applied phpcode desktop publisher metadata.');
