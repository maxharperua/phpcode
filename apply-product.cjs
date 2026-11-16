const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
const file = path.join(root,'product.json');
const product = JSON.parse(fs.readFileSync(file,'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(__dirname,'product-overrides.json'),'utf8'));
const result = {...product,...overrides};
if (result.enableBuiltinCopilot === false) {
	// Core extension/account APIs require this schema even when the provider is absent.
	result.defaultChatAgent = JSON.parse(fs.readFileSync(path.join(__dirname, 'disabled-agent-config.json'), 'utf8'));
	delete result.voiceWsUrl;
	delete result.copilotVersions;
	result.builtInExtensionsEnabledWithAutoUpdates = (result.builtInExtensionsEnabledWithAutoUpdates || []).filter(id => !/copilot/i.test(id));
	for (const [provider, extensions] of Object.entries(result.trustedExtensionAuthAccess || {})) {
		result.trustedExtensionAuthAccess[provider] = extensions.filter(id => !/copilot/i.test(id));
	}
}
fs.writeFileSync(file,JSON.stringify(result,null,'\t')+'\n');

// Prepared assets keep native builds portable: regenerating ICNS is not a build prerequisite.
for (const [source, destination] of [
 ['phpcode.icns', 'resources/darwin/code.icns'],
 ['phpcode.ico', 'resources/win32/code.ico'],
 ['phpcode.png', 'resources/linux/code.png'],
 ['phpcode-150.png', 'resources/win32/code_150x150.png'],
 ['phpcode-70.png', 'resources/win32/code_70x70.png']
]) { fs.copyFileSync(path.join(__dirname, 'resources/branding', source), path.join(root, destination)); }
console.log('Applied phpcode product identity and Open VSX configuration:',file);
