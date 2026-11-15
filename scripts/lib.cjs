/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const lock = require('../upstream.json');
const build = path.join(repo, '.build');
const upstream = path.resolve(process.env.PHPCODE_OSS_PATH || path.join(build, 'code-oss'));

function run(command, args = [], options = {}) {
	// Upstream patch anchors use LF. Git for Windows commonly enables autocrlf globally.
	if (command === 'git') { args = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args]; }
	const env = { COREPACK_HOME: path.join(build, 'corepack'), ...process.env, PNPM_CONFIG_FROZEN_LOCKFILE: 'true', ...options.env };
	const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
	const inheritedPath = env[pathKey] || '';
	delete env[pathKey];
	env.PATH = path.dirname(process.execPath) + path.delimiter + inheritedPath;
	const result = spawnSync(command, args, {
		cwd: repo, stdio: 'inherit', ...options,
		env
	});
	if (result.error) { throw result.error; }
	if (result.status !== 0) { throw new Error(`${path.basename(command)} exited with ${result.status ?? result.signal}`); }
	return result.stdout;
}

function git(args, cwd = upstream) {
	return run('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
}

function requireNode() {
	if (process.versions.node !== lock.node) {
		throw new Error(`Use Node ${lock.node} (see .nvmrc); running ${process.versions.node}. Native dependencies are runtime-specific.`);
	}
}

function pnpm(args, cwd = repo, options = {}) {
	// Calling the JS entry directly also works on Windows without shell quoting or global shims.
	const corepack = [
		path.resolve(path.dirname(process.execPath), '../lib/node_modules/corepack/dist/pnpm.js'),
		path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js')
	].find(file => fs.existsSync(file));
	const entry = process.env.PHPCODE_PNPM_CLI || corepack;
	if (!entry) { throw new Error('Corepack is required. Install it with npm install --global corepack, or set PHPCODE_PNPM_CLI to pnpm/bin/pnpm.mjs.'); }
	return run(process.execPath, [entry, ...args], { cwd, ...options });
}

function assertUpstream() {
	if (!fs.existsSync(path.join(upstream, '.git'))) { throw new Error('Run node scripts/phpcode.cjs bootstrap first.'); }
	const commit = git(['rev-parse', 'HEAD']);
	if (commit !== lock.commit) { throw new Error(`Expected upstream ${lock.commit}, got ${commit}. Existing sources were left intact.`); }
}

function desktop(platform = process.platform, arch = process.arch) {
	if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) { throw new Error(`Unsupported desktop target: ${platform}-${arch}`); }
	const target = `${platform}-${arch}`;
	const directory = path.join(path.dirname(upstream), `VSCode-${target}`);
	const executable = platform === 'darwin' ? path.join(directory, 'phpcode.app/Contents/MacOS/phpcode')
		: path.join(directory, platform === 'win32' ? 'phpcode.exe' : 'phpcode');
	return { target, directory, executable };
}

module.exports = { repo, build, lock, upstream, run, git, requireNode, pnpm, assertUpstream, desktop };
