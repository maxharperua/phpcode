/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IPhpcodeProviderService, IPhpcodeProviderStreamEvent, PhpcodeProviderErrorCode, PhpcodeProviderModel } from '../common/provider.js';

import { isPhpcodeProviderId, PHPCODE_PROVIDERS, PhpcodeProviderId } from '../common/providerProfiles.js';
const maxResponseBytes = 4 * 1024 * 1024;
const maxRequestBytes = 8 * 1024 * 1024;

interface PendingRequest {
	readonly controller: AbortController;
	timedOut: boolean;
}

function statusCode(status: number): PhpcodeProviderErrorCode {
	if (status === 401) { return 'authentication'; }
	if (status === 402) { return 'balance'; }
	if (status === 403 || status === 404) { return 'model_unavailable'; }
	if (status === 429) { return 'rate_limit'; }
	return status >= 500 ? 'server' : 'invalid_request';
}

function validKey(key: string): boolean {
	return typeof key === 'string' && key.length > 0 && key.length <= 8192 && !/[\r\n]/.test(key);
}

/** Streams provider responses from the native process without exposing Node APIs to the view. */
export class PhpcodeProviderMainService extends Disposable implements IPhpcodeProviderService {
	declare readonly _serviceBrand: undefined;

	private readonly streamEmitter = this._register(new Emitter<IPhpcodeProviderStreamEvent>());
	readonly onDidStream = this.streamEmitter.event;
	private readonly pending = new Map<string, PendingRequest>();

	constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {
		super();
	}

	async start(requestId: string, key: string, body: string, providerId: PhpcodeProviderId = 'bothub'): Promise<void> {
		if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId) || this.pending.has(requestId)) {
			throw new Error('invalid_request');
		}
		if (!isPhpcodeProviderId(providerId) || !validKey(key) || typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > maxRequestBytes || this.pending.size >= 8) {
			this.streamEmitter.fire({ requestId, kind: 'error', code: 'invalid_request' });
			return;
		}
		const request: PendingRequest = { controller: new AbortController(), timedOut: false };
		this.pending.set(requestId, request);
		// Subscription is established by the consumer before start; this call does not
		// wait for response headers or completion of the stream.
		void this.pump(requestId, key, body, request, providerId);
	}

	async cancel(requestId: string): Promise<void> {
		this.pending.get(requestId)?.controller.abort();
	}

	private async pump(requestId: string, key: string, body: string, request: PendingRequest, providerId: PhpcodeProviderId): Promise<void> {
		const timeout = setTimeout(() => { request.timedOut = true; request.controller.abort(); }, 120000);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await this.fetcher(`${PHPCODE_PROVIDERS[providerId].baseUrl}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
				body,
				signal: request.controller.signal,
				redirect: 'error'
			});
			if (!response.ok) {
				await response.body?.cancel();
				this.streamEmitter.fire({ requestId, kind: 'error', code: statusCode(response.status) });
				return;
			}
			if (!response.body) {
				this.streamEmitter.fire({ requestId, kind: 'error', code: 'invalid_response' });
				return;
			}
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let bytes = 0;
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) { break; }
				bytes += chunk.value.byteLength;
				if (bytes > maxResponseBytes) {
					await reader.cancel();
					this.streamEmitter.fire({ requestId, kind: 'error', code: 'response_too_large' });
					return;
				}
				const data = decoder.decode(chunk.value, { stream: true });
				if (data) { this.streamEmitter.fire({ requestId, kind: 'data', data }); }
			}
			if (request.controller.signal.aborted) {
				this.streamEmitter.fire({ requestId, kind: 'error', code: request.timedOut ? 'timeout' : 'cancelled' });
				return;
			}
			const tail = decoder.decode();
			if (tail) { this.streamEmitter.fire({ requestId, kind: 'data', data: tail }); }
			this.streamEmitter.fire({ requestId, kind: 'end' });
		} catch {
			// Never propagate fetch exceptions or response bodies: they can contain secrets.
			this.streamEmitter.fire({ requestId, kind: 'error', code: request.timedOut ? 'timeout' : request.controller.signal.aborted ? 'cancelled' : 'network' });
		} finally {
			clearTimeout(timeout);
			reader?.releaseLock();
			this.pending.delete(requestId);
		}
	}

	async models(key: string, providerId: PhpcodeProviderId = 'bothub'): Promise<PhpcodeProviderModel[]> {
		if (!isPhpcodeProviderId(providerId)) { throw new Error('invalid_request'); }
		const profile = PHPCODE_PROVIDERS[providerId];
		if (profile.modelsRequireKey && !validKey(key)) { throw new Error('authentication'); }
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await this.fetcher(profile.baseUrl + profile.modelsPath, {
				headers: profile.modelsRequireKey ? { 'Authorization': `Bearer ${key}` } : {},
				signal: controller.signal,
				redirect: 'error'
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(statusCode(response.status));
			}
			if (!response.body) { throw new Error('invalid_response'); }
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let text = '';
			let bytes = 0;
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) { break; }
				bytes += chunk.value.byteLength;
				if (bytes > maxResponseBytes) { await reader.cancel(); throw new Error('response_too_large'); }
				text += decoder.decode(chunk.value, { stream: true });
			}
			text += decoder.decode();
			let value: { readonly data?: readonly unknown[] };
			try { value = JSON.parse(text) as { readonly data?: readonly unknown[] }; } catch { throw new Error('invalid_response'); }
			if (!value || typeof value !== 'object' || !Array.isArray(value.data)) { throw new Error('invalid_response'); }
			const models = new Map<string, PhpcodeProviderModel>();
			for (const item of value.data) {
				if (item && typeof item === 'object') {
					const candidate = item as { readonly id?: unknown; context_length?: number; context_window?: number; max_context_length?: number; max_model_len?: number; top_provider?: { context_length?: number } };
					if (typeof candidate.id === 'string' && candidate.id.trim() && candidate.id.length <= 256) {
						const windows = [candidate.context_length, candidate.context_window, candidate.max_context_length, candidate.max_model_len, candidate.top_provider?.context_length].filter((value): value is number => Number.isSafeInteger(value) && value! >= 8000 && value! <= 10_000_000);
						const contextWindow = windows.length ? Math.min(...windows) : models.get(candidate.id)?.contextWindow;
						models.set(candidate.id, { id: candidate.id, ...(contextWindow ? { contextWindow } : {}) });
					}
				}
			}
			if (!models.size) { throw new Error('invalid_response'); }
			return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 5000);
		} catch (error) {
			const known: readonly string[] = ['authentication', 'balance', 'model_unavailable', 'rate_limit', 'server', 'invalid_request', 'response_too_large', 'invalid_response'];
			throw new Error(timedOut ? 'timeout' : error instanceof Error && known.includes(error.message) ? error.message : 'network');
		} finally {
			clearTimeout(timeout);
			reader?.releaseLock();
		}
	}

	override dispose(): void {
		for (const request of this.pending.values()) { request.controller.abort(); }
		this.pending.clear();
		super.dispose();
	}
}

/** Routes model streams and cancellation only to the requesting renderer connection. */
export class PhpcodeProviderChannel extends Disposable implements IServerChannel<string> {
	private readonly instances = this._register(new DisposableMap<string, PhpcodeProviderMainService>());

	constructor(
		onDidDisconnect: Event<{ readonly ctx: string }>,
		private readonly createService: () => PhpcodeProviderMainService = () => new PhpcodeProviderMainService(),
	) {
		super();
		this._register(onDidDisconnect(connection => this.instances.deleteAndDispose(connection.ctx)));
	}

	private instance(context: string): PhpcodeProviderMainService {
		if (typeof context !== 'string' || !/^window:\d+$/.test(context)) { throw new Error('invalid_request'); }
		let service = this.instances.get(context);
		if (!service) {
			service = this.createService();
			this.instances.set(context, service);
		}
		return service;
	}

	listen<T>(context: string, event: string): Event<T> {
		if (event !== 'onDidStream') { throw new Error('invalid_request'); }
		return this.instance(context).onDidStream as Event<T>;
	}

	async call<T>(context: string, command: string, arg?: unknown): Promise<T> {
		if (!Array.isArray(arg) || !arg.every(value => typeof value === 'string')) { throw new Error('invalid_request'); }
		const args = arg as string[];
		let result: PhpcodeProviderModel[] | void;
		switch (command) {
			case 'start':
				if ((args.length !== 3 && args.length !== 4) || (args.length === 4 && !isPhpcodeProviderId(args[3]))) { throw new Error('invalid_request'); }
				result = await this.instance(context).start(args[0], args[1], args[2], args[3] as PhpcodeProviderId | undefined);
				break;
			case 'cancel':
				if (args.length !== 1) { throw new Error('invalid_request'); }
				result = await this.instance(context).cancel(args[0]);
				break;
			case 'models':
				if ((args.length !== 1 && args.length !== 2) || (args.length === 2 && !isPhpcodeProviderId(args[1]))) { throw new Error('invalid_request'); }
				result = await this.instance(context).models(args[0], args[1] as PhpcodeProviderId | undefined);
				break;
			default: throw new Error('invalid_request');
		}
		return result as T;
	}
}
