/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../phpcode-oss'));
const runtime = path.join(__dirname, 'database-runtime');
const destination = path.join(root, 'extensions/phpcode-database');
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(path.join(__dirname, 'database'), destination, { recursive: true, filter: source => !source.endsWith('.test.cjs') });
fs.copyFileSync(path.join(root, 'LICENSE.txt'), path.join(destination, 'LICENSE.txt'));
for (const name of ['codicon.css', 'codicon.ttf']) { fs.copyFileSync(path.join(root, 'node_modules/@vscode/codicons/dist', name), path.join(destination, 'media', name)); }
fs.copyFileSync(path.join(root, 'node_modules/@vscode/codicons/LICENSE'), path.join(destination, 'media/codicons.LICENSE'));
const esbuild = createRequire(path.join(root, 'extensions/package.json'))('esbuild');
const bundled = esbuild.buildSync({ stdin: { contents: "exports.mysql = require('mysql2'); exports.pg = require('pg');", resolveDir: runtime, sourcefile: 'drivers.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['pg-native'], outfile: path.join(destination, 'runtime/drivers.cjs'), metafile: true, logLevel: 'warning' });
const licenses = new Map();
for (const file of Object.keys(bundled.metafile.inputs)) {
	let directory = path.dirname(path.resolve(file));
	while (directory.includes('node_modules')) {
		const manifest = path.join(directory, 'package.json');
		if (fs.existsSync(manifest)) {
			const pkg = JSON.parse(fs.readFileSync(manifest));
			if (!pkg.name) { directory = path.dirname(directory); continue; }
			if (!licenses.has(pkg.name)) {
				const license = fs.readdirSync(directory).find(name => /^licen[sc]e(?:\.(txt|md))?$/i.test(name));
				const readme = path.join(directory, 'README.md');
				const text = license ? fs.readFileSync(path.join(directory, license), 'utf8') : fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8').split(/^## license\s*$/im)[1] : undefined;
				if (!text) { throw Error('Missing license for ' + pkg.name); }
				licenses.set(pkg.name, `${pkg.name}@${pkg.version}\n${text}`);
			}
			break;
		}
		directory = path.dirname(directory);
	}
}
fs.writeFileSync(path.join(destination, 'runtime/ThirdPartyNotices.txt'), [...licenses.values()].sort().join('\n\n----------------\n\n'));
console.log('Applied built-in phpcode database client and pinned MySQL/PostgreSQL drivers.');
