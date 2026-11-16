/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IPhpcodeProviderStreamEvent } from '../../common/provider.js';
import { PhpcodeProviderChannel, PhpcodeProviderMainService } from '../../electron-main/provider.js';

function collectStream(service: PhpcodeProviderMainService, requestId: string, store: Pick<DisposableStore, 'add'>): Promise<readonly IPhpcodeProviderStreamEvent[]> {
	const complete = new DeferredPromise<readonly IPhpcodeProviderStreamEvent[]>();
	const events: IPhpcodeProviderStreamEvent[] = [];
	store.add(service.onDidStream(event => {
		if (event.requestId === requestId) {
			events.push(event);
			if (event.kind !== 'data') { void complete.complete(events); }
		}
	}));
	return complete.p;
}

suite('phpcode native provider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const key = 'test-key-not-a-real-credential';

	test('streams split UTF8 chunks and targets only the fixed nonredirecting endpoint', async () => {
		const payload = 'data: {"content":"Привет"}\n\ndata: [DONE]\n\n';
		const bytes = new TextEncoder().encode(payload);
		const split = bytes.indexOf(0xD0) + 1;
		let observedUrl = '';
		let observedRedirect: RequestRedirect | undefined;
		const service = store.add(new PhpcodeProviderMainService(async (input, options) => {
			observedUrl = String(input);
			observedRedirect = options?.redirect;
			return new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.slice(0, split));
					controller.enqueue(bytes.slice(split));
					controller.close();
				}
			}));
		}));
		const complete = collectStream(service, 'utf8', store);
		await service.start('utf8', key, '{}');
		const events = await complete;
		assert.deepStrictEqual({
			text: events.filter(event => event.kind === 'data').map(event => event.data).join(''),
			final: events.at(-1),
			url: observedUrl,
			redirect: observedRedirect
		}, { text: payload, final: { requestId: 'utf8', kind: 'end' }, url: 'https://openai.bothub.chat/v1/chat/completions', redirect: 'error' });
	});

	test('returns a fixed authentication code without echoing a server response body', async () => {
		const service = store.add(new PhpcodeProviderMainService(async () => new Response('SECRET_ERROR_BODY', { status: 401 })));
		const complete = collectStream(service, 'auth', store);
		await service.start('auth', key, '{}');
		assert.deepStrictEqual(await complete, [{ requestId: 'auth', kind: 'error', code: 'authentication' }]);
	});

	test('rejects oversized streams before forwarding the oversized chunk', async () => {
		const service = store.add(new PhpcodeProviderMainService(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1))));
		const complete = collectStream(service, 'large', store);
		await service.start('large', key, '{}');
		assert.deepStrictEqual(await complete, [{ requestId: 'large', kind: 'error', code: 'response_too_large' }]);
	});

	test('start returns before headers arrive and cancel aborts the pending fetch', async () => {
		const service = store.add(new PhpcodeProviderMainService((_input, options) => new Promise<Response>((_resolve, reject) => {
			options?.signal?.addEventListener('abort', () => reject(new Error('SECRET_FETCH_ERROR')), { once: true });
		})));
		const complete = collectStream(service, 'cancel', store);
		await service.start('cancel', key, '{}');
		await service.cancel('cancel');
		assert.deepStrictEqual(await complete, [{ requestId: 'cancel', kind: 'error', code: 'cancelled' }]);
	});

	test('validates model IDs, deduplicates and sorts the model list', async () => {
		const service = store.add(new PhpcodeProviderMainService(async () => new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }, { id: 42 }, {}] }))));
		assert.deepStrictEqual(await service.models(key), [{ id: 'a-model' }, { id: 'z-model' }]);
	});

	test('retains validated model windows and accepts documented aliases without guessing from IDs', async () => {
		const service = store.add(new PhpcodeProviderMainService(async () => new Response(JSON.stringify({ data: [
			{ id: 'wide', context_length: 1048576 }, { id: 'alias', top_provider: { context_length: 256000 } },
			{ id: 'conflicting', context_length: 200000, context_window: 128000 },
			{ id: 'unknown', context_length: '1000000' }, { id: 'bad', max_model_len: -1 }, { id: '' }
		] }))));
		assert.deepStrictEqual(await service.models(key), [{ id: 'alias', contextWindow: 256000 }, { id: 'bad' }, { id: 'conflicting', contextWindow: 128000 }, { id: 'unknown' }, { id: 'wide', contextWindow: 1048576 }]);
	});

	test('converts malformed model JSON to a fixed safe error', async () => {
		const service = store.add(new PhpcodeProviderMainService(async () => new Response('SECRET_INVALID_JSON')));
		await assert.rejects(service.models(key), { message: 'invalid_response' });
	});
	test('isolates identical request IDs, cancellation and stream events between windows', async () => {
		const disconnect = store.add(new Emitter<{ readonly ctx: string }>());
		const responses = [new DeferredPromise<Response>(), new DeferredPromise<Response>()];
		const signals: AbortSignal[] = [];
		let created = 0;
		const channel = store.add(new PhpcodeProviderChannel(disconnect.event, () => {
			const index = created++;
			return new PhpcodeProviderMainService((_input, options) => {
				const signal = options!.signal!;
				signals[index] = signal;
				return new Promise<Response>((resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('private failure')), { once: true });
					void responses[index].p.then(resolve, reject);
				});
			});
		}));
		const first: IPhpcodeProviderStreamEvent[] = [];
		const second: IPhpcodeProviderStreamEvent[] = [];
		const firstComplete = new DeferredPromise<void>();
		const secondComplete = new DeferredPromise<void>();
		store.add(channel.listen<IPhpcodeProviderStreamEvent>('window:1', 'onDidStream')(event => {
			first.push(event);
			if (event.kind !== 'data') { void firstComplete.complete(); }
		}));
		store.add(channel.listen<IPhpcodeProviderStreamEvent>('window:2', 'onDidStream')(event => {
			second.push(event);
			if (event.kind !== 'data') { void secondComplete.complete(); }
		}));
		await channel.call('window:1', 'start', ['same-id', 'first-private-key', '{}']);
		await channel.call('window:2', 'start', ['same-id', 'second-private-key', '{}']);
		await channel.call('window:1', 'cancel', ['same-id']);
		await firstComplete.p;
		const duringCancellation = { firstAborted: signals[0].aborted, secondAborted: signals[1].aborted, secondEvents: [...second] };
		void responses[1].complete(new Response('data: second-window-only\n\n'));
		await secondComplete.p;
		assert.deepStrictEqual({ created, duringCancellation, first, second }, {
			created: 2,
			duringCancellation: { firstAborted: true, secondAborted: false, secondEvents: [] },
			first: [{ requestId: 'same-id', kind: 'error', code: 'cancelled' }],
			second: [{ requestId: 'same-id', kind: 'data', data: 'data: second-window-only\n\n' }, { requestId: 'same-id', kind: 'end' }]
		});
	});

	test('disconnect disposes only the matching connection and rejects private IPC methods', async () => {
		const disconnect = store.add(new Emitter<{ readonly ctx: string }>());
		const signals: AbortSignal[] = [];
		const channel = store.add(new PhpcodeProviderChannel(disconnect.event, () => new PhpcodeProviderMainService((_input, options) => {
			const signal = options!.signal!;
			signals.push(signal);
			return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
		})));
		await channel.call('window:1', 'start', ['same-id', key, '{}']);
		await channel.call('window:2', 'start', ['same-id', key, '{}']);
		disconnect.fire({ ctx: 'window:1' });
		await assert.rejects(channel.call('window:2', 'pump', []), { message: 'invalid_request' });
		assert.deepStrictEqual(signals.map(signal => signal.aborted), [true, false]);
	});

	test('routes Polza completions only to its fixed host with the supplied Polza key', async () => {
		const observed: { url: string; authorization: string | null; redirect: RequestRedirect | undefined }[] = [];
		const service = store.add(new PhpcodeProviderMainService(async (url, options) => {
			observed.push({ url: String(url), authorization: new Headers(options?.headers).get('Authorization'), redirect: options?.redirect });
			return new Response('data: [DONE]\n\n');
		}));
		const completed = collectStream(service, 'polza', store);
		await service.start('polza', 'polza-test-key', '{}', 'polza'); await completed;
		assert.deepStrictEqual(observed, [{ url: 'https://polza.ai/api/v1/chat/completions', authorization: 'Bearer polza-test-key', redirect: 'error' }]);
	});

	test('loads only Polza chat models from the public catalog without transmitting any key', async () => {
		let observedUrl = ''; let authorization: string | null = null;
		const service = store.add(new PhpcodeProviderMainService(async (url, options) => {
			observedUrl = String(url); authorization = new Headers(options?.headers).get('Authorization');
			return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-test', context_length: 200000 }] }));
		}));
		assert.deepStrictEqual(await service.models('must-not-leave-for-public-catalog', 'polza'), [{ id: 'anthropic/claude-test', contextWindow: 200000 }]);
		assert.equal(observedUrl, 'https://polza.ai/api/v1/models?type=chat'); assert.equal(authorization, null);
		assert.equal((await service.models('', 'polza')).length, 1);
	});

	test('rejects unknown provider identifiers at both native and IPC boundaries without fetching', async () => {
		let calls = 0;
		const service = store.add(new PhpcodeProviderMainService(async () => { calls++; return new Response(''); }));
		for (const id of ['https://example.invalid', '__proto__', 'constructor', 'unknown']) {
			const completed = collectStream(service, 'invalid-' + calls, store);
			await service.start('invalid-' + calls, key, '{}', id as never);
			assert.equal((await completed).at(-1)?.code, 'invalid_request');
			await assert.rejects(service.models(key, id as never), { message: 'invalid_request' });
		}
		const disconnect = store.add(new Emitter<{ readonly ctx: string }>());
		const channel = store.add(new PhpcodeProviderChannel(disconnect.event));
		await assert.rejects(channel.call('window:1', 'start', ['id', key, '{}', 'https://example.invalid']), { message: 'invalid_request' });
		await assert.rejects(channel.call('window:1', 'models', [key, '__proto__']), { message: 'invalid_request' });
		assert.equal(calls, 0);
	});

});
