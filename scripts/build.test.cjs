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
const { desktop, lock, repo, run, windowsSdkBin } = require('./lib.cjs');
const crypto = require('node:crypto');

test('release staging verifies all platform artifacts and refuses altered installers', async () => {
	const { prepareRelease } = require('./release-assets.cjs');
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'phpcode-release-test-'));
	try {
		for (const [platform, target, files] of [
			['windows', 'win32-x64', ['phpcode.exe', 'phpcode.zip']],
			['linux', 'linux-x64', ['phpcode.deb', 'phpcode.tar.gz']],
			['macos', 'darwin-arm64', ['phpcode.dmg']]
		]) {
			const folder = path.join(fixture, 'input', platform); fs.mkdirSync(folder, { recursive: true });
			const artifacts = {};
			for (const file of files) {
				const content = `fixture ${file}`; fs.writeFileSync(path.join(folder, file), content);
				artifacts[file] = { bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') };
			}
			fs.writeFileSync(path.join(folder, `build-${target}.json`), JSON.stringify({ target, upstream: lock.commit, node: lock.node, product: 'a'.repeat(40), version: '1.146.0', artifacts }));
		}
		assert.equal((await prepareRelease(path.join(fixture, 'input'), path.join(fixture, 'release'))).length, 5);
		assert.equal(fs.readFileSync(path.join(fixture, 'release/SHA256SUMS'), 'utf8').trim().split('\n').length, 5);
		fs.appendFileSync(path.join(fixture, 'input/windows/phpcode.exe'), 'tampered');
		await assert.rejects(prepareRelease(path.join(fixture, 'input'), path.join(fixture, 'invalid')), /checksum mismatch/);
		assert.equal(fs.existsSync(path.join(fixture, 'invalid')), false);
	} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('Windows SDK discovery selects the newest installed signing tools', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'phpcode-sdk-test-'));
	try {
		for (const version of ['10.0.9999.0', '10.0.26100.0']) {
			const directory = path.join(fixture, 'Windows Kits/10/bin', version, 'x64');
			fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'signtool.exe'), 'fixture');
		}
		assert.equal(windowsSdkBin(fixture, 'x64'), path.join(fixture, 'Windows Kits/10/bin/10.0.26100.0/x64'));
		assert.equal(windowsSdkBin(path.join(fixture, 'absent'), 'x64'), undefined);
	} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

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

test('upstream checkout keeps LF even when Git enables autocrlf', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'phpcode-eol-test-'));
	const invoke = args => {
		const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
	};
	try {
		invoke(['init']); invoke(['config', 'core.autocrlf', 'true']);
		const file = path.join(fixture, 'source.txt');
		fs.writeFileSync(file, 'first\nsecond\n'); invoke(['add', 'source.txt']);
		invoke(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
		fs.rmSync(file);
		run('git', ['checkout', '--', 'source.txt'], { cwd: fixture, stdio: 'ignore' });
		assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond\n');
	} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
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
