/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { upstream, build: cache, lock } = require('./scripts/lib.cjs');
const platform = process.argv[2] || 'linux-arm64';
if (!['linux-arm64', 'linux-x64'].includes(platform)) { throw new Error('Choose linux-arm64 or linux-x64'); }
const arch = platform.slice(6);
if (fs.existsSync(path.join(cache, 'servers', platform, 'build'))) { fs.rmSync(path.join(cache, 'servers', platform, 'build'), { recursive: true }); }
const output = path.join(cache, 'servers', platform);
const build = path.join(output, 'build');
const dockerPlatform = arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
const name = 'phpcode-server-build-' + crypto.randomBytes(6).toString('hex');
const docker = args => execFileSync('docker', args, { stdio: 'inherit' });
for (const relative of ['remote/package.json', 'remote/pnpm-lock.yaml', 'remote/pnpm-workspace.yaml', 'remote/.pnpmfile.mjs', 'remote/web/package.json', 'build/npm/pnpm/nativeBuildEnv.ts']) {
	const target = path.join(build, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(path.join(upstream, relative), target);
}
docker(['pull', '--platform', dockerPlatform, lock.serverImage]);
docker(['create', '--platform', dockerPlatform, '--name', name, lock.serverImage, 'sleep', 'infinity']);
try {
	docker(['start', name]);
	docker(['cp', build, name + ':/work']);
	docker(['exec', '-w', '/work/remote', name, 'corepack', 'pnpm', 'install', '--frozen-lockfile', '--store-dir', '/pnpm-store']);
	fs.rmSync(path.join(output, 'node_modules'), { recursive: true, force: true });
	docker(['cp', name + ':/work/remote/node_modules', path.join(output, 'node_modules')]);
	docker(['cp', name + ':/usr/local/bin/node', path.join(output, 'node')]);
	docker(['cp', name + ':/usr/local/LICENSE', path.join(output, 'node.LICENSE')]);
} finally { docker(['rm', '-f', name]); }
