#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { repo, build, lock, upstream, run, git, requireNode, pnpm, assertUpstream, desktop } = require('./lib.cjs');
const command = process.argv[2] || 'help';
const options = process.argv.slice(3);
const script = (name, args = []) => run(process.execPath, [path.join(repo, name), ...args]);

function checkout() {
	if (fs.existsSync(upstream)) { assertUpstream(); return; }
	fs.mkdirSync(path.dirname(upstream), { recursive: true });
	const staging = fs.mkdtempSync(path.join(path.dirname(upstream), '.phpcode-checkout-'));
	try {
		run('git', ['init', staging]);
		run('git', ['remote', 'add', 'origin', lock.repository], { cwd: staging });
		run('git', ['fetch', '--depth=1', 'origin', `refs/tags/${lock.ref}`], { cwd: staging });
		run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: staging });
		if (git(['rev-parse', 'HEAD'], staging) !== lock.commit) { throw new Error('Upstream tag no longer matches upstream.json.'); }
		fs.renameSync(staging, upstream);
	} finally { fs.rmSync(staging, { recursive: true, force: true }); }
	assertUpstream();
}

function applySources() {
	assertUpstream();
	for (const component of ['product', 'ui', 'build', 'platform', 'copilot-removal', 'provider', 'agent']) {
		script(`apply-${component}.cjs`, [upstream]);
	}
	script('scripts/apply-tests.cjs', [upstream]);
	// Server entrypoint must be patched before the server is bundled, even without server assets.
	script('apply-devcontainers.cjs', [upstream, '--sources-only']);
}

function applyRuntime() {
	script('apply-database.cjs', [upstream]);
	script('apply-devcontainers.cjs', [upstream]);
}

function checkAssets(assets = path.join(build, 'server-assets')) {
	if (!fs.existsSync(path.join(assets, 'servers.json'))) { throw new Error('Missing container servers. Run node scripts/phpcode.cjs servers (Docker required).'); }
	const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'servers.json')));
	for (const platform of lock.serverPlatforms) {
		const entry = manifest[platform];
		if (!entry || entry.commit !== lock.commit || path.basename(entry.file) !== entry.file) { throw new Error(`Invalid server manifest: ${platform}`); }
		if (entry.sourceSha256 !== require('./source-digest.cjs').sourceDigest()) { throw new Error(`Server sources changed: ${platform}. Rebuild with node scripts/phpcode.cjs servers.`); }
		const file = path.join(assets, entry.file);
		if (!fs.existsSync(file)) { throw new Error(`Missing ${entry.file}. Run node scripts/phpcode.cjs servers (Docker required).`); }
		const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
		if (actual !== entry.sha256) { throw new Error(`Server checksum mismatch: ${platform}`); }
	}
}

function buildDesktop() {
	checkAssets(); applySources(); applyRuntime();
	const { target } = desktop();
	pnpm(['run', 'gulp', `vscode-${target}`], upstream);
}

async function main() {
	if (command === 'help') {
		console.log('phpcode: bootstrap | apply | servers [linux-x64|linux-arm64] | build | package | start | doctor | exec <command> [args]\nNode and upstream versions are pinned in upstream.json. See README.md for prerequisites.');
		return;
	}
	requireNode();
	if (command === 'bootstrap') {
		checkout();
		pnpm(['install', '--frozen-lockfile']);
		pnpm(['install', '--frozen-lockfile'], path.join(repo, 'database-runtime'));
		applySources();
		pnpm(['install', '--frozen-lockfile'], upstream);
		applyRuntime();
		console.log('Bootstrap complete. Build Dev Container servers next: node scripts/phpcode.cjs servers');
	} else if (command === 'apply') {
		applySources(); applyRuntime();
	} else if (command === 'servers') {
		assertUpstream(); applySources(); applyRuntime();
		const platforms = options.length ? options : lock.serverPlatforms;
		if (platforms.some(platform => !lock.serverPlatforms.includes(platform))) { throw new Error('Servers support linux-x64 and linux-arm64 only.'); }
		pnpm(['run', 'gulp', 'compile-non-native-extensions-build'], upstream);
		run(process.execPath, ['build/next/index.ts', 'bundle', '--nls', '--target', 'server', '--out', 'out-phpcode-server'], { cwd: upstream });
		for (const platform of platforms) {
			script('build-container-dependencies.cjs', [platform]);
			script('package-container-server.cjs', [platform]);
		}
		script('apply-devcontainers.cjs', [upstream]);
	} else if (command === 'build') {
		assertUpstream(); buildDesktop();
		console.log(`Desktop: ${desktop().directory}`);
	} else if (command === 'package') {
		assertUpstream(); checkAssets();
		script('scripts/package-desktop.cjs');
	} else if (command === 'start') {
		const { executable } = desktop();
		if (!fs.existsSync(executable)) { throw new Error('Run the desktop build first.'); }
		run(executable, options);
	} else if (command === 'doctor') {
		console.log(`Host: ${process.platform}-${process.arch}\nNode: ${process.versions.node}\nUpstream: ${upstream}`);
		run('git', ['--version']); pnpm(['--version']);
		if (fs.existsSync(upstream)) { assertUpstream(); }
		console.log('For native builds install the OS prerequisites in docs/BUILDING.md. Docker is required to build container servers.');
	} else if (command === 'exec') {
		assertUpstream();
		if (!options.length) { throw new Error('Specify a command, for example: exec pnpm run gulp --tasks-simple'); }
		if (options[0] === 'pnpm') { pnpm(options.slice(1), upstream); }
		else if (options[0] === 'node') { run(process.execPath, options.slice(1), { cwd: upstream }); }
		else { run(options[0], options.slice(1), { cwd: upstream }); }
	} else { throw new Error(`Unknown command: ${command}`); }
}

if (require.main === module) { main().catch(error => { console.error(error.message); process.exitCode = 1; }); }
module.exports = { checkAssets, applySources };
