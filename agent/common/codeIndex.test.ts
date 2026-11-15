/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CodeIndex } from './codeIndex.js';

suite('phpcode local code index', () => {
	test('updates postings and fingerprints incrementally, including unchanged content metadata', () => {
		const index = new CodeIndex();
		const first = index.replaceFile('src/Invoice.php', '<?php function calculateInvoice() { return 1; }', 'mtime-1');
		const unchanged = index.replaceFile('src/Invoice.php', '<?php function calculateInvoice() { return 1; }', 'mtime-1');
		const metadata = index.replaceFile('src/Invoice.php', '<?php function calculateInvoice() { return 1; }', 'mtime-2');
		const fingerprint = index.getFingerprint('src/Invoice.php');
		const updated = index.replaceFile('src/Invoice.php', '<?php function collectReceipt() { return 2; }', 'mtime-3');
		const beforeDelete = { old: index.search('calculate').length, current: index.search('collectReceipt').map(match => match.path), files: index.fileCount, chunks: index.chunkCount };
		const removed = index.removeFile('src/Invoice.php');
		assert.deepStrictEqual({ first, unchanged, metadata, fingerprint, updated, beforeDelete, removed, afterDelete: { matches: index.search('collectReceipt'), paths: index.listPaths(), files: index.fileCount, chunks: index.chunkCount }, removedAgain: index.removeFile('missing.php') }, {
			first: true, unchanged: false, metadata: true, fingerprint: 'mtime-2', updated: true,
			beforeDelete: { old: 0, current: ['src/Invoice.php'], files: 1, chunks: 1 }, removed: true,
			afterDelete: { matches: [], paths: [], files: 0, chunks: 0 }, removedAgain: false
		});
	});

	test('ranks filename and declaration matches above incidental body mentions', () => {
		const index = new CodeIndex();
		index.replaceFile('notes/guide.txt', '// user repository\n'.repeat(60));
		index.replaceFile('app/Services/UserRepository.php', '<?php\nclass UserRepository { public function findByEmail() {} }');
		index.replaceFile('misc.php', '<?php\nclass Wrapper { function sendUserEmail() {} }');
		assert.deepStrictEqual({
			camel: index.search('UserRepository').slice(0, 1).map(match => match.path),
			parts: index.search('user repository').slice(0, 1).map(match => match.path),
			snake: index.search('find_by_email').slice(0, 1).map(match => match.path)
		}, {
			camel: ['app/Services/UserRepository.php'], parts: ['app/Services/UserRepository.php'], snake: ['app/Services/UserRepository.php']
		});
	});

	test('tokenizes acronym camelCase, snake_case and Unicode identifiers', () => {
		const index = new CodeIndex();
		index.replaceFile('src/HTTPRequestHandler.ts', 'export class HTTPRequestHandler {}');
		index.replaceFile('src/account_store.php', '<?php function load_user_account() {}');
		index.replaceFile('模型/用户服务.ts', 'export function 查找用户() { return "完成"; }');
		assert.deepStrictEqual([
			index.search('http request handler')[0]?.path,
			index.search('loadUserAccount')[0]?.path,
			index.search('查找用户')[0]?.path,
			index.search('用户服务')[0]?.path
		], ['src/HTTPRequestHandler.ts', 'src/account_store.php', '模型/用户服务.ts', '模型/用户服务.ts']);
	});

	test('attributes chunks to exact source lines and overlaps consecutive chunks', () => {
		const lines = Array.from({ length: 160 }, (_, index) => `const value${index + 1} = "line-${index + 1}";`);
		const index = new CodeIndex();
		index.replaceFile('src/source.ts', lines.join('\n'));
		const match = index.search('value125', { limit: 1 })[0];
		assert.ok(match && match.startLine <= 125 && match.endLine >= 125);
		assert.strictEqual(match.text, lines.slice(match.startLine - 1, match.endLine).join('\n') + (match.text.endsWith('\n') ? '\n' : ''));
		const broad = index.search('value', { limit: 8 });
		assert.ok(index.chunkCount >= 2 && broad.length >= 2);
		assert.ok(broad.every(result => result.endLine - result.startLine < 80 && result.text.length <= 3000));
	});

	test('keeps CRLF/CR line numbering and splits very long lines within the chunk bound', () => {
		const index = new CodeIndex();
		index.replaceFile('src/line-endings.php', 'first\r\nsecond\rthird\nfourthMarker');
		index.replaceFile('src/generated.ts', 'prefix '.repeat(500) + 'longLineNeedle ' + 'suffix '.repeat(500));
		const endings = index.search('fourthMarker')[0];
		const long = index.search('longLineNeedle')[0];
		assert.deepStrictEqual({ source: endings.text, start: endings.startLine, end: endings.endLine, long: { start: long.startLine, end: long.endLine, contains: long.text.includes('longLineNeedle'), bounded: long.text.length <= 3000 } }, {
			source: 'first\r\nsecond\rthird\nfourthMarker', start: 1, end: 4, long: { start: 1, end: 1, contains: true, bounded: true }
		});
	});

	test('caps result count and serialized output, including escaping and corrected truncated line ranges', () => {
		const index = new CodeIndex();
		for (let file = 0; file < 20; file++) { index.replaceFile(`file-${file}.ts`, Array.from({ length: 70 }, (_, line) => `const repeatedNeedle${line} = "\\escaped-${file}";`).join('\n')); }
		const normal = index.search('repeatedNeedle', { limit: 100, maxCharacters: 90000 });
		const small = index.search('repeatedNeedle', { limit: 8, maxCharacters: 500 });
		assert.ok(normal.length <= 8 && JSON.stringify(normal).length <= 12000);
		assert.ok(small.length > 0 && JSON.stringify(small).length <= 500);
		assert.strictEqual(small[0].endLine, small[0].startLine + small[0].text.split('\n').length - 1 - (small[0].text.endsWith('\n') ? 1 : 0));
		assert.deepStrictEqual([index.search('repeatedNeedle', { limit: 0 }), index.search('repeatedNeedle', { maxCharacters: 1 }), index.search('no_such_identifier')], [[], [], []]);
	});

	test('serializes deterministic independent records and restores equivalent rankings', () => {
		const index = new CodeIndex();
		index.replaceFile('z.php', '<?php function unrelatedThing() {}', 'z-1');
		index.replaceFile('a/UserService.php', '<?php class UserService { function createUser() {} }', 'a-1');
		const snapshot = index.serialize();
		const restored = CodeIndex.restore(JSON.parse(JSON.stringify(snapshot)));
		const before = index.search('create user');
		snapshot.files[0].content = 'changed outside the index';
		assert.deepStrictEqual({ paths: restored.listPaths(), fingerprint: restored.getFingerprint('a/UserService.php'), matches: restored.search('create user'), sourceMatches: index.search('create user') }, {
			paths: ['a/UserService.php', 'z.php'], fingerprint: 'a-1', matches: before, sourceMatches: before
		});
	});

	test('rejects malformed, duplicate, oversized and incompatible snapshots', () => {
		const malformed: unknown[] = [null, {}, { version: 2, files: [] }, { version: 1, files: {} }, { version: 1, files: [{ path: 'a.php', content: 4 }] }, { version: 1, files: [{ path: 'a.php', content: '', fingerprint: false }] }, { version: 1, files: [{ path: '', content: '' }] }, { version: 1, files: [{ path: 'a.php', content: '' }, { path: 'a.php', content: 'duplicate' }] }];
		for (const snapshot of malformed) { assert.throws(() => CodeIndex.restore(snapshot), /invalid-code-index/); }
		assert.throws(() => CodeIndex.restore({ version: 1, files: [{ path: 'a', content: 'too long' }] }, { maxFileCharacters: 3 }), /invalid-code-index/);
	});

	test('enforces admission limits atomically and allows a fitting replacement at capacity', () => {
		const index = new CodeIndex({ maxFiles: 1, maxChunks: 1, maxFileCharacters: 20, maxTotalCharacters: 20 });
		const first = index.replaceFile('one.ts', 'const oldName = 1;', 'one');
		const tooMany = index.replaceFile('two.ts', 'const x = 1;', 'two');
		const tooLarge = index.replaceFile('one.ts', 'x'.repeat(21), 'oversize');
		const oldFingerprint = index.getFingerprint('one.ts');
		const replacement = index.replaceFile('one.ts', 'const newName = 2;', 'new');
		assert.deepStrictEqual({ first, tooMany, tooLarge, oldFingerprint, replacement, count: index.fileCount, chunkCount: index.chunkCount, current: index.search('newName').length, stale: index.search('old').length }, { first: true, tooMany: false, tooLarge: false, oldFingerprint: 'one', replacement: true, count: 1, chunkCount: 1, current: 1, stale: 0 });
	});

	test('an empty file is discoverable by filename and deletions are reflected in persisted records', () => {
		const index = new CodeIndex();
		index.replaceFile('EmptyController.php', '', 'empty');
		assert.deepStrictEqual(index.search('EmptyController').map(match => ({ path: match.path, text: match.text, start: match.startLine, end: match.endLine })), [{ path: 'EmptyController.php', text: '', start: 1, end: 1 }]);
		index.removeFile('EmptyController.php');
		assert.deepStrictEqual(CodeIndex.restore(index.serialize()).serialize(), { version: 1, files: [] });
	});
});
