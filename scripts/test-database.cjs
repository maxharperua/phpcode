/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const crypto = require('node:crypto');
const { run } = require('./lib.cjs');
const suffix = crypto.randomBytes(6).toString('hex');
const containers = { mysql: `phpcode-db-test-mysql-${suffix}`, postgres: `phpcode-db-test-postgres-${suffix}` };
const created = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function main() {
	try {
		for (const [engine, name] of Object.entries(containers)) {
			const args = engine === 'mysql'
				? ['-e', 'MARIADB_ROOT_PASSWORD=phpcode-test', '-e', 'MARIADB_DATABASE=phpcode_test', '-p', '127.0.0.1::3306', 'mariadb:11.8']
				: ['-e', 'POSTGRES_PASSWORD=phpcode-test', '-e', 'POSTGRES_DB=phpcode_test', '-p', '127.0.0.1::5432', 'postgres:17'];
			run('docker', ['run', '-d', '--name', name, ...args]); created.push(name);
			let ready = false;
			for (let attempt = 0; attempt < 90; attempt++) {
				const probe = engine === 'mysql' ? ['mariadb-admin', 'ping', '-uroot', '-pphpcode-test'] : ['pg_isready', '-U', 'postgres'];
				try { run('docker', ['exec', name, ...probe], { stdio: 'ignore' }); ready = true; break; } catch { await sleep(1000); }
			}
			if (!ready) { throw new Error(`Database fixture did not start: ${engine}`); }
		}
		run(process.execPath, ['--test', 'database/database.test.cjs'], { env: { PHPCODE_TEST_MYSQL_CONTAINER: containers.mysql, PHPCODE_TEST_POSTGRES_CONTAINER: containers.postgres } });
	} finally {
		for (const name of created) { run('docker', ['rm', '-f', name]); }
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
