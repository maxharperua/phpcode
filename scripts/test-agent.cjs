/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

// The same pure runtime suites run in Code OSS (Mocha TDD) and in a fresh product checkout.
const source = path.resolve(__dirname, '../agent/common');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phpcode-agent-unit-'));
try {
	const tests = fs.readdirSync(source).filter(file => file.endsWith('.test.ts'));
	esbuild.buildSync({
		entryPoints: tests.map(file => path.join(source, file)), outdir: directory,
		outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs',
		banner: { js: "const { describe: suite, it: test } = require('node:test');" }
	});
	const result = spawnSync(process.execPath, ['--test', ...tests.map(file => path.join(directory, file.replace(/\.ts$/, '.cjs')))], { stdio: 'inherit' });
	if (result.error) { throw result.error; }
	process.exitCode = result.status ?? 1;
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
