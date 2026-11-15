const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname,'../phpcode-oss'));
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
console.log('Applied phpcode product identity and Open VSX configuration:',file);
