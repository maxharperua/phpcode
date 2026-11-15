/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { findFileReferences } from './fileReferences.js';

suite('phpcode chat file references', () => {
	test('detects Blade paths, directories, unicode names and line locations', () => {
		const text = 'packages/page/test-agent.blade.php, packages/page/partials/ README.md src/Тест.php:12:3 /workspaces/app/a.ts#L8C2';
		assert.deepStrictEqual(findFileReferences(text).map(({ path, line, column }) => ({ path, line, column })), [
			{ path: 'packages/page/test-agent.blade.php', line: undefined, column: undefined }, { path: 'packages/page/partials/', line: undefined, column: undefined }, { path: 'README.md', line: undefined, column: undefined }, { path: 'src/Тест.php', line: 12, column: 3 }, { path: '/workspaces/app/a.ts', line: 8, column: 2 }
		]);
	});
	test('does not turn URLs, email addresses, class names or version numbers into file references', () => {
		assert.deepStrictEqual(findFileReferences('https://example.com/src/a.php mail@example.com TestAgent::class 1.2.3'), []);
	});
});
