/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { repo, upstream, run } = require('./lib.cjs');
const root = process.argv[2] || upstream;
const patch = path.join(repo, 'patches/branding-tests.patch');
const check = args => spawnSync('git', ['apply', '--check', ...args, patch], { cwd: root, encoding: 'utf8' });
if (check([]).status === 0) {
	run('git', ['apply', patch], { cwd: root });
} else if (check(['--reverse']).status !== 0) {
	throw new Error('Branding tests patch does not match the pinned upstream. Review the diff before continuing.');
}
fs.cpSync(path.join(repo, 'overlays'), root, { recursive: true });
console.log('Applied phpcode regression tests.');
