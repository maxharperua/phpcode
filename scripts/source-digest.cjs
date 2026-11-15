/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { repo } = require('./lib.cjs');

function sourceDigest() {
	const files = [];
	function visit(relative) {
		const location = path.join(repo, relative);
		if (fs.statSync(location).isDirectory()) {
			for (const name of fs.readdirSync(location).sort()) {
				if (!['node_modules', 'assets'].includes(name)) { visit(`${relative}/${name}`); }
			}
		} else if (!relative.includes('.test.') && /\.(cjs|mjs|js|ts|css|html|json|yaml|svg|md)$/.test(relative)) { files.push(relative); }
	}
	for (const name of ['agent', 'agentProvider', 'database', 'database-runtime', 'devcontainers']) { visit(name); }
	for (const name of fs.readdirSync(repo).filter(name => /^apply-.*\.cjs$/.test(name))) { files.push(name); }
	files.push('upstream.json', 'product-overrides.json', 'disabled-agent-config.json', 'package.json', 'pnpm-lock.yaml', 'package-container-server.cjs', 'build-container-dependencies.cjs', 'scripts/source-digest.cjs', 'scripts/phpcode.cjs');
	const hash = crypto.createHash('sha256');
	for (const name of files.sort()) {
		hash.update(name + '\0');
		// Git checkouts may use CRLF on Windows; the source identity must remain portable.
		hash.update(fs.readFileSync(path.join(repo, name), 'utf8').replaceAll('\r\n', '\n') + '\0');
	}
	return hash.digest('hex');
}
module.exports = { sourceDigest };
