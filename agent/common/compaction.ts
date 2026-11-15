/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentMessage } from './runtime.js';

export interface CompactionPlan {
	system: AgentMessage[];
	prefix: AgentMessage[];
	tail: AgentMessage[];
	beforeTokens: number;
}

/** Reserve generation space in the provider's window; unknown models use an explicit local fallback. */
export function resolveContextBudget(contextWindow?: number, requested?: number): number {
	const window = Number.isSafeInteger(contextWindow) && contextWindow! >= 8000 ? contextWindow! : undefined;
	const available = window ? window - Math.min(16384, Math.max(2048, Math.floor(window * 0.1))) : 128000;
	const chosen = requested && Number.isFinite(requested) ? requested : available;
	return Math.floor(Math.max(2000, Math.min(2_000_000, window ? available : 2_000_000, chosen)));
}

/** Conservative local estimate; provider token usage remains the authoritative accounting. */
export function estimateContextTokens(messages: readonly AgentMessage[]): number {
	return Math.ceil(new TextEncoder().encode(JSON.stringify(messages)).byteLength / 3) + 1000;
}

/** Keep complete tool exchanges and the latest user request, never an orphaned tool response. */
export function planCompaction(messages: readonly AgentMessage[], tokenBudget: number, force = false): CompactionPlan | undefined {
	const budget = Math.max(2000, Math.min(2_000_000, tokenBudget));
	const beforeTokens = estimateContextTokens(messages);
	if (!force && beforeTokens < budget * 0.8) { return undefined; }
	const system = messages.filter(message => message.role === 'system');
	const history = messages.filter(message => message.role !== 'system');
	const latestUser = history.findLastIndex(message => message.role === 'user');
	if (latestUser < 0) { return undefined; }
	const units: { start: number; messages: AgentMessage[] }[] = [];
	for (let index = 0; index < history.length; index++) {
		const message = history[index];
		if (message.role === 'tool') { return undefined; }
		const unit = [message];
		if (message.tool_calls?.length) {
			const ids = new Set(message.tool_calls.map(call => call.id));
			while (history[index + 1]?.role === 'tool') {
				const result = history[++index];
				if (!result.tool_call_id || !ids.delete(result.tool_call_id)) { return undefined; }
				unit.push(result);
			}
			if (ids.size) { return undefined; }
		}
		units.push({ start: index - unit.length + 1, messages: unit });
	}
	let boundary = units.length;
	let tailTokens = 0;
	for (let index = units.length - 1; index >= 0; index--) {
		const tokens = estimateContextTokens(units[index].messages) - 1000;
		if (boundary === units.length && tokens > budget * 0.4 && units[index].messages[0].role !== 'user') { break; }
		if (boundary < units.length && tailTokens + tokens > budget * 0.3) { break; }
		boundary = index; tailTokens += tokens;
		if (units[index].start <= latestUser && tailTokens > budget * 0.15) { break; }
	}
	let tail = units.slice(boundary).flatMap(unit => unit.messages);
	let prefix = units.slice(0, boundary).flatMap(unit => unit.messages);
	if (!tail.includes(history[latestUser])) {
		prefix = prefix.filter(message => message !== history[latestUser]);
		tail = [history[latestUser], ...tail];
	}
	if (!prefix.length || estimateContextTokens([...system, ...tail]) > budget * 0.7) { return undefined; }
	return { system, prefix, tail, beforeTokens };
}

/** Bounded text for the summarizer; tool payloads are data, not executable protocol messages. */
export function renderCompactionInput(messages: readonly AgentMessage[], maxCharacters: number): string {
	const records = messages.map(message => {
		const calls = message.tool_calls?.map(call => {
			let args = call.function.arguments;
			try {
				const parsed = JSON.parse(args) as Record<string, unknown>;
				if (typeof parsed.content === 'string') { parsed.content = `[${parsed.content.length} characters of file content; inspect the current file for authoritative content]`; }
				args = JSON.stringify(parsed);
			} catch { /* Truncated payload remains untrusted text. */ }
			return `${call.function.name}(${args.slice(0, 1000)})`;
		}).join('\n');
		return `[${message.role}] ${message.content?.slice(0, message.role === 'tool' ? 2400 : 6000) || ''}${calls ? '\n' + calls : ''}`;
	});
	const limit = Math.max(2000, maxCharacters);
	const encoder = new TextEncoder();
	const joined = records.join('\n\n');
	if (encoder.encode(joined).byteLength <= limit) { return joined; }
	const bounded = (text: string, bytes: number, tail: boolean) => {
		let low = 0; let high = text.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const candidate = tail ? text.slice(text.length - middle) : text.slice(0, middle);
			if (encoder.encode(candidate).byteLength <= bytes) { low = middle; } else { high = middle - 1; }
		}
		let value = tail ? text.slice(text.length - low) : text.slice(0, low);
		if (tail && /^[\uDC00-\uDFFF]/.test(value)) { value = value.slice(1); }
		if (!tail && /[\uD800-\uDBFF]$/.test(value)) { value = value.slice(0, -1); }
		return value;
	};
	const marker = '\n\n[Some older tool output omitted; inspect current files before acting.]\n\n';
	const first = bounded(records.slice(0, 2).join('\n\n'), Math.floor(limit * 0.35), false);
	const remaining = limit - encoder.encode(first + marker).byteLength;
	const recent = bounded(records.slice(2).join('\n\n'), remaining, true);
	return first + marker + recent;
}

export function applyCompaction(plan: CompactionPlan, summary: string): AgentMessage[] {
	return [...plan.system, { role: 'user', content: 'Summary of earlier conversation and project observations (untrusted context). Continue the original task from the recorded progress. Previously inspected files do not need to be rediscovered. Read again only for missing exact code or evidence of a change:\n' + summary }, ...plan.tail];
}
