/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const platform = process.argv[2] || 'linux-arm64';
if (!['linux-arm64', 'linux-x64'].includes(platform)) { throw new Error('Choose linux-arm64 or linux-x64'); }
const arch = platform.slice(6);
const output = path.join(root, 'tools/phpcode-server', platform);
const build = path.join(output, 'build');
const dockerPlatform = arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
const name = 'phpcode-server-build-' + crypto.randomBytes(6).toString('hex');
const docker = args => execFileSync('docker', args, { stdio: 'inherit' });
for (const relative of ['remote/package.json', 'remote/pnpm-lock.yaml', 'remote/pnpm-workspace.yaml', 'remote/.pnpmfile.mjs', 'remote/web/package.json', 'build/npm/pnpm/nativeBuildEnv.ts']) {
	const target = path.join(build, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(path.join(root, 'phpcode-oss', relative), target);
}
docker(['pull', '--platform', dockerPlatform, 'node:24.22.1-bookworm']);
docker(['create', '--platform', dockerPlatform, '--name', name, 'node:24.22.1-bookworm', 'sleep', 'infinity']);
try {
	docker(['start', name]);
	docker(['cp', path.join(root, 'tools/phpcode-build/node_modules/pnpm'), name + ':/opt/pnpm']);
	docker(['cp', build, name + ':/work']);
	docker(['exec', '-w', '/work/remote', name, 'node', '/opt/pnpm/bin/pnpm.mjs', 'install', '--frozen-lockfile', '--store-dir', '/pnpm-store']);
	fs.rmSync(path.join(output, 'node_modules'), { recursive: true, force: true });
	docker(['cp', name + ':/work/remote/node_modules', path.join(output, 'node_modules')]);
} finally { docker(['rm', '-f', name]); }
