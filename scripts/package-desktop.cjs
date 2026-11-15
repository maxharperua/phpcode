/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { repo, upstream, build, run, pnpm, git, desktop, lock } = require('./lib.cjs');
const { target, directory, executable } = desktop();
if (!fs.existsSync(executable)) { throw new Error('Run node scripts/phpcode.cjs build before packaging.'); }
const output = path.join(build, 'artifacts');
fs.mkdirSync(output, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'))).version;
const name = `phpcode-${version}-${target}`;

function copyMatching(root, suffix) {
	let count = 0;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) { count += copyMatching(file, suffix); }
		else if (entry.name.endsWith(suffix)) { fs.copyFileSync(file, path.join(output, entry.name)); count++; }
	}
	return count;
}

if (process.platform === 'win32') {
	pnpm(['run', 'gulp', `vscode-${target}-user-setup`], upstream);
	if (!copyMatching(path.join(upstream, '.build', `win32-${process.arch}`, 'user-setup'), '.exe')) { throw new Error('Windows installer was not produced.'); }
	// A script file and arguments avoid interpolating paths into PowerShell source.
	run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'scripts/zip.ps1'), '-Source', directory, '-Destination', path.join(output, `${name}.zip`)]);
} else if (process.platform === 'linux') {
	pnpm(['run', 'gulp', `vscode-${target}-prepare-deb`, `vscode-${target}-build-deb`], upstream);
	if (!copyMatching(path.join(upstream, '.build/linux/deb'), '.deb')) { throw new Error('Debian package was not produced.'); }
	run('tar', ['-czf', path.join(output, `${name}.tar.gz`), '-C', path.dirname(directory), path.basename(directory)]);
} else {
	const image = path.join(output, `${name}.dmg`);
	const staging = fs.mkdtempSync(path.join(build, 'dmg-'));
	try {
		fs.cpSync(path.join(directory, 'phpcode.app'), path.join(staging, 'phpcode.app'), { recursive: true, verbatimSymlinks: true });
		fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
		run('hdiutil', ['create', '-ov', '-volname', 'phpcode', '-srcfolder', staging, '-format', 'UDZO', image]);
		run('hdiutil', ['verify', image]);
	} finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
const artifacts = fs.readdirSync(output).filter(file => /\.(zip|deb|exe|tar\.gz|dmg)$/.test(file));
const metadata = { upstream: lock.commit, product: git(['rev-parse', 'HEAD'], repo), version, target, node: process.versions.node, created: new Date().toISOString(), artifacts: {} };
for (const file of artifacts) {
	const bytes = fs.readFileSync(path.join(output, file));
	metadata.artifacts[file] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
fs.writeFileSync(path.join(output, `build-${target}.json`), JSON.stringify(metadata, null, 2) + '\n');
console.log(`Packages and checksums: ${output}`);
