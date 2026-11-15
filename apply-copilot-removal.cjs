const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
function patch(file, before, after) {
	const target = path.join(root, file);
	const source = fs.readFileSync(target, 'utf8');
	if (after && source.includes(after)) { return; }
	if (!after && !source.includes(before)) { return; }
	if (!source.includes(before)) { throw new Error(`Review phpcode patch for ${file}`); }
	fs.writeFileSync(target, source.replace(before, after));
}
patch('src/vs/base/common/product.ts', 'export interface IProductConfiguration {', 'export interface IProductConfiguration {\n\t/** Whether the distribution includes the upstream Copilot product surfaces. */\n\treadonly enableBuiltinCopilot?: boolean;');
patch('src/vs/platform/product/common/product.ts', 'if (!product.copilotVersions) {', 'if (product.enableBuiltinCopilot !== false && !product.copilotVersions) {');
patch('src/vs/workbench/services/accounts/browser/defaultAccount.ts', '\t\tthis.defaultAccountConfig = toDefaultAccountConfig(productService.defaultChatAgent);', '\t\tthis.defaultAccountConfig = toDefaultAccountConfig(productService.defaultChatAgent);\n\t\tif (productService.enableBuiltinCopilot === false) {\n\t\t\tthis.initBarrier.open();\n\t\t}');
patch('src/vs/workbench/services/accounts/browser/defaultAccount.ts', '\t\t@IDefaultAccountService defaultAccountService: IDefaultAccountService,\n\t) {', '\t\t@IDefaultAccountService defaultAccountService: IDefaultAccountService,\n\t\t@IContextKeyService contextKeyService: IContextKeyService,\n\t) {');
patch('src/vs/workbench/services/accounts/browser/defaultAccount.ts', '\t\tconst defaultAccountProvider = this._register(instantiationService.createInstance(DefaultAccountProvider, toDefaultAccountConfig(productService.defaultChatAgent)));', '\t\tif (productService.enableBuiltinCopilot === false) {\n\t\t\tCONTEXT_DEFAULT_ACCOUNT_STATE.bindTo(contextKeyService).set(DefaultAccountStatus.Unavailable);\n\t\t\treturn;\n\t\t}\n\t\tconst defaultAccountProvider = this._register(instantiationService.createInstance(DefaultAccountProvider, toDefaultAccountConfig(productService.defaultChatAgent)));');
{
	const before = `		deprecated[this.productService.defaultChatAgent.extensionId.toLowerCase()] = {
			disallowInstall: true,
			extension: {
				id: this.productService.defaultChatAgent.chatExtensionId,
				displayName: 'GitHub Copilot Chat',
				autoMigrate: { storage: false, donotDisable: true },
				preRelease: this.productService.quality !== 'stable'
			}
		};`;
	const after = '\t\tif (this.productService.enableBuiltinCopilot !== false) {\n' + before.split('\n').map(line => '\t' + line).join('\n') + '\n\t\t}';
	patch('src/vs/platform/extensionManagement/common/extensionGalleryService.ts', before, after);
}
patch('src/vs/platform/extensionManagement/common/extensionsScannerService.ts', '\t\tlet allSystemExtensions = [...defaultSystemExtensions, ...devSystemExtensions];', `		let allSystemExtensions = [...defaultSystemExtensions, ...devSystemExtensions];
		if (this.productService.enableBuiltinCopilot === false) {
			allSystemExtensions = allSystemExtensions.filter(extension => !['github.copilot', 'github.copilot-chat'].includes(extension.identifier.id.toLowerCase()));
		}`);
patch('src/vs/workbench/services/chat/common/chatEntitlementService.ts', '\t\tif (!productService.defaultChatAgent) {', `\t\tif (productService.enableBuiltinCopilot === false) {
			ChatEntitlementContextKeys.Setup.hidden.bindTo(this.contextKeyService).set(true);
			ChatEntitlementContextKeys.Setup.disabled.bindTo(this.contextKeyService).set(true);
			return;
		}

		if (!productService.defaultChatAgent) {`);
patch('src/vs/workbench/services/chat/common/chatEntitlementService.ts', '\tsetForceHidden(hidden: boolean): void {\n\t\tif (this.context)', '\tsetForceHidden(hidden: boolean): void {\n\t\tif (product.enableBuiltinCopilot === false) {\n\t\t\treturn;\n\t\t}\n\t\tif (this.context)');
patch('src/vs/workbench/services/agentHost/electron-browser/agentHostService.ts', "import { Disposable }", "import product from '../../../../platform/product/common/product.js';\nimport { Disposable }");
patch('src/vs/workbench/services/agentHost/electron-browser/agentHostService.ts', 'if (environmentService.remoteAuthority) {', 'if (environmentService.remoteAuthority || product.enableBuiltinCopilot === false) {');
patch('src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts', "assertDefined(product.defaultChatAgent, 'Onboarding requires a default chat agent product configuration.');\nconst defaultChat = product.defaultChatAgent;", 'const defaultChat = product.defaultChatAgent!;');
patch('src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts', "import { assertDefined } from '../../../../base/common/types.js';\n", '');
patch('src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts', '\tshow(): void {\n\t\tif (this.overlay)', '\tshow(): void {\n\t\tif (!product.defaultChatAgent || product.enableBuiltinCopilot === false) {\n\t\t\treturn;\n\t\t}\n\t\tif (this.overlay)');
// Restrict the onboarding action as well as its service entry point.
patch('src/vs/workbench/contrib/welcomeOnboarding/browser/welcomeOnboarding.contribution.ts', "import { localize2 }", "import product from '../../../../platform/product/common/product.js';\nimport { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';\nimport { localize2 }");
patch('src/vs/workbench/contrib/welcomeOnboarding/browser/welcomeOnboarding.contribution.ts', "id: 'workbench.action.welcomeOnboarding2026',", "id: 'workbench.action.welcomeOnboarding2026',\n\t\t\tprecondition: product.enableBuiltinCopilot === false ? ContextKeyExpr.false() : undefined,");
patch('src/vs/platform/actions/common/actions.ts', "import { IAction, SubmenuAction }", "import product from '../../product/common/product.js';\nimport { IAction, SubmenuAction }");
patch('src/vs/platform/actions/common/actions.ts', '\t\treturn result;\n\t}\n\n\tappendMenuGroup', `\t\tif (product.enableBuiltinCopilot === false) {
			result = result.filter(item => {
				const command = isIMenuItem(item) ? item.command : undefined;
				const title = command?.title ?? (isISubmenuItem(item) ? item.title : '');
				const category = command?.category;
				return !/copilot/i.test([
					command?.id,
					typeof title === 'string' ? title : title.value,
					typeof title === 'string' ? title : title.original,
					typeof category === 'string' ? category : category?.value,
					typeof category === 'string' ? category : category?.original,
					isISubmenuItem(item) ? item.submenu.id : ''
				].join(' '));
			});
		}
		return result;
	}

	appendMenuGroup`);
patch('src/vs/workbench/services/preferences/common/preferencesModels.ts', "import { coalesce }", "import product from '../../../../platform/product/common/product.js';\nimport { coalesce }");
patch('src/vs/workbench/services/preferences/common/preferencesModels.ts', '\t\tfor (const [key, property] of Object.entries(properties)) {', `\t\tfor (const [key, property] of Object.entries(properties)) {
			// Hide vendor-only settings in the UI and default-settings document,
			// while preserving their internal defaults and extension API contracts.
			if (product.enableBuiltinCopilot === false && /copilot/i.test(JSON.stringify([
				key, property.description, property.markdownDescription, property.default,
				property.enum, property.enumDescriptions, property.markdownEnumDescriptions,
				property.deprecationMessage, property.markdownDeprecationMessage, property.section?.title
			]))) {
				continue;
			}`);
console.log('Applied phpcode provider, menus, settings, terminal-hint and onboarding gates.');
