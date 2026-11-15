/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { resolveExecutionPolicy } from './executionPolicy.js';

suite('phpcode execution permissions', () => {
	test('keeps legacy automatic-edit sessions semi-automatic and manual sessions confirmed', () => {
		assert.deepStrictEqual([
			resolveExecutionPolicy({ mode: 'agent', applyMode: 'auto' }),
			resolveExecutionPolicy({ mode: 'agent' }),
			resolveExecutionPolicy({ mode: 'agent', applyMode: 'manual', terminalMode: 'auto' })
		], [{ id: 'semi', applyEdits: true, commands: 'confirm' }, { id: 'manual', applyEdits: false, commands: 'confirm' }, { id: 'manual', applyEdits: false, commands: 'confirm' }]);
	});
	test('executes without confirmation only when both automatic policies are selected', () => {
		assert.deepStrictEqual(resolveExecutionPolicy({ mode: 'agent', applyMode: 'auto', terminalMode: 'auto' }), { id: 'auto', applyEdits: true, commands: 'execute' });
	});
	test('Ask blocks commands even with stored automatic policies', () => {
		assert.deepStrictEqual(resolveExecutionPolicy({ mode: 'ask', applyMode: 'auto', terminalMode: 'auto' }), { id: 'ask', applyEdits: false, commands: 'blocked' });
	});
});
