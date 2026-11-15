const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../phpcode-oss'));
const file = path.join(root, 'build/gulpfile.vscode.ts');
let source = fs.readFileSync(file, 'utf8');
function replace(before, after) {
	if (source.includes(after)) { return; }
	if (!source.includes(before)) { throw new Error('Code OSS packaging changed: review phpcode build patch'); }
	source = source.replace(before, after);
}
replace("const extensions = gulp.src(['.build/extensions/**', ...platformSpecificBuiltInExtensionsExclusions]", "const extensions = gulp.src(['.build/extensions/**', ...(product.enableBuiltinCopilot === false ? ['!.build/extensions/copilot/**'] : []), ...platformSpecificBuiltInExtensionsExclusions]");
replace('prepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)\n\t\t];', '...(product.enableBuiltinCopilot === false ? [] : [prepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)])\n\t\t];');
replace('\t\t\tcompileCopilotExtensionBuildTask,\n', '\t\t\t...(product.enableBuiltinCopilot === false ? [] : [compileCopilotExtensionBuildTask]),\n');
replace("\t\tconst depFilterPattern = ['**',", "\t\tconst depFilterPattern = ['**', ...(product.enableBuiltinCopilot === false ? ['!**/@github/copilot*/**'] : []),");
replace('\t\tensureCopilotPlatformPackage(platform, arch);', '\t\tif (product.enableBuiltinCopilot !== false) { ensureCopilotPlatformPackage(platform, arch); }');
replace("gulp.src(getCopilotRuntimePrebuildFiles(platform, arch), { base: '.', dot: true, allowEmpty: true })", "product.enableBuiltinCopilot === false ? es.readArray([]) : gulp.src(getCopilotRuntimePrebuildFiles(platform, arch), { base: '.', dot: true, allowEmpty: true })");
replace('\t\t\t\tjson.copilotVersions = {\n\t\t\t\t\truntime: copilotRuntimeVersion,\n\t\t\t\t\tsdk: getLockedPackageVersion(\'@github/copilot-sdk\'),\n\t\t\t\t};', '\t\t\t\tif (product.enableBuiltinCopilot !== false) {\n\t\t\t\t\tjson.copilotVersions = { runtime: copilotRuntimeVersion, sdk: getLockedPackageVersion(\'@github/copilot-sdk\') };\n\t\t\t\t}');
fs.writeFileSync(file, source);
console.log('Applied optional built-in Copilot packaging gate.');
