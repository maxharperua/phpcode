const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phpcode-base-verification-'));
const workspace = path.join(directory, 'project');
const resultFile = path.join(directory, 'result.json');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'index.php'), '<?php\nfunction hello(): string { return "phpcode"; }\n');
fs.writeFileSync(path.join(workspace, 'README.md'), '# phpcode verification\n');
const vsix = path.join(directory, 'installation-check.vsix');
const archive = spawnSync('python3', ['-c', `import zipfile,json,sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('extension/package.json',json.dumps({'name':'phpcode-install-check','publisher':'phpcode','version':'0.0.1','engines':{'vscode':'^1.146.0'},'main':'./extension.cjs','activationEvents':['*']}))
 z.writestr('extension/extension.cjs','exports.activate = () => ({installed:true});')
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
 z.writestr('extension.vsixmanifest','<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="phpcode-install-check" Version="0.0.1" Publisher="phpcode"/><DisplayName>phpcode installation verification</DisplayName><Description xml:space="preserve">Local verification fixture</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.146.0"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>')`, vsix], { encoding: 'utf8' });
if (archive.status !== 0) { throw new Error(archive.stderr); }
// Only our generated test fixture uses this flag. Production launches retain workspace trust.
const child = spawn(process.env.PHPCODE_PACKAGED_EXECUTABLE || 'bash', [...(process.env.PHPCODE_PACKAGED_EXECUTABLE ? [] : [path.resolve(__dirname, '../phpcode-oss/scripts/code.sh')]), '--user-data-dir', path.join(directory, 'profile'), '--extensions-dir', path.join(directory, 'extensions'), '--extensionDevelopmentPath', path.join(__dirname, 'verification-extension'), '--extensionTestsPath', path.join(__dirname, 'verification-extension/tests.cjs'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace], { stdio: 'inherit', env: { ...process.env, VSCODE_SKIP_PRELAUNCH: '1', PHPCODE_VERIFICATION_RESULT: resultFile, PHPCODE_VERIFICATION_VSIX: vsix } });
let finished = false;
const interval = setInterval(() => {
	if (!fs.existsSync(resultFile)) { return; }
	finished = true; clearInterval(interval); clearTimeout(timeout);
	const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
	console.log(JSON.stringify({ ...result, resultFile }, null, 2));
	process.exitCode = result.ok ? 0 : 1;
}, 500);
const timeout = setTimeout(() => { clearInterval(interval); console.error('Verification timed out. Results directory:', directory); child.kill('SIGTERM'); process.exitCode = 1; }, 120000);
child.on('error', error => { clearInterval(interval); clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', code => { if (code && !finished) { clearInterval(interval); clearTimeout(timeout); console.error('Editor exited before completing verification:', code); process.exitCode = 1; } });
