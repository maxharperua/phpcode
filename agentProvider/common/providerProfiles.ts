/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type PhpcodeProviderId = 'bothub' | 'polza';

/** Only these fixed HTTPS destinations may receive credentials from the native transport. */
export const PHPCODE_PROVIDERS = Object.freeze({
	bothub: Object.freeze({ id: 'bothub' as const, name: 'BotHub', baseUrl: 'https://openai.bothub.chat/v1', modelsPath: '/models', modelsRequireKey: true, secretKey: 'phpcode.bothub.apiKey' }),
	polza: Object.freeze({ id: 'polza' as const, name: 'polza.ai', baseUrl: 'https://polza.ai/api/v1', modelsPath: '/models?type=chat', modelsRequireKey: false, secretKey: 'phpcode.polza.apiKey' })
});

export function isPhpcodeProviderId(value: unknown): value is PhpcodeProviderId {
	return typeof value === 'string' && Object.hasOwn(PHPCODE_PROVIDERS, value);
}

/** Old saved conversations used BotHub before a provider field existed. */
export function savedProviderId(value: unknown): PhpcodeProviderId {
	return isPhpcodeProviderId(value) ? value : 'bothub';
}
