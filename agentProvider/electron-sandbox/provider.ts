/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../instantiation/common/extensions.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { IPhpcodeProviderService, IPhpcodeProviderStreamEvent, PHPCODE_PROVIDER_CHANNEL, PhpcodeProviderModel } from '../common/provider.js';

export class PhpcodeProviderService implements IPhpcodeProviderService {
	declare readonly _serviceBrand: undefined;
	readonly onDidStream: Event<IPhpcodeProviderStreamEvent>;
	private readonly proxy: IPhpcodeProviderService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IPhpcodeProviderService>(mainProcessService.getChannel(PHPCODE_PROVIDER_CHANNEL));
		this.onDidStream = this.proxy.onDidStream;
	}
	start(requestId: string, key: string, body: string): Promise<void> {
		return this.proxy.start(requestId, key, body);
	}

	cancel(requestId: string): Promise<void> {
		return this.proxy.cancel(requestId);
	}

	models(key: string): Promise<PhpcodeProviderModel[]> {
		return this.proxy.models(key);
	}
}

registerSingleton(IPhpcodeProviderService, PhpcodeProviderService, InstantiationType.Delayed);
