/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PhpcodeProviderId } from './providerProfiles.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const PHPCODE_PROVIDER_CHANNEL = 'phpcodeProvider';
export const IPhpcodeProviderService = createDecorator<IPhpcodeProviderService>('phpcodeProviderService');

export type PhpcodeProviderErrorCode = 'invalid_request' | 'authentication' | 'balance' | 'model_unavailable' | 'rate_limit' | 'network' | 'timeout' | 'cancelled' | 'response_too_large' | 'invalid_response' | 'server';

export interface IPhpcodeProviderStreamEvent {
	readonly requestId: string;
	readonly kind: 'data' | 'end' | 'error';
	readonly data?: string;
	readonly code?: PhpcodeProviderErrorCode;
}

export interface PhpcodeProviderModel {
	readonly id: string;
	readonly contextWindow?: number;
}

/** Native transport for the allowlisted provider endpoints; API keys are never persisted here. */
export interface IPhpcodeProviderService {
	readonly _serviceBrand: undefined;
	readonly onDidStream: Event<IPhpcodeProviderStreamEvent>;
	start(requestId: string, key: string, body: string, providerId?: PhpcodeProviderId): Promise<void>;
	cancel(requestId: string): Promise<void>;
	models(key: string, providerId?: PhpcodeProviderId): Promise<PhpcodeProviderModel[]>;
}
