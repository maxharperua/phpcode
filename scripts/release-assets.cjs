/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { lock } = require('./lib.cjs');

async function sha256(file) {
	const hash = crypto.createHash('sha256');
	for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); }
	return hash.digest('hex');
}

async function prepareRelease(input, output) {
	const platforms = { windows: { target: 'win32-', extensions: ['.exe', '.zip'] }, linux: { target: 'linux-', extensions: ['.deb', '.tar.gz'] }, macos: { target: 'darwin-', extensions: ['.dmg'] } };
	const entries = []; const builds = []; let version;
	for (const [platform, expected] of Object.entries(platforms)) {
		const folder = path.join(input, platform);
		const metadataFiles = fs.readdirSync(folder).filter(file => /^build-.*\.json$/.test(file));
		if (metadataFiles.length !== 1) { throw new Error(`Expected one build manifest for ${platform}`); }
		const metadata = JSON.parse(fs.readFileSync(path.join(folder, metadataFiles[0])));
		if (!metadata.target?.startsWith(expected.target) || metadata.upstream !== lock.commit || metadata.node !== lock.node || !/^[a-f0-9]{40}$/.test(metadata.product)) { throw new Error(`Unexpected build provenance for ${platform}`); }
		version ??= metadata.version;
		if (metadata.version !== version) { throw new Error('Editor versions differ between release platforms.'); }
		const files = Object.keys(metadata.artifacts);
		if (expected.extensions.some(extension => !files.some(file => file.endsWith(extension)))) { throw new Error(`Missing installer or portable archive for ${platform}`); }
		for (const file of files) {
			if (path.basename(file) !== file || file.includes('\\') || !expected.extensions.some(extension => file.endsWith(extension))) { throw new Error('Invalid release asset filename.'); }
			const source = path.join(folder, file); const recorded = metadata.artifacts[file];
			const actual = await sha256(source);
			if (fs.statSync(source).size !== recorded.bytes || actual !== recorded.sha256) { throw new Error(`Release checksum mismatch: ${file}`); }
			if (entries.some(entry => entry.file === file)) { throw new Error(`Duplicate release filename: ${file}`); }
			entries.push({ file, source, sha256: actual });
		}
		builds.push(metadata);
	}
	// Validate every platform before writing any release output.
	fs.mkdirSync(output, { recursive: true });
	for (const entry of entries) { fs.copyFileSync(entry.source, path.join(output, entry.file)); }
	fs.writeFileSync(path.join(output, 'SHA256SUMS'), entries.map(entry => `${entry.sha256}  ${entry.file}`).sort().join('\n') + '\n');
	fs.writeFileSync(path.join(output, 'builds.json'), JSON.stringify({ upstream: lock.commit, editorVersion: version, builds }, null, 2) + '\n');
	return entries.map(entry => entry.file);
}

if (require.main === module) {
	prepareRelease(path.resolve(process.argv[2] || 'dist/artifacts'), path.resolve(process.argv[3] || 'dist/release')).then(files => console.log(`Verified release assets: ${files.join(', ')}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareRelease };
