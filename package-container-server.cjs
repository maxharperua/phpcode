/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { upstream, build, lock, git } = require('./scripts/lib.cjs');
const platform = process.argv[2] || 'linux-arm64';
if (!lock.serverPlatforms.includes(platform)) { throw new Error('Unsupported server platform'); }
const output = path.join(build, 'servers', platform, 'package');
const dependencies = path.join(build, 'servers', platform, 'node_modules');
const node = path.join(build, 'servers', platform, 'node');
if (!fs.existsSync(node) || !fs.existsSync(dependencies)) { throw new Error('Build the platform Node runtime and isolated remote dependencies first.'); }
fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
// pnpm links this install-only workspace to remote/web, which is outside the packaged tree.
const filter = file => file !== path.join(dependencies, 'vscode-web') && !file.endsWith('.map') && !/(?:^|[/\\])@github[/\\]copilot[^/\\]*(?:[/\\]|$)/.test(file);
fs.cpSync(path.join(upstream, 'out-phpcode-server'), path.join(output, 'out'), { recursive: true, verbatimSymlinks: true, filter });
fs.cpSync(dependencies, path.join(output, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter });
fs.copyFileSync(node, path.join(output, 'node')); fs.chmodSync(path.join(output, 'node'), 0o755);
fs.copyFileSync(path.join(path.dirname(node), 'node.LICENSE'), path.join(output, 'node.LICENSE'));
fs.copyFileSync(path.join(upstream, 'LICENSE.txt'), path.join(output, 'LICENSE.txt'));
const pkg = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json')));
const product = JSON.parse(fs.readFileSync(path.join(upstream, 'product.json')));
product.commit = git(['rev-parse', 'HEAD']);
product.version = pkg.version; product.date = new Date().toISOString();
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'phpcode-server', version: pkg.version, type: 'module' }));
fs.writeFileSync(path.join(output, 'product.json'), JSON.stringify(product));
const extensions = path.join(upstream, '.build/extensions');
for (const name of fs.readdirSync(extensions)) {
	if (['copilot', 'vscode-api-tests', 'vscode-test-resolver', 'phpcode-devcontainers', 'microsoft-authentication'].includes(name)) { continue; }
	const source = path.join(extensions, name);
	fs.cpSync(source, path.join(output, 'extensions', name), { recursive: true, verbatimSymlinks: true, filter });
}
if (!fs.existsSync(path.join(output, 'extensions/git/dist/main.js'))) { throw new Error('Compile native built-in extensions before packaging: the remote Git extension is missing.'); }
// Git's JS bundle is portable, but its bundled native dependency must match the server,
// not the desktop host that ran esbuild. Account UI continues to run on the desktop.
const gitNative = path.join(output, 'extensions/git/node_modules/@vscode/fs-copyfile');
fs.rmSync(gitNative, { recursive: true, force: true });
fs.cpSync(path.join(dependencies, '@vscode/fs-copyfile'), gitNative, { recursive: true, verbatimSymlinks: true });
const assets = path.join(build, 'server-assets'); fs.mkdirSync(assets, { recursive: true });
const archive = path.join(assets, `phpcode-server-${platform}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', output, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const manifestFile = path.join(assets, 'servers.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile)) : {};
manifest[platform] = { file: path.basename(archive), sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), commit: product.commit, version: pkg.version, sourceSha256: require('./scripts/source-digest.cjs').sourceDigest() };
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ platform, file: archive, bytes: fs.statSync(archive).size }));
