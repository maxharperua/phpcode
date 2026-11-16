const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
const sources = path.join(__dirname, 'agentProvider');
// This upstream version names sandboxed-renderer code electron-browser.
for (const [input, output] of [
	['common/provider.ts', 'common/provider.ts'],
	['common/providerProfiles.ts', 'common/providerProfiles.ts'],
	['electron-main/provider.ts', 'electron-main/provider.ts'],
	['electron-sandbox/provider.ts', 'electron-browser/provider.ts'],
	['test/provider.test.ts', 'test/electron-main/provider.test.ts']
]) {
	const target = path.join(root, 'src/vs/platform/phpcodeProvider', output);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(path.join(sources, input), target);
}
function patch(file, before, after) {
	const target = path.join(root, file);
	const source = fs.readFileSync(target, 'utf8');
	if (source.includes(after)) { return; }
	if (!source.includes(before)) { throw new Error(`Review phpcode provider patch: ${file}`); }
	fs.writeFileSync(target, source.replace(before, after));
}
// Upgrade the earlier single-service overlay without leaving duplicate registrations.
{
	const target = path.join(root, 'src/vs/code/electron-main/app.ts');
	const source = fs.readFileSync(target, 'utf8');
	const updated = source
		.replace("import { PhpcodeProviderMainService } from '../../platform/phpcodeProvider/electron-main/provider.js';", "import { PhpcodeProviderChannel } from '../../platform/phpcodeProvider/electron-main/provider.js';")
		.replace('\t\tconst phpcodeProvider = disposables.add(new PhpcodeProviderMainService());\n\t\tmainProcessElectronServer.registerChannel(PHPCODE_PROVIDER_CHANNEL, ProxyChannel.fromService(phpcodeProvider, disposables));', '\t\tconst phpcodeProvider = disposables.add(new PhpcodeProviderChannel(mainProcessElectronServer.onDidRemoveConnection));\n\t\tmainProcessElectronServer.registerChannel(PHPCODE_PROVIDER_CHANNEL, phpcodeProvider);');
	if (source !== updated) { fs.writeFileSync(target, updated); }
}
patch('src/vs/code/electron-main/app.ts', "import { app, BrowserWindow,", "import { PhpcodeProviderChannel } from '../../platform/phpcodeProvider/electron-main/provider.js';\nimport { PHPCODE_PROVIDER_CHANNEL } from '../../platform/phpcodeProvider/common/provider.js';\nimport { app, BrowserWindow,");
patch('src/vs/code/electron-main/app.ts', '\t\tconst utilityProcessWorkerChannel = ProxyChannel.fromService(accessor.get(IUtilityProcessWorkerMainService), disposables);', '\t\tconst phpcodeProvider = disposables.add(new PhpcodeProviderChannel(mainProcessElectronServer.onDidRemoveConnection));\n\t\tmainProcessElectronServer.registerChannel(PHPCODE_PROVIDER_CHANNEL, phpcodeProvider);\n\n\t\tconst utilityProcessWorkerChannel = ProxyChannel.fromService(accessor.get(IUtilityProcessWorkerMainService), disposables);');
patch('src/vs/workbench/workbench.desktop.main.ts', "import './services/request/electron-browser/requestService.js';", "import './services/request/electron-browser/requestService.js';\nimport '../platform/phpcodeProvider/electron-browser/provider.js';");
console.log('Applied native phpcode multi-provider streaming transport.');
