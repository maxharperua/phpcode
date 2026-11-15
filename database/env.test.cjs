/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectionFromEnv } = require('./env.cjs');
const base = 'DB_HOST=db\nDB_DATABASE=example\nDB_USERNAME=app\n';
test('imports Laravel fields with a literal @ password separately from metadata', () => {
	assert.deepEqual(connectionFromEnv(base + 'DB_PASSWORD=@synthetic!p%ss\n', 'Project'), { config: { engine: 'mysql', host: 'db', port: 3306, user: 'app', database: 'example', tls: false, name: 'Project · example (.env)' }, password: '@synthetic!p%ss' });
});
test('handles CRLF, export, quoted comments and empty passwords', () => {
	assert.equal(connectionFromEnv(base + 'export DB_PASSWORD="a # b @ c" # comment\r\n', 'Project').password, 'a # b @ c');
	assert.equal(connectionFromEnv(base + "DB_PASSWORD=''\n", 'Project').password, '');
});
test('expands file-local references while single quotes preserve literal content', () => {
	assert.equal(connectionFromEnv(base + 'SECRET="quoted @ #"\nDB_PASSWORD="${SECRET}"\n', 'P').password, 'quoted @ #');
	assert.equal(connectionFromEnv(base + "DB_PASSWORD='${LITERAL}'\n", 'P').password, '${LITERAL}');
});
test('refuses cyclic or missing references without exposing values', () => {
	assert.throws(() => connectionFromEnv(base + 'DB_PASSWORD=${MISSING}\n', 'P'), /Не удалось разрешить/);
	assert.throws(() => connectionFromEnv(base + 'DB_PASSWORD=${A}\nA=${DB_PASSWORD}', 'P'), /Не удалось разрешить/);
});
test('supports PostgreSQL and encoded URLs', () => {
	assert.equal(connectionFromEnv(base + 'DB_CONNECTION=pgsql\nDB_PASSWORD=example', 'P').config.port, 5432);
	assert.deepEqual(connectionFromEnv('DATABASE_URL=postgresql://app:%40p%23ss@postgres:5433/example?sslmode=verify-full', 'P'), { config: { engine: 'postgres', host: 'postgres', port: 5433, user: 'app', database: 'example', tls: true, name: 'P · example (.env)' }, password: '@p#ss' });
});
test('ignores incomplete or unsupported database configurations', () => {
	assert.equal(connectionFromEnv(base, 'P'), undefined); assert.equal(connectionFromEnv(base + 'DB_PASSWORD=a\nDB_CONNECTION=sqlite', 'P'), undefined);
});
test('does not execute shell substitutions or decode literal DB_PASSWORD', () => {
	assert.equal(connectionFromEnv(base + 'DB_PASSWORD=$(echo nope)%40', 'P').password, '$(echo nope)%40');
});
