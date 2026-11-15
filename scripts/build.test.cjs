/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { desktop, lock, repo, run } = require('./lib.cjs');

test('child build scripts use the same Node runtime as the build driver', () => {
	const actual = run(process.execPath, ['-e', "process.stdout.write(require('node:child_process').execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim())"], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
	assert.equal(fs.realpathSync(actual), fs.realpathSync(process.execPath));
});

test('desktop paths select native executables for supported OSes', () => {
	assert.deepEqual(['darwin', 'linux', 'win32'].map(platform => path.relative(desktop(platform, 'x64').directory, desktop(platform, 'x64').executable).split(path.sep).join('/')), [
		'phpcode.app/Contents/MacOS/phpcode', 'phpcode', 'phpcode.exe'
	]);
	assert.throws(() => desktop('freebsd', 'x64'), /Unsupported/);
});

test('pinned toolchain matches root and driver manifests', () => {
	assert.deepEqual([require('../package.json').packageManager, require('../database-runtime/package.json').packageManager, fs.readFileSync(path.join(repo, '.nvmrc'), 'utf8').trim()], [`pnpm@${lock.pnpm}`, `pnpm@${lock.pnpm}`, lock.node]);
});

test('foreign upstream revision is rejected without modifying the checkout', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'phpcode-build-test-'));
	const invoke = args => {
		const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
	};
	try {
		invoke(['init']); invoke(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
		const before = invoke(['rev-parse', 'HEAD']);
		const result = spawnSync(process.execPath, ['-e', "require('./scripts/lib.cjs').assertUpstream()"], { cwd: repo, encoding: 'utf8', env: { ...process.env, PHPCODE_OSS_PATH: fixture } });
		assert.equal(result.status, 1); assert.match(result.stderr, /Expected upstream/); assert.equal(invoke(['rev-parse', 'HEAD']), before);
	} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('missing container servers fail packaging with an actionable message', () => {
	const { checkAssets } = require('./phpcode.cjs');
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'phpcode-assets-test-'));
	try {
		assert.throws(() => checkAssets(fixture), /Missing container servers.*Run node scripts\/phpcode.cjs servers/);
	} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
