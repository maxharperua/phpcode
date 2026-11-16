/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentEvent, AgentMessage, AgentRequest, AgentRequestError, AgentStreamChunk, AgentToolCall, AgentTransport, renderFilePage, runAgentTurn } from './runtime.js';

function textChunk(content: string, finishReason?: string): AgentStreamChunk {
	return { choices: [{ delta: { content }, finish_reason: finishReason }] };
}

function callChunk(index: number, id: string, name: string, args: string, finishReason?: string): AgentStreamChunk {
	return { choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: finishReason }] };
}

function transportFor(turns: AgentStreamChunk[][], requests: AgentRequest[] = []): AgentTransport {
	return async function* (request) {
		requests.push(request);
		const chunks = turns.shift();
		assert.ok(chunks, 'Unexpected extra provider request');
		for (const chunk of chunks) {
			yield chunk;
		}
	};
}

suite('phpcode agent runtime', () => {
	test('assembles fragmented parallel calls and retains a valid multi-step transcript', async () => {
		const requests: AgentRequest[] = [];
		const calls: AgentToolCall[] = [];
		const events: AgentEvent[] = [];
		const original: AgentMessage[] = [{ role: 'user', content: 'Inspect both files and propose a change' }];
		const result = await runAgentTurn({
			mode: 'agent', model: 'test', messages: original, signal: new AbortController().signal,
			transport: transportFor([
				[
					textChunk('Reading files.'),
					callChunk(1, 'call-b', 'read_', '{"path":"b'),
					callChunk(0, 'call-a', 'read_file', '{"path":"a.php"}'),
					callChunk(1, '', 'file', '.php"}', 'tool_calls')
				],
				[callChunk(0, 'proposal', 'propose_file', '{"path":"a.php","content":"<?php echo 1;"}', 'tool_calls')],
				[textChunk('The change is ready for review.', 'stop')]
			], requests),
			executeTool: async call => { calls.push(call); return call.name === 'read_file' ? 'original file' : 'staged, not applied'; },
			onEvent: event => events.push(event)
		});
		assert.deepStrictEqual({
			status: result.status,
			calls,
			roles: result.messages.map(message => message.role),
			firstResponseIds: requests[1].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
			lastTool: requests[2].messages.at(-1),
			original,
			statuses: events.filter(event => event.type === 'status')
		}, {
			status: 'completed',
			calls: [
				{ id: 'call-a', name: 'read_file', arguments: { path: 'a.php' } },
				{ id: 'call-b', name: 'read_file', arguments: { path: 'b.php' } },
				{ id: 'proposal', name: 'propose_file', arguments: { path: 'a.php', content: '<?php echo 1;' } }
			],
			roles: ['user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant'],
			firstResponseIds: ['call-a', 'call-b'],
			lastTool: { role: 'tool', tool_call_id: 'proposal', content: 'staged, not applied' },
			original: [{ role: 'user', content: 'Inspect both files and propose a change' }],
			statuses: [{ type: 'status', status: 'running' }, { type: 'status', status: 'completed' }]
		});
	});

	test('Ask mode refuses fabricated mutating calls and omits them from the provider tools', async () => {
		const requests: AgentRequest[] = [];
		const called: string[] = [];
		const result = await runAgentTurn({
			mode: 'ask', model: 'test', messages: [{ role: 'user', content: 'Explain the project' }], signal: new AbortController().signal,
			transport: transportFor([
				[callChunk(0, 'forbidden', 'run_terminal', '{"command":"touch should-not-exist"}', 'tool_calls')],
				[textChunk('I can explain without running commands.', 'stop')]
			], requests),
			executeTool: async call => { called.push(call.name); return 'unexpected'; }, onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, called, tools: requests[0].tools.map(tool => tool.function.name), refused: result.messages[2] }, {
			status: 'completed', called: [], tools: ['search_code', 'list_files', 'read_file', 'search_files'],
			refused: { role: 'tool', tool_call_id: 'forbidden', content: 'Tool unavailable in this mode. Continue using the permitted tools.' }
		});
	});

	test('rejects extra and non-string model arguments before host execution', async () => {
		const called: string[] = [];
		const result = await runAgentTurn({
			mode: 'agent', model: 'test', messages: [], signal: new AbortController().signal,
			transport: transportFor([
				[callChunk(0, 'bad', 'read_file', '{"path":32,"command":"ignored"}', 'tool_calls')],
				[textChunk('Correcting the request.', 'stop')]
			]),
			executeTool: async call => { called.push(call.name); return ''; }, onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, called, refusal: result.messages[1].content }, {
			status: 'completed', called: [], refusal: 'Invalid tool arguments. Supply exactly the required string fields.'
		});
	});

	test('does not execute incomplete streamed tool calls', async () => {
		let executions = 0;
		const result = await runAgentTurn({
			mode: 'agent', model: 'test', messages: [], signal: new AbortController().signal,
			transport: transportFor([[callChunk(0, 'incomplete', 'run_terminal', '{"command":"pwd"}')]]),
			executeTool: async () => { executions++; return ''; }, onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, error: result.error, executions, messages: result.messages }, { status: 'error', error: 'invalid-stream', executions: 0, messages: [] });
	});

	test('cancellation stops later tools and leaves paired responses for a subsequent turn', async () => {
		const controller = new AbortController();
		const called: string[] = [];
		const result = await runAgentTurn({
			mode: 'agent', model: 'test', messages: [], signal: controller.signal,
			transport: transportFor([[
				callChunk(0, 'first', 'read_file', '{"path":"first.php"}'),
				callChunk(1, 'second', 'run_terminal', '{"command":"pwd"}', 'tool_calls')
			]]),
			executeTool: async call => { called.push(call.name); controller.abort(); return 'partial'; }, onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, called, responseIds: result.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id) }, { status: 'cancelled', called: ['read_file'], responseIds: ['first', 'second'] });
	});

	test('a pre-cancelled turn never reaches transport', async () => {
		const controller = new AbortController();
		controller.abort();
		const requests: AgentRequest[] = [];
		const result = await runAgentTurn({ mode: 'ask', model: 'test', messages: [], signal: controller.signal, transport: transportFor([], requests), executeTool: async () => '', onEvent: () => { } });
		assert.deepStrictEqual({ status: result.status, requests }, { status: 'cancelled', requests: [] });
	});

	test('bounds context and preserves safe actionable provider error codes', async () => {
		const requests: AgentRequest[] = [];
		const context = await runAgentTurn({ mode: 'ask', model: 'test', messages: [{ role: 'user', content: 'x'.repeat(200_001) }], maxContextCharacters: 200000, signal: new AbortController().signal, transport: transportFor([], requests), executeTool: async () => '', onEvent: () => { } });
		const events: AgentEvent[] = [];
		const failed = await runAgentTurn({
			mode: 'ask', model: 'test', messages: [], signal: new AbortController().signal,
			transport: async function* () { throw new AgentRequestError('unauthorized'); },
			executeTool: async () => '', onEvent: event => events.push(event)
		});
		assert.deepStrictEqual({ context: { status: context.status, error: context.error }, requests, provider: { status: failed.status, error: failed.error }, events: events.filter(event => event.type === 'error') }, {
			context: { status: 'error', error: 'context-limit' }, requests: [], provider: { status: 'error', error: 'unauthorized' }, events: [{ type: 'error', code: 'unauthorized', message: 'unauthorized' }]
		});
	});

	test('caps tool loops and tool output', async () => {
		const result = await runAgentTurn({
			mode: 'ask', model: 'test', messages: [], signal: new AbortController().signal, maxSteps: 1,
			transport: transportFor([[callChunk(0, 'read', 'read_file', '{"path":"huge.php"}', 'tool_calls')]]),
			executeTool: async () => 'x'.repeat(50_000), onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, error: result.error, bounded: (result.messages[1].content?.length ?? 0) < 25_000, truncated: result.messages[1].content?.endsWith('[Tool output truncated. Request a narrower result.]') }, {
			status: 'error', error: 'step-limit', bounded: true, truncated: true
		});
	});
	test('prepares a reduced context before the hard limit and preserves it in the result', async () => {
		const original: AgentMessage[] = [{ role: 'user', content: 'x'.repeat(220000) }];
		const requests: AgentRequest[] = [];
		const result = await runAgentTurn({ mode: 'ask', model: 'test', messages: original, signal: new AbortController().signal,
			prepareMessages: async () => [{ role: 'user', content: 'Preserved goal and findings' }],
			transport: transportFor([[textChunk('Continue', 'stop')]], requests), executeTool: async () => '', onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, prompt: requests[0].messages[0].content, stored: result.messages[0].content, originalLength: original[0].content?.length }, { status: 'completed', prompt: 'Preserved goal and findings', stored: 'Preserved goal and findings', originalLength: 220000 });
	});

	test('a failed compaction preserves the original transcript and makes no normal provider request', async () => {
		const original: AgentMessage[] = [{ role: 'user', content: 'Preserve original request' }];
		let requests = 0;
		const result = await runAgentTurn({ mode: 'ask', model: 'test', messages: original, signal: new AbortController().signal,
			prepareMessages: async () => { throw new AgentRequestError('context-limit'); },
			transport: async function* () { requests++; yield textChunk('unexpected', 'stop'); }, executeTool: async () => '', onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, messages: result.messages, requests }, { status: 'error', messages: original, requests: 0 });
	});

	test('finishes a multi-file implementation after more than twenty tool rounds with a wide context', async () => {
		const turns: AgentStreamChunk[][] = [];
		for (let index = 0; index < 24; index++) { turns.push([callChunk(0, `read-${index}`, 'read_file', JSON.stringify({ path: `component-${index}.php` }), 'tool_calls')]); }
		turns.push([callChunk(0, 'write', 'propose_file', '{"path":"Copy.php","content":"<?php class Copy {}"}', 'tool_calls')], [textChunk('Copy implemented and verified.', 'stop')]);
		const changed: string[] = [];
		const result = await runAgentTurn({ mode: 'agent', model: 'wide', messages: [{ role: 'user', content: 'Copy the component. ' + 'context '.repeat(30000) }], signal: new AbortController().signal,
			transport: transportFor(turns), executeTool: async call => { if (call.name === 'propose_file') { changed.push(call.arguments.path!); } return 'unique ' + call.arguments.path; }, onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, changed, remaining: turns.length }, { status: 'completed', changed: ['Copy.php'], remaining: 0 });
	});

	test('recovers from repeated unchanged reads after compaction with actionable feedback', async () => {
		let requests = 0; let writes = 0; let compacted = false;
		const result = await runAgentTurn({ mode: 'agent', model: 'test', messages: [{ role: 'user', content: 'Implement a copy of the component' }], signal: new AbortController().signal,
			prepareMessages: async messages => { if (requests === 1) { compacted = true; return [{ role: 'user', content: 'Goal: implement a copy. Component.php already inspected.' }]; } return [...messages]; },
			transport: async function* (request) {
				requests++;
				if (writes) { yield textChunk('Implemented.', 'stop'); }
				else if (request.messages.at(-1)?.content?.includes('repeat unchanged observations')) { yield callChunk(0, 'edit', 'propose_file', '{"path":"Copy.php","content":"copy"}', 'tool_calls'); }
				else { yield callChunk(0, `r-${requests}`, 'read_file', '{"path":"Component.php"}', 'tool_calls'); }
			}, executeTool: async call => { if (call.name === 'propose_file') { writes++; } return 'unchanged code'; }, onEvent: () => { }
		});
		assert.deepStrictEqual({ status: result.status, compacted, writes, requests }, { status: 'completed', compacted: true, writes: 1, requests: 5 });
	});

	test('stops a model that ignores repeated-read feedback without blaming the network', async () => {
		let requests = 0;
		const result = await runAgentTurn({ mode: 'agent', model: 'test', messages: [], signal: new AbortController().signal,
			transport: async function* () { yield callChunk(0, `r-${++requests}`, 'read_file', '{"path":"same.php"}', 'tool_calls'); }, executeTool: async () => 'unchanged', onEvent: () => { }
		});
		assert.deepStrictEqual({ error: result.error, requests }, { error: 'repeated-tools', requests: 7 });
	});

	test('pages long files and validates ranges instead of silently returning the same prefix', () => {
		const source = Array.from({ length: 450 }, (_, index) => `line-${index + 1}`).join('\n');
		const first = renderFilePage(source, 'Component.php');
		const next = renderFilePage(source, 'Component.php', '201', '400');
		assert.ok(first.includes('Lines 1-200 of 450') && first.includes('start_line="201"') && next.includes('line-400') && !next.includes('\nline-1\n'));
		assert.match(renderFilePage(source, 'Component.php', 'no'), /positive/);
	});

	test('delegates concurrently with isolated histories and returns only final reports to parent', async () => {
		const events: AgentEvent[] = []; const requests: AgentRequest[] = [];
		let started = 0; let release!: () => void;
		const bothStarted = new Promise<void>(resolve => { release = resolve; });
		const transport: AgentTransport = async function* (request) {
			requests.push(request);
			const child = request.messages[0]?.content?.includes('PHPCODE_SUBAGENT');
			if (child) {
				assert.equal(JSON.stringify(request.messages).includes('PRIVATE_PARENT_HISTORY'), false);
				assert.equal(request.tools.some(tool => ['run_subagent', 'propose_file', 'run_terminal'].includes(tool.function.name)), false);
				if (!request.messages.some(message => message.role === 'tool')) {
					if (++started === 2) { release(); } await bothStarted;
					yield callChunk(0, 'read', 'read_file', '{"path":"a.php"}', 'tool_calls');
				} else { yield textChunk('Report ' + request.messages.find(message => message.role === 'user')!.content, 'stop'); }
			} else if (!request.messages.some(message => message.role === 'tool')) {
				yield callChunk(0, 'a', 'run_subagent', '{"description":"A","prompt":"find A","subagent_type":"explore"}');
				yield callChunk(1, 'b', 'run_subagent', '{"description":"B","prompt":"find B","subagent_type":"explore"}', 'tool_calls');
			} else {
				assert.equal(JSON.stringify(request.messages).includes('CHILD_LARGE_INTERMEDIATE'), false);
				assert.deepStrictEqual(request.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['a', 'b']);
				yield textChunk('Combined result', 'stop');
			}
		};
		const result = await runAgentTurn({ mode: 'agent', model: 'bothub-test', messages: [{ role: 'system', content: 'Host instructions' }, { role: 'user', content: 'PRIVATE_PARENT_HISTORY' }], signal: new AbortController().signal, transport,
			executeTool: async (_call, _signal, agent) => { assert.ok(agent); return 'CHILD_LARGE_INTERMEDIATE'; }, onEvent: event => events.push(event) });
		assert.equal(result.status, 'completed'); assert.equal(started, 2);
		assert.equal(events.filter(event => event.type === 'subagent-end' && event.status === 'completed').length, 2);
		assert.ok(events.filter(event => event.type === 'subagent-start').every(event => event.agent.model === 'bothub-test'));
		assert.equal(JSON.stringify(result.messages).includes('CHILD_LARGE_INTERMEDIATE'), false);
	});

	test('bounds child concurrency and total launches without host calls', async () => {
		let active = 0; let peak = 0; let children = 0; let wake!: () => void;
		const firstThree = new Promise<void>(resolve => { wake = resolve; });
		const transport: AgentTransport = async function* (request) {
			if (request.messages[0]?.content?.includes('PHPCODE_SUBAGENT')) {
				children++; active++; peak = Math.max(peak, active); if (children === 3) { wake(); }
				await firstThree; active--; yield textChunk('Done', 'stop');
			} else if (!request.messages.some(message => message.role === 'tool')) {
				for (let index = 0; index < 10; index++) {
					yield callChunk(index, 'child-' + index, 'run_subagent', JSON.stringify({ description: 'Task ' + index, prompt: 'Research', subagent_type: 'explore' }), index === 9 ? 'tool_calls' : undefined);
				}
			} else { yield textChunk('Done', 'stop'); }
		};
		const result = await runAgentTurn({ mode: 'agent', model: 'test', messages: [{ role: 'user', content: 'delegate' }], signal: new AbortController().signal, transport, executeTool: async () => { throw new Error('Unexpected host call'); }, onEvent: () => {} });
		assert.equal(peak, 3); assert.equal(children, 8); assert.equal(result.status, 'completed');
		assert.equal(result.messages.filter(message => message.role === 'tool' && message.content?.includes('limit reached')).length, 2);
	});

	test('parent stop cancels every active child and preserves paired parent tool responses', async () => {
		const controller = new AbortController(); let children = 0; const events: AgentEvent[] = [];
		const transport: AgentTransport = async function* (request, signal) {
			if (request.messages[0]?.content?.includes('PHPCODE_SUBAGENT')) {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
					if (++children === 2) { controller.abort(); }
				});
			} else {
				yield callChunk(0, 'a', 'run_subagent', '{"description":"A","prompt":"Work","subagent_type":"explore"}');
				yield callChunk(1, 'b', 'run_subagent', '{"description":"B","prompt":"Work","subagent_type":"general"}', 'tool_calls');
			}
		};
		const result = await runAgentTurn({ mode: 'agent', model: 'test', messages: [{ role: 'user', content: 'run' }], signal: controller.signal, transport, executeTool: async () => 'unexpected', onEvent: event => events.push(event) });
		assert.equal(result.status, 'cancelled'); assert.equal(children, 2);
		assert.equal(events.filter(event => event.type === 'subagent-end' && event.status === 'cancelled').length, 2);
		assert.deepStrictEqual(result.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id).sort(), ['a', 'b']);
	});

	test('child restrictions are enforced against fabricated writes, commands, and nested delegation', async () => {
		const names = ['propose_file', 'run_terminal', 'run_subagent']; let calls = 0;
		const result = await runAgentTurn({ mode: 'agent', model: 'test', subagent: { id: 'child', name: 'Explore', type: 'explore', model: 'test' }, messages: [{ role: 'user', content: 'inspect' }], signal: new AbortController().signal,
			transport: transportFor([[...names.map((name, index) => callChunk(index, name, name, '{}', index === 2 ? 'tool_calls' : undefined))], [textChunk('Cannot mutate', 'stop')]]),
			executeTool: async () => { calls++; return 'bad'; }, onEvent: () => {} });
		assert.equal(result.status, 'completed'); assert.equal(calls, 0);
		assert.equal(result.messages.filter(message => message.role === 'tool' && message.content?.startsWith('Tool unavailable')).length, 3);
	});

	test('child provider failure returns an explicit failed result without ending the parent', async () => {
		const events: AgentEvent[] = [];
		const result = await runAgentTurn({ mode: 'agent', model: 'test', messages: [{ role: 'user', content: 'run' }], signal: new AbortController().signal,
			transport: async function* (request) {
				if (request.messages[0]?.content?.includes('PHPCODE_SUBAGENT')) { throw new AgentRequestError('rate-limit'); }
				if (!request.messages.some(message => message.role === 'tool')) { yield callChunk(0, 'child', 'run_subagent', '{"description":"Fail","prompt":"Work","subagent_type":"general"}', 'tool_calls'); }
				else { assert.match(request.messages.at(-1)!.content!, /error \(rate-limit\)/); yield textChunk('I will continue myself', 'stop'); }
			}, executeTool: async () => 'unexpected', onEvent: event => events.push(event) });
		assert.equal(result.status, 'completed');
		assert.ok(events.some(event => event.type === 'subagent-end' && event.status === 'error'));
	});

});
