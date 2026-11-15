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
	const installers = fs.readdirSync(output).filter(file => file.endsWith('.exe'));
	if (installers.length !== 1) { throw new Error('Expected one Windows user installer.'); }
	fs.renameSync(path.join(output, installers[0]), path.join(output, `${name}-user-setup.exe`));
	// A script file and arguments avoid interpolating paths into PowerShell source.
	run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'scripts/zip.ps1'), '-Source', directory, '-Destination', path.join(output, `${name}.zip`)]);
} else if (process.platform === 'linux') {
	const dependencyFile = path.join(upstream, 'build/linux/dependencies-generator.ts');
	let generator = fs.readFileSync(dependencyFile, 'utf8');
	const optionalTunnel = "const tunnelPath = path.join(buildDir, 'bin', product.tunnelApplicationName);\n\tif (existsSync(tunnelPath)) { files.push(tunnelPath); }";
	if (!generator.includes(optionalTunnel)) {
		const before = "files.push(path.join(buildDir, 'bin', product.tunnelApplicationName));";
		if (!generator.includes(before)) { throw new Error('Review optional tunnel dependency scan for this upstream.'); }
		generator = generator.replace("import { spawnSync } from 'child_process';", "import { spawnSync } from 'child_process';\nimport { existsSync } from 'fs';").replace(before, optionalTunnel);
	}
	// phpcode ships a different set of binaries from the Microsoft reference package.
	// Keep calculating real dependencies; a reference-list difference is informational.
	generator = generator.replace('const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = true;', "const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = product.applicationName !== 'phpcode';");
	fs.writeFileSync(dependencyFile, generator);
	pnpm(['run', 'gulp', `vscode-${target}-prepare-deb`], upstream);
	pnpm(['run', 'gulp', `vscode-${target}-build-deb`], upstream);
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
