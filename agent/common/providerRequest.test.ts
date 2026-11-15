/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildProviderRequest, extractProviderUsage } from './providerRequest.js';
import { AgentRequest } from './runtime.js';

function request(model = 'claude-sonnet-4-5'): AgentRequest {
	return {
		model,
		messages: [
			{ role: 'system', content: 'Stable instructions' },
			{ role: 'user', content: 'Earlier user request' },
			{ role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.php"}' } }] },
			{ role: 'tool', content: 'file contents', tool_call_id: 'read-1' },
			{ role: 'user', content: 'Latest user request' },
			{ role: 'assistant', content: 'Planning the next step' },
			{ role: 'user', content: '   ' }
		],
		tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a project file', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path' } }, required: ['path'], additionalProperties: false } } }]
	};
}

suite('phpcode provider request', () => {
	test('Claude marks only the first nonempty system and latest nonempty user with default TTL', () => {
		const source = request();
		const snapshot = JSON.stringify(source);
		const built = buildProviderRequest(source, 'auto');
		assert.deepStrictEqual({ source: JSON.stringify(source), built }, {
			source: snapshot,
			built: {
				...source,
				messages: source.messages.map((message, index) => index === 0 || index === 4 ? { ...message, content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }] } : message),
				stream: true,
				stream_options: { include_usage: true }
			}
		});
	});

	test('recognizes normalized Claude identifiers without matching unrelated model names', () => {
		const models = ['claude-sonnet-4-5', 'anthropic/claude-3-7-sonnet', 'Anthropic/CLAUDE-OPUS-4', 'vendor/anthropic/claude', ' claude-sonnet-4 ', 'gpt-4.1', 'grok-4', 'deepseek-chat', 'notclaude-sonnet', 'vendor/claudeish-model', 'anthropic/other-model'];
		assert.deepStrictEqual(models.map(model => Array.isArray(buildProviderRequest(request(model), 'auto').messages[0].content)), [true, true, true, true, true, false, false, false, false, false, false]);
	});

	test('off omits explicit cache markers for every model while requesting streamed usage', () => {
		assert.deepStrictEqual(['claude-sonnet-4', 'anthropic/claude-opus-4', 'gpt-4.1', 'deepseek-chat'].map(model => {
			const source = request(model);
			const built = buildProviderRequest(source, 'off');
			return { messages: built.messages, expectedMessages: source.messages, stream: built.stream, usage: built.stream_options };
		}).every(value => JSON.stringify(value.messages) === JSON.stringify(value.expectedMessages) && value.stream && value.usage.include_usage), true);
	});

	test('automatic-cache models preserve string content and all tool payloads', () => {
		const source = request('gpt-4.1');
		const built = buildProviderRequest(source, 'auto');
		assert.deepStrictEqual({ model: built.model, messages: built.messages, tools: built.tools }, source);
		// A consumer of the wire object must not modify conversation history or tool schemas.
		built.messages[2].tool_calls![0].function.arguments = '{}';
		built.tools[0].function.parameters.properties.path.description = 'Changed';
		assert.deepStrictEqual({ arguments: source.messages[2].tool_calls![0].function.arguments, description: source.tools[0].function.parameters.properties.path.description }, { arguments: '{"path":"index.php"}', description: 'Relative path' });
	});

	test('does not mark additional system messages, assistants, tools, empty content or null', () => {
		const source = request();
		source.messages.unshift({ role: 'system', content: ' ' });
		source.messages.push({ role: 'system', content: 'Additional system note' }, { role: 'tool', content: 'Latest tool output', tool_call_id: 'last' }, { role: 'user', content: null });
		const built = buildProviderRequest(source, 'auto');
		assert.deepStrictEqual(built.messages.flatMap((message, index) => Array.isArray(message.content) ? [index] : []), [1, 5]);
	});

	test('returns an empty message list unchanged without inventing breakpoints', () => {
		assert.deepStrictEqual(buildProviderRequest({ model: 'claude-sonnet-4', messages: [], tools: [] }, 'auto'), { model: 'claude-sonnet-4', messages: [], tools: [], stream: true, stream_options: { include_usage: true } });
	});
});

suite('phpcode provider usage', () => {
	test('reads reported Chat Completions counts including cache reads and writes', () => {
		assert.deepStrictEqual(extractProviderUsage({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 100 } } }), { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cachedTokens: 1024, cacheWriteTokens: 100 });
	});

	test('supports reported Responses counters and retains unknown fields as absent', () => {
		assert.deepStrictEqual([
			extractProviderUsage({ usage: { input_tokens: 900, output_tokens: 20, input_tokens_details: { cached_tokens: 800 } } }),
			extractProviderUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }),
			extractProviderUsage({ usage: { prompt_tokens: 100, completion_tokens: 20 } })
		], [
			{ inputTokens: 900, outputTokens: 20, cachedTokens: 800 },
			{ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
			{ inputTokens: 100, outputTokens: 20 }
		]);
	});

	test('ignores malformed, negative, fractional, infinite and unsafe counts without estimating values', () => {
		assert.deepStrictEqual([
			extractProviderUsage(undefined), extractProviderUsage({}), extractProviderUsage({ usage: null }), extractProviderUsage({ usage: [] }),
			extractProviderUsage({ usage: { prompt_tokens: '12', completion_tokens: -1, total_tokens: Infinity, prompt_tokens_details: { cached_tokens: 1.5, cache_write_tokens: Number.MAX_SAFE_INTEGER + 1 } } }),
			extractProviderUsage({ usage: { prompt_tokens: NaN, completion_tokens: 4, total_tokens: false, prompt_tokens_details: { cached_tokens: -2, cache_write_tokens: 3 } } })
		], [undefined, undefined, undefined, undefined, undefined, { outputTokens: 4, cacheWriteTokens: 3 }]);
	});

	test('does not mutate a usage-only streaming chunk', () => {
		const chunk = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } } };
		const snapshot = JSON.stringify(chunk);
		extractProviderUsage(chunk);
		assert.strictEqual(JSON.stringify(chunk), snapshot);
	});
});
