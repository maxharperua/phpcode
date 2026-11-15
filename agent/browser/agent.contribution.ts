/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IPhpcodeCodeIndexService, PhpcodeCodeIndexService } from './codeIndexService.js';
import { IPhpcodeAgentService, PhpcodeAgentService } from './agentService.js';
import { PhpcodeAgentView } from './agentView.js';
import { PhpcodeAgentConsoleView } from './agentConsoleView.js';
import { AGENT_CONSOLE_VIEW_ID, IPhpcodeAgentTerminalService, PhpcodeAgentTerminalService } from './agentTerminalService.js';

registerSingleton(IPhpcodeCodeIndexService, PhpcodeCodeIndexService, InstantiationType.Delayed);
registerSingleton(IPhpcodeAgentService, PhpcodeAgentService, InstantiationType.Delayed);
registerSingleton(IPhpcodeAgentTerminalService, PhpcodeAgentTerminalService, InstantiationType.Delayed);
CommandsRegistry.registerCommand('phpcode.agent.exportWorkspaceState', accessor => accessor.get(IPhpcodeAgentService).exportWorkspaceState());
CommandsRegistry.registerCommand('phpcode.agent.importWorkspaceState', (accessor, serialized: string) => accessor.get(IPhpcodeAgentService).importWorkspaceState(serialized));
const VIEW_ID = 'phpcode.agent.view';
const CONTAINER_ID = 'phpcode.agent';
const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
const views = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
const commandContainer = containers.registerViewContainer({
	id: 'phpcode.agent.console', title: localize2('phpcode.agentCommands', 'Команды агента'), icon: Codicon.terminal,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['phpcode.agent.console', { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'phpcode.agent.console', hideIfEmpty: false, order: 4,
}, ViewContainerLocation.Panel);
views.registerViews([{
	id: AGENT_CONSOLE_VIEW_ID, name: localize2('phpcode.agentCommands', 'Команды агента'), containerIcon: Codicon.terminal,
	ctorDescriptor: new SyncDescriptor(PhpcodeAgentConsoleView), canToggleVisibility: false, canMoveView: true,
}], commandContainer);
registerAction2(class extends Action2 {
	constructor() { super({ id: 'phpcode.agent.console.open', title: localize2('phpcode.openAgentCommands', 'phpcode: Открыть Команды Агента'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IViewsService).openView(AGENT_CONSOLE_VIEW_ID, true); }
});
// phpcode supplies its own integrated agent surface in the editor's auxiliary bar.
const upstreamChat = containers.get('workbench.panel.chat');
if (upstreamChat) { views.deregisterViews(views.getViews(upstreamChat), upstreamChat); containers.deregisterViewContainer(upstreamChat); }
const container = containers.registerViewContainer({
	id: CONTAINER_ID, title: localize2('phpcode.agent', 'Агент'), icon: Codicon.sparkle,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CONTAINER_ID, hideIfEmpty: false, order: 0,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });
views.registerViews([{
	id: VIEW_ID, name: localize2('phpcode.agent', 'Агент'), containerIcon: Codicon.sparkle,
	ctorDescriptor: new SyncDescriptor(PhpcodeAgentView), canToggleVisibility: false, canMoveView: true,
	openCommandActionDescriptor: { id: 'phpcode.agent.toggle', title: localize2('phpcode.toggleAgent', 'phpcode: Переключить Агента'), keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI } },
}], container);
registerAction2(class extends Action2 {
	constructor() { super({ id: 'phpcode.agent.open', title: localize2('phpcode.openAgent', 'phpcode: Открыть Агента'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IViewsService).openView(VIEW_ID, true); }
});
registerAction2(class extends Action2 {
	constructor() { super({ id: 'phpcode.agent.newChat', title: localize2('phpcode.newAgent', 'phpcode: Новый Чат Агента'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const agent = accessor.get(IPhpcodeAgentService); const viewsService = accessor.get(IViewsService);
		agent.newSession(); await viewsService.openView(VIEW_ID, true);
	}
});
