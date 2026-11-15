/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface AgentExecutionSettings {
	mode: 'agent' | 'ask';
	applyMode?: 'manual' | 'auto';
	terminalMode?: 'confirm' | 'auto';
}

/** Missing terminal policy preserves confirmation for chats created before full automation existed. */
export function resolveExecutionPolicy(settings: AgentExecutionSettings): { id: 'ask' | 'manual' | 'semi' | 'auto'; applyEdits: boolean; commands: 'blocked' | 'confirm' | 'execute' } {
	if (settings.mode === 'ask') { return { id: 'ask', applyEdits: false, commands: 'blocked' }; }
	if (settings.applyMode !== 'auto') { return { id: 'manual', applyEdits: false, commands: 'confirm' }; }
	return settings.terminalMode === 'auto' ? { id: 'auto', applyEdits: true, commands: 'execute' } : { id: 'semi', applyEdits: true, commands: 'confirm' };
}
