/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** OpenAI-compatible messages retained separately for each phpcode conversation. */
export interface AgentMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_call_id?: string;
	tool_calls?: AgentWireToolCall[];
}

export interface AgentWireToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface AgentToolArguments {
	path?: string;
	content?: string;
	query?: string;
	command?: string;
	start_line?: string;
	end_line?: string;
}

export interface AgentToolCall {
	id: string;
	name: string;
	arguments: AgentToolArguments;
}

export interface AgentToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, { type: 'string'; description?: string }>;
			required: string[];
			additionalProperties: false;
		};
	};
}

/** Streaming wire shape, including fragmented function arguments and names. */
export interface AgentStreamChunk {
	choices: {
		delta: {
			content?: string | null;
			tool_calls?: {
				index: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}[];
		};
		finish_reason?: string | null;
	}[];
}

export interface AgentRequest {
	model: string;
	messages: AgentMessage[];
	tools: AgentToolDefinition[];
}

export type AgentTransport = (request: AgentRequest, signal: AbortSignal) => AsyncIterable<AgentStreamChunk>;
export type AgentStatus = 'running' | 'completed' | 'cancelled' | 'error';
export type AgentErrorCode = 'unauthorized' | 'rate-limit' | 'invalid-model' | 'network' | 'provider-error' | 'context-limit' | 'output-limit' | 'step-limit' | 'repeated-tools' | 'invalid-stream';

/** Transport errors have fixed codes so HTTP response bodies and credentials never enter history. */
export class AgentRequestError extends Error {
	constructor(readonly code: AgentErrorCode) {
		super(code);
		this.name = 'AgentRequestError';
	}
}

export type AgentEvent =
	| { type: 'text'; text: string }
	| { type: 'tool-start'; call: AgentToolCall }
	| { type: 'tool-end'; call: AgentToolCall; result: string }
	| { type: 'status'; status: AgentStatus }
	| { type: 'error'; code: AgentErrorCode; message: string };

export interface AgentTurnOptions {
	mode: 'ask' | 'agent';
	model: string;
	messages: readonly AgentMessage[];
	signal: AbortSignal;
	transport: AgentTransport;
	/** The host enforces workspace boundaries, enforces the selected edit and command confirmation policies. */
	executeTool: (call: AgentToolCall, signal: AbortSignal) => Promise<string>;
	onEvent: (event: AgentEvent) => void;
	maxSteps?: number;
	maxContextCharacters?: number;
	prepareMessages?: (messages: readonly AgentMessage[], signal: AbortSignal) => Promise<AgentMessage[]>;
}

export interface AgentTurnResult {
	messages: AgentMessage[];
	status: Exclude<AgentStatus, 'running'>;
	error?: AgentErrorCode;
}

const MAX_CONTEXT_CHARACTERS = 8_000_000;
const MAX_OUTPUT_CHARACTERS = 64_000;
const MAX_ARGUMENT_CHARACTERS = 256_000;
const MAX_TOOL_RESULT_CHARACTERS = 24_000;
const MAX_CALLS_PER_STEP = 16;

/** Page large files explicitly so repeated reads do not silently return the same truncated prefix. */
export function renderFilePage(text: string, path: string, startLine?: string, endLine?: string): string {
	if ([startLine, endLine].some(value => value !== undefined && !/^[1-9]\d{0,6}$/.test(value))) { return 'Provide start_line/end_line as positive 1-based integer strings.'; }
	const lines = text.split('\n');
	const start = Number(startLine || 1);
	const end = Math.min(lines.length, Number(endLine || start + 199), start + 199);
	if (start > lines.length || end < start) { return `Invalid line range. ${path} has ${lines.length} lines.`; }
	if (!startLine && !endLine && lines.length <= 200 && text.length <= 20000) { return text; }
	const selected: string[] = []; let length = 0;
	for (let index = start - 1; index < end; index++) {
		const line = lines[index];
		if (selected.length && length + line.length + 1 > 20000) { break; }
		selected.push(line.slice(0, 20000)); length += selected[selected.length - 1].length + 1;
		if (line.length > 20000) { return `${path}:${index + 1} is longer than the tool output limit. Only its first 20000 characters follow; this is NOT the complete file.\n${selected.join('\n')}`; }
	}
	const last = start + selected.length - 1;
	return `File: ${path}. Lines ${start}-${last} of ${lines.length}.\n${selected.join('\n')}\n${last < lines.length ? `[More code available. Read start_line="${last + 1}" end_line="${Math.min(last + 200, lines.length)}" if needed. Do not repeat the first page.]` : '[End of file.]'}`;
}

function tool(name: string, description: string, properties: Record<string, { type: 'string'; description?: string }>, required: string[]): AgentToolDefinition {
	return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

const readTools: AgentToolDefinition[] = [
	tool('search_code', 'Find relevant code snippets using the local project index. Start discovery here before reading whole files. Results include file paths and line ranges; use search_files or list_files if there are no indexed matches.', { query: { type: 'string' } }, ['query']),
	tool('list_files', 'List files in a workspace directory. All paths are relative to the project root.', { path: { type: 'string' } }, ['path']),
	tool('read_file', 'Read a UTF-8 project file. Large files return a bounded page with the next line range. Use start_line and end_line (1-based integer strings) for missing code. Do not repeatedly request the first page.', { path: { type: 'string' }, start_line: { type: 'string' }, end_line: { type: 'string' } }, ['path']),
	tool('search_files', 'Search text in project files using a literal query.', { query: { type: 'string' }, path: { type: 'string', description: 'Optional directory relative to project root.' } }, ['query'])
];
const agentTools: AgentToolDefinition[] = [
	...readTools,
	tool('propose_file', 'Propose complete UTF-8 file contents. The host stages or applies the change according to the user-selected edit policy and reports the actual state.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
	tool('run_terminal', 'Execute a shell command in the project root using a fresh shell. The host follows the selected manual, semi-automatic or fully automatic confirmation policy. Output appears in the shared Agent Commands panel.', { command: { type: 'string' } }, ['command'])
];

function copyMessage(message: AgentMessage): AgentMessage {
	return { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })) } : {}) };
}

function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

function checkContext(messages: readonly AgentMessage[], maxCharacters: number): void {
	let characters = 0;
	for (const message of messages) {
		characters += message.content?.length ?? 0;
		for (const call of message.tool_calls ?? []) {
			characters += call.function.arguments.length + call.function.name.length;
		}
		if (characters > maxCharacters) {
			throw new AgentRequestError('context-limit');
		}
	}
	if (messages.length > 4000) {
		throw new AgentRequestError('context-limit');
	}
}

/** Validate untrusted model arguments before handing them to the host. */
function decodeArguments(call: AgentWireToolCall, definition: AgentToolDefinition): AgentToolArguments | undefined {
	let parsed: Record<string, string>;
	try {
		const value: unknown = JSON.parse(call.function.arguments);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return undefined;
		}
		parsed = value as Record<string, string>;
	} catch {
		return undefined;
	}
	const parameters = definition.function.parameters;
	if (Object.keys(parsed).some(key => !Object.hasOwn(parameters.properties, key) || typeof parsed[key] !== 'string')) {
		return undefined;
	}
	if (parameters.required.some(key => typeof parsed[key] !== 'string')) {
		return undefined;
	}
	return parsed;
}

/** Run one turn; streamed tool calls are assembled fully before any host action. */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
	const messages = options.messages.map(copyMessage);
	const definitions = (options.mode === 'ask' ? readTools : agentTools).map(definition => ({ ...definition, function: { ...definition.function, parameters: { ...definition.function.parameters, properties: { ...definition.function.parameters.properties }, required: [...definition.function.parameters.required] } } }));
	const maxSteps = Math.max(1, Math.min(500, Math.floor(options.maxSteps ?? 100)));
	const observations = new Map<string, string>();
	let unchangedSteps = 0;
	let outputCharacters = 0;
	options.onEvent({ type: 'status', status: 'running' });
	try {
		for (let step = 0; step < maxSteps; step++) {
			checkAbort(options.signal);
			if (options.prepareMessages) {
				const prepared = await options.prepareMessages(messages.map(copyMessage), options.signal);
				checkAbort(options.signal);
				messages.splice(0, messages.length, ...prepared);
			}
			checkContext(messages, options.maxContextCharacters ?? MAX_CONTEXT_CHARACTERS);
			let content = '';
			const pendingCalls = new Map<number, AgentWireToolCall>();
			let finishReason: string | null | undefined;
			let receivedChunk = false;
			try {
				for await (const chunk of options.transport({ model: options.model, messages: messages.map(copyMessage), tools: definitions }, options.signal)) {
					checkAbort(options.signal);
					const choice = chunk.choices[0];
					if (!choice) {
						continue;
					}
					receivedChunk = true;
					if (choice.finish_reason) {
						finishReason = choice.finish_reason;
					}
					if (choice.delta.content) {
						outputCharacters += choice.delta.content.length;
						if (outputCharacters > MAX_OUTPUT_CHARACTERS) {
							throw new AgentRequestError('output-limit');
						}
						content += choice.delta.content;
						options.onEvent({ type: 'text', text: choice.delta.content });
					}
					for (const delta of choice.delta.tool_calls ?? []) {
						if (!Number.isSafeInteger(delta.index) || delta.index < 0 || delta.index >= MAX_CALLS_PER_STEP || (delta.type && delta.type !== 'function')) {
							throw new AgentRequestError('invalid-stream');
						}
						let call = pendingCalls.get(delta.index);
						if (!call) {
							call = { id: '', type: 'function', function: { name: '', arguments: '' } };
							pendingCalls.set(delta.index, call);
						}
						call.id += delta.id ?? '';
						call.function.name += delta.function?.name ?? '';
						call.function.arguments += delta.function?.arguments ?? '';
						if (call.function.arguments.length > MAX_ARGUMENT_CHARACTERS || call.id.length > 256 || call.function.name.length > 128) {
							throw new AgentRequestError('output-limit');
						}
					}
				}
			} catch (error) {
				// Keep visible partial text, but never persist an incomplete tool request.
				if (content) {
					messages.push({ role: 'assistant', content });
				}
				throw error;
			}
			if (options.signal.aborted && content) {
				messages.push({ role: 'assistant', content });
			}
			checkAbort(options.signal);
			if (!receivedChunk || !finishReason || finishReason === 'length' || finishReason === 'content_filter') {
				if (content) {
					messages.push({ role: 'assistant', content });
				}
				throw new AgentRequestError(finishReason === 'length' ? 'output-limit' : 'invalid-stream');
			}
			const calls = [...pendingCalls].sort(([left], [right]) => left - right).map(([, call]) => call);
			if (calls.some(call => !call.id || !call.function.name) || new Set(calls.map(call => call.id)).size !== calls.length) {
				throw new AgentRequestError('invalid-stream');
			}
			messages.push({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
			if (!calls.length) {
				options.onEvent({ type: 'status', status: 'completed' });
				return { messages, status: 'completed' };
			}
			let newInformation = false;
			for (const wireCall of calls) {
				checkAbort(options.signal);
				const definition = definitions.find(candidate => candidate.function.name === wireCall.function.name);
				const args = definition ? decodeArguments(wireCall, definition) : undefined;
				let result: string;
				if (!definition) {
					result = 'Tool unavailable in this mode. Continue using the permitted tools.';
				} else if (!args) {
					result = 'Invalid tool arguments. Supply exactly the required string fields.';
				} else {
					const call = { id: wireCall.id, name: wireCall.function.name, arguments: args };
					options.onEvent({ type: 'tool-start', call });
					try {
						result = await options.executeTool(call, options.signal);
						checkAbort(options.signal);
					} catch {
						checkAbort(options.signal);
						result = 'Tool failed. Check the workspace path, permissions, or terminal output before retrying.';
					}
					if (result.length > MAX_TOOL_RESULT_CHARACTERS) {
						result = result.slice(0, MAX_TOOL_RESULT_CHARACTERS) + '\n[Tool output truncated. Request a narrower result.]';
					}
					if (readTools.some(tool => tool.function.name === call.name)) {
						const signature = call.name + JSON.stringify(Object.entries(args!).sort(([a], [b]) => a.localeCompare(b)));
						if (observations.get(signature) !== result) { newInformation = true; }
						observations.delete(signature); observations.set(signature, result);
						if (observations.size > 256) { observations.delete(observations.keys().next().value!); }
					} else { observations.clear(); newInformation = true; }
					options.onEvent({ type: 'tool-end', call, result });
				}
				messages.push({ role: 'tool', tool_call_id: wireCall.id, content: result });
			}
			unchangedSteps = newInformation ? 0 : unchangedSteps + 1;
			if (unchangedSteps >= 2) {
				messages[messages.length - 1].content += '\n[Agent runtime: these tool calls repeat unchanged observations. Continue the original task using the code already obtained. Implement the requested change now if sufficient; otherwise request a specific missing line range or explain the exact blocker. Do not restart discovery after a summary.]';
			}
			if (unchangedSteps >= 6) { throw new AgentRequestError('repeated-tools'); }
		}
		throw new AgentRequestError('step-limit');
	} catch (error) {
		// Every assistant tool call must have a response before the transcript can be reused.
		const lastAssistant = messages.findLastIndex(message => message.role === 'assistant' && !!message.tool_calls?.length);
		if (lastAssistant >= 0) {
			const responses = new Set(messages.slice(lastAssistant + 1).map(message => message.tool_call_id));
			for (const call of messages[lastAssistant].tool_calls ?? []) {
				if (!responses.has(call.id)) {
					messages.push({ role: 'tool', tool_call_id: call.id, content: 'The turn stopped before this tool completed. Its result is unknown; inspect current workspace state before retrying.' });
				}
			}
		}
		if (options.signal.aborted) {
			options.onEvent({ type: 'status', status: 'cancelled' });
			return { messages, status: 'cancelled' };
		}
		const code = error instanceof AgentRequestError ? error.code : 'provider-error';
		options.onEvent({ type: 'error', code, message: code });
		options.onEvent({ type: 'status', status: 'error' });
		return { messages, status: 'error', error: code };
	}
}
