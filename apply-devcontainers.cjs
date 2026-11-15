/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
const destination = path.join(root, 'extensions/phpcode-devcontainers');
fs.mkdirSync(destination, { recursive: true });
const sourceAssets = path.join(__dirname, 'devcontainers/assets');
fs.cpSync(path.join(__dirname, 'devcontainers'), destination, { recursive: true, filter: source => source !== sourceAssets && !source.endsWith('.test.cjs') });
const serverAssets = path.join(require('./scripts/lib.cjs').build, 'server-assets');
if (fs.existsSync(serverAssets)) { fs.cpSync(serverAssets, path.join(destination, 'assets'), { recursive: true }); }
fs.copyFileSync(path.join(root, 'LICENSE.txt'), path.join(destination, 'LICENSE.txt'));
if (!process.argv.includes('--sources-only')) {
	const runtime = path.join(destination, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
	fs.cpSync(path.dirname(require.resolve('jsonc-parser/package.json')), path.join(runtime, 'jsonc-parser'), { recursive: true });
	const cli = path.dirname(require.resolve('@devcontainers/cli/package.json'));
	fs.copyFileSync(path.join(cli, 'dist/spec-node/devContainersSpecCLI.js'), path.join(runtime, 'cli.js'));
	for (const file of ['LICENSE.txt', 'ThirdPartyNotices.txt']) { fs.copyFileSync(path.join(cli, file), path.join(runtime, file)); }
}
const productFile = path.join(root, 'product.json');
const product = JSON.parse(fs.readFileSync(productFile));
product.extensionEnabledApiProposals = { ...product.extensionEnabledApiProposals, 'phpcode.devcontainers': ['resolvers'] };
fs.writeFileSync(productFile, JSON.stringify(product, null, '\t') + '\n');
// This optional certificate CLI imports the excluded provider SDK even in a server bundle.
// phpcode's own agent does not use that provider or certificate command.
const entry = path.join(root, 'src/server-main.ts');
let source = fs.readFileSync(entry, 'utf8');
const disabled = "if (parsedArgs['agent-host-ca'] !== undefined) {\n\tconsole.error('This product does not include the built-in provider certificate command.');\n\tprocess.exitCode = 1;\n";
if (!source.includes(disabled)) {
	const start = source.indexOf("if (parsedArgs['agent-host-ca'] !== undefined) {");
	const end = source.indexOf('} else if (shouldSpawnCli) {', start);
	if (start < 0 || end < 0) { throw new Error('Review server entrypoint before disabling the optional provider certificate command.'); }
	source = source.slice(0, start) + disabled + source.slice(end); fs.writeFileSync(entry, source);
}
console.log('Applied built-in phpcode Dev Container workspace resolver.');
