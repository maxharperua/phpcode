/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'resources/branding');
const work = path.join(root, '.build/design');
if (process.platform !== 'darwin') { throw new Error('Icon regeneration uses macOS sips/iconutil. Normal builds use the prepared portable assets in resources/branding.'); }
fs.mkdirSync(work, { recursive: true });
function resize(size, output) { execFileSync('sips', ['-z', String(size), String(size), path.join(assets, 'phpcode-master.png'), '--out', output], { stdio: 'ignore' }); }
resize(1024, path.join(assets, 'phpcode.png'));
const iconset = path.join(work, 'phpcode.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
	resize(size, path.join(iconset, `icon_${size}x${size}.png`));
	resize(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'phpcode.icns')]);
// Modern Windows ICO containers support alpha-preserving PNG frames at each size.
const frames = [16, 24, 32, 48, 64, 128, 256].map(size => {
	const file = path.join(work, `win-${size}.png`); resize(size, file);
	return { size, bytes: fs.readFileSync(file) };
});
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (const [index, frame] of frames.entries()) {
	const entry = 6 + index * 16;
	header[entry] = frame.size === 256 ? 0 : frame.size; header[entry + 1] = header[entry];
	header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
	header.writeUInt32LE(frame.bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
	offset += frame.bytes.length;
}
fs.writeFileSync(path.join(assets, 'phpcode.ico'), Buffer.concat([header, ...frames.map(frame => frame.bytes)]));
for (const size of [70, 150]) { resize(size, path.join(assets, `phpcode-${size}.png`)); }
console.log('Prepared PNG, macOS ICNS and Windows ICO application icons.');
