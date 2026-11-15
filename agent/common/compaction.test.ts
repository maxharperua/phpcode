/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentMessage } from './runtime.js';
import { applyCompaction, estimateContextTokens, planCompaction, renderCompactionInput, resolveContextBudget } from './compaction.js';

suite('phpcode automatic chat compaction', () => {
	test('uses provider windows with output reserve, manual caps and an explicit unknown-model fallback', () => {
		assert.deepStrictEqual([resolveContextBudget(128000), resolveContextBudget(1000000), resolveContextBudget(128000, 8000), resolveContextBudget(128000, 1000000), resolveContextBudget(undefined), resolveContextBudget(undefined, 256000)], [115200, 983616, 8000, 115200, 128000, 256000]);
	});
	test('does not compact a 60k context at the former hardcoded 48k ceiling for a wide model', () => {
		const messages: AgentMessage[] = [{ role: 'user', content: 'Implement the task' }, { role: 'assistant', content: 'evidence '.repeat(20000) }];
		assert.equal(planCompaction(messages, resolveContextBudget(256000)), undefined);
	});
	test('leaves a small conversation unchanged', () => {
		assert.equal(planCompaction([{ role: 'user', content: 'hello' }], 32000), undefined);
	});
	test('preserves latest task and complete tool pairs while summarizing old turns', () => {
		const messages: AgentMessage[] = [{ role: 'system', content: 'Stable policy' }, { role: 'user', content: 'Original goal' }, { role: 'assistant', content: 'old context '.repeat(3000) }, { role: 'user', content: 'Current task' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.php"}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'current code' }];
		const plan = planCompaction(messages, 8000)!;
		assert.ok(plan);
		const result = applyCompaction(plan, 'Original goal and findings.');
		assert.deepStrictEqual({ first: result[0], last: result.slice(-3), roles: result.map(message => message.role), sourceLength: messages.length }, { first: messages[0], last: messages.slice(-3), roles: ['system', 'user', 'user', 'assistant', 'tool'], sourceLength: 6 });
	});
	test('compacts within a long tool loop without orphaning results', () => {
		const messages: AgentMessage[] = [{ role: 'user', content: 'Keep this request' }];
		for (let index = 0; index < 8; index++) { messages.push({ role: 'assistant', content: null, tool_calls: [{ id: String(index), type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: String(index), content: 'x'.repeat(3000) }); }
		const plan = planCompaction(messages, 8000)!;
		assert.ok(plan && plan.prefix.length && plan.tail[0].content === 'Keep this request');
		const result = applyCompaction(plan, 'Earlier reads summarized');
		const callIds = new Set(result.flatMap(message => message.tool_calls?.map(call => call.id) || []));
		assert.ok(result.filter(message => message.role === 'tool').every(message => callIds.has(message.tool_call_id!)));
		assert.ok(estimateContextTokens(result) < estimateContextTokens(messages));
	});
	test('refuses incomplete or orphaned tool protocol', () => {
		const call: AgentMessage = { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
		assert.deepStrictEqual([planCompaction([{ role: 'user', content: 'x'.repeat(30000) }, call], 8000), planCompaction([{ role: 'tool', tool_call_id: 'a', content: 'x'.repeat(30000) }], 8000)], [undefined, undefined]);
	});
	test('does not silently summarize away a single oversized user request', () => {
		assert.equal(planCompaction([{ role: 'user', content: 'important '.repeat(10000) }], 8000), undefined);
	});
	test('bounds summary input and replaces full file payloads with metadata', () => {
		const source: AgentMessage[] = [{ role: 'user', content: 'Original goal' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'propose_file', arguments: JSON.stringify({ path: 'a.php', content: 'PRIVATE_CODE'.repeat(10000) }) } }] }, { role: 'tool', content: 'output '.repeat(10000), tool_call_id: 'a' }];
		const text = renderCompactionInput(source, 5000);
		assert.ok(text.length <= 5000 && text.includes('Original goal') && text.includes('a.php'));
		assert.doesNotMatch(text, /PRIVATE_CODE/);
	});
	test('keeps multilingual summary input inside the UTF8 byte budget', () => {
		const messages: AgentMessage[] = [{ role: 'user', content: 'Сохранить исходную цель: ' + 'важные сведения '.repeat(1000) }, { role: 'assistant', content: '结论与上下文'.repeat(2000) }, { role: 'user', content: 'recent emoji 🧑‍💻'.repeat(1000) }];
		const text = renderCompactionInput(messages, 5000);
		assert.ok(new TextEncoder().encode(text).byteLength <= 5000 && text.includes('Сохранить исходную цель'));
	});

	test('can summarize one oversized completed tool exchange and keep the user goal', () => {
		const messages: AgentMessage[] = [{ role: 'user', content: 'Inspect file and continue' }, { role: 'assistant', content: null, tool_calls: [{ id: 'large', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'large', content: 'code '.repeat(8000) }];
		const plan = planCompaction(messages, 8000)!;
		assert.ok(plan && plan.prefix.length === 2);
		assert.deepStrictEqual(plan.tail, [messages[0]]);
	});

});
