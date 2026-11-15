const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || require('./scripts/lib.cjs').upstream);
const destination = path.join(root, 'src/vs/workbench/contrib/phpcode');
fs.cpSync(path.join(__dirname, 'agent'), destination, { recursive: true, filter: source => !source.endsWith('.test.ts') });
const testDir = path.join(destination, 'test/common'); fs.mkdirSync(testDir, { recursive: true });
for (const name of ['runtime', 'providerRequest', 'codeIndex', 'compaction', 'executionPolicy', 'fileReferences']) {
 const tests = fs.readFileSync(path.join(__dirname, `agent/common/${name}.test.ts`), 'utf8')
  .replaceAll("from './runtime.js'", "from '../../common/runtime.js'")
  .replaceAll("from './providerRequest.js'", "from '../../common/providerRequest.js'")
  .replaceAll("from './codeIndex.js'", "from '../../common/codeIndex.js'")
  .replaceAll("from './compaction.js'", "from '../../common/compaction.js'")
  .replaceAll("from './executionPolicy.js'", "from '../../common/executionPolicy.js'")
  .replaceAll("from './fileReferences.js'", "from '../../common/fileReferences.js'");
 fs.writeFileSync(path.join(testDir, `${name}.test.ts`), tests
  .replace("import assert from 'assert';", "import assert from 'assert';\nimport { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';")
  .replace(/(suite\('[^']+', \(\) => \{)/g, '$1\n\tensureNoDisposablesAreLeakedInTestSuite();'));
}
const resourcesFile = path.join(root, 'build/lib/i18n.resources.json');
const resources = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'));
if (!resources.workbench.some(item => item.name === 'vs/workbench/contrib/phpcode')) {
 resources.workbench.push({ name: 'vs/workbench/contrib/phpcode', project: 'vscode-workbench' });
 fs.writeFileSync(resourcesFile, JSON.stringify(resources, null, '\t') + '\n');
}
const entry = path.join(root, 'src/vs/workbench/workbench.desktop.main.ts');
const statement = "import './contrib/phpcode/browser/agent.contribution.js';";
const source = fs.readFileSync(entry, 'utf8');
if (!source.includes(statement)) { fs.writeFileSync(entry, source.trimEnd() + '\n\n' + statement + '\n'); }
console.log('Applied native phpcode agent, sessions, tools, and review UI.');
