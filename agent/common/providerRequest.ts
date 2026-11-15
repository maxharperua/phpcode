/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentMessage, AgentRequest, AgentToolDefinition } from './runtime.js';

export interface ProviderTextPart {
	type: 'text';
	text: string;
	cache_control: { type: 'ephemeral' };
}

export interface ProviderMessage extends Omit<AgentMessage, 'content'> {
	content: string | null | ProviderTextPart[];
}

export interface ProviderRequest {
	model: string;
	messages: ProviderMessage[];
	tools: AgentToolDefinition[];
	stream: true;
	stream_options: { include_usage: true };
}

/** Counts are present only when the provider explicitly reports valid integers. */
export interface ProviderUsage {
	inputTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
}

function copyTool(tool: AgentToolDefinition): AgentToolDefinition {
	return {
		...tool,
		function: {
			...tool.function,
			parameters: {
				...tool.function.parameters,
				properties: Object.fromEntries(Object.entries(tool.function.parameters.properties).map(([name, value]) => [name, { ...value }])),
				required: [...tool.function.parameters.required]
			}
		}
	};
}

/** Add BotHub's explicit Claude breakpoints while leaving automatic caching to other providers. */
export function buildProviderRequest(request: AgentRequest, cache: 'auto' | 'off'): ProviderRequest {
	const useBreakpoints = cache === 'auto' && /(?:^|\/)claude(?:-|$)/i.test(request.model.trim());
	const systemIndex = useBreakpoints ? request.messages.findIndex(message => message.role === 'system' && !!message.content?.trim()) : -1;
	const userIndex = useBreakpoints ? request.messages.findLastIndex(message => message.role === 'user' && !!message.content?.trim()) : -1;
	const messages: ProviderMessage[] = request.messages.map((message, index) => ({
		...message,
		content: (index === systemIndex || index === userIndex) && typeof message.content === 'string'
			? [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }]
			: message.content,
		...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })) } : {})
	}));
	return {
		model: request.model,
		messages,
		tools: request.tools.map(copyTool),
		stream: true,
		stream_options: { include_usage: true }
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Decode usage-only streaming chunks without inventing missing counts or prices. */
export function extractProviderUsage(chunk: unknown): ProviderUsage | undefined {
	const usage = record(record(chunk)?.usage);
	if (!usage) {
		return undefined;
	}
	const details = record(usage.prompt_tokens_details) ?? record(usage.input_tokens_details);
	const values: ProviderUsage = {
		inputTokens: tokenCount(usage.prompt_tokens) ?? tokenCount(usage.input_tokens),
		outputTokens: tokenCount(usage.completion_tokens) ?? tokenCount(usage.output_tokens),
		cachedTokens: tokenCount(details?.cached_tokens),
		cacheWriteTokens: tokenCount(details?.cache_write_tokens),
		totalTokens: tokenCount(usage.total_tokens)
	};
	const reported = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
	return Object.keys(reported).length ? reported : undefined;
}
