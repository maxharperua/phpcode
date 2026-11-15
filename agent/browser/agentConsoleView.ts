/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { AgentCommandRecord, IPhpcodeAgentTerminalService, PhpcodeAgentTerminalService } from './agentTerminalService.js';
import './media/agentConsole.css';

const $ = dom.$;
interface CommandElements { root: HTMLElement; output: HTMLElement; status: HTMLElement; stop: HTMLButtonElement; store: DisposableStore }

/** A single bottom-panel journal for commands from every agent chat in this project. */
export class PhpcodeAgentConsoleView extends ViewPane {
	private rootElement!: HTMLElement;
	private list!: HTMLElement;
	private empty!: HTMLElement;
	private readonly rows = new Map<string, CommandElements>();
	private readonly renderLater = this._register(new RunOnceScheduler(() => this.renderCommands(), 60));

	constructor(options: IViewPaneOptions,
		@IKeybindingService keybindings: IKeybindingService,
		@IContextMenuService contextMenu: IContextMenuService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IViewDescriptorService descriptor: IViewDescriptorService,
		@IInstantiationService instantiation: IInstantiationService,
		@IOpenerService opener: IOpenerService,
		@IThemeService theme: IThemeService,
		@IHoverService hover: IHoverService,
		@IPhpcodeAgentTerminalService private readonly terminal: PhpcodeAgentTerminalService,
	) {
		super(options, keybindings, contextMenu, configuration, contextKeys, descriptor, instantiation, opener, theme, hover);
		this._register(terminal.onDidChange(() => { if (!this.renderLater.isScheduled()) { this.renderLater.schedule(); } }));
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { this.renderCommands(); } }));
	}
	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.rootElement = dom.append(container, $('.phpcode-agent-console', { tabIndex: 0, 'aria-label': localize('phpcode.commandJournal', 'История команд агента') }));
		const toolbar = dom.append(this.rootElement, $('.phpcode-agent-console-toolbar'));
		dom.append(toolbar, $('span', undefined, localize('phpcode.commandsAllChats', 'Запуски из всех чатов проекта')));
		const clear = dom.append(toolbar, $('button', { type: 'button' }, localize('phpcode.clearCommands', 'Очистить завершённые'))) as HTMLButtonElement;
		this._register(dom.addDisposableListener(clear, 'click', () => this.terminal.clearCompleted()));
		this._register(this.hoverService.setupDelayedHover(clear, { content: localize('phpcode.clearCommandsHelp', 'Убрать завершённые записи из журнала. Работающие команды продолжат выполняться.') }));
		this.list = dom.append(this.rootElement, $('.phpcode-agent-console-list'));
		this.empty = dom.append(this.list, $('.phpcode-agent-console-empty', undefined, localize('phpcode.noCommands', 'Агент ещё не запускал команды. Здесь появятся команды, их вывод и результат выполнения.')));
		this.renderCommands();
		this._register(dom.scheduleAtNextAnimationFrame(dom.getWindow(container), () => { this.list.scrollTop = this.list.scrollHeight; }));
	}
	private createRow(record: AgentCommandRecord): CommandElements {
		const store = new DisposableStore();
		const root = dom.append(this.list, $('article.phpcode-agent-command', { 'data-command-id': record.id }));
		const heading = dom.append(root, $('.phpcode-agent-command-heading'));
		dom.append(heading, $('span.phpcode-agent-command-chat', undefined, record.sessionTitle));
		dom.append(heading, $('time', { dateTime: new Date(record.started).toISOString() }, new Date(record.started).toLocaleTimeString()));
		const status = dom.append(heading, $('span.phpcode-agent-command-status', { role: 'status' }));
		const stop = dom.append(heading, $('button', { type: 'button' }, localize('phpcode.stopCommand', 'Остановить'))) as HTMLButtonElement;
		store.add(dom.addDisposableListener(stop, 'click', () => this.terminal.stop(record.id)));
		store.add(this.hoverService.setupDelayedHover(stop, { content: localize('phpcode.stopCommandHelp', 'Остановить эту команду агента') }));
		dom.append(root, $('pre.phpcode-agent-command-text', undefined, '$ ' + record.command));
		dom.append(root, $('div.phpcode-agent-command-cwd', undefined, record.cwd));
		const output = dom.append(root, $('pre.phpcode-agent-command-output', { tabIndex: 0, 'aria-label': localize('phpcode.commandOutput', 'Вывод команды') }));
		return { root, status, stop, output, store };
	}
	private renderCommands(): void {
		if (!this.list) { return; }
		const follow = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
		const ids = new Set(this.terminal.records.map(record => record.id));
		for (const [id, row] of this.rows) { if (!ids.has(id)) { row.store.dispose(); row.root.remove(); this.rows.delete(id); } }
		this.empty.hidden = this.terminal.records.length > 0;
		for (const record of this.terminal.records) {
			let row = this.rows.get(record.id);
			if (!row) { row = this.createRow(record); this.rows.set(record.id, row); }
			row.root.dataset.state = record.state;
			const labels: Record<AgentCommandRecord['state'], string> = {
				running: localize('phpcode.commandRunning', 'Выполняется'), completed: localize('phpcode.commandCompleted', 'Завершено'), failed: localize('phpcode.commandFailed', 'Ошибка'),
				cancelled: localize('phpcode.commandCancelled', 'Остановлено'), timeout: localize('phpcode.commandTimeout', 'Лимит времени'), interrupted: localize('phpcode.commandInterrupted', 'Прервано при закрытии приложения')
			};
			row.status.textContent = labels[record.state] + (record.exitCode !== undefined ? localize('phpcode.commandExitCode', ' · код {0}', record.exitCode) : '') + (record.ended ? localize('phpcode.commandDuration', ' · {0} с', Math.max(0, (record.ended - record.started) / 1000).toFixed(1)) : '');
			row.stop.hidden = record.state !== 'running';
			const text = (record.truncated ? localize('phpcode.commandOutputLimited', '[Показана последняя часть вывода — до 64000 символов.]') + '\n' : '') + record.output;
			if (row.output.textContent !== text) { row.output.textContent = text; }
		}
		if (follow) { this.list.scrollTop = this.list.scrollHeight; }
	}
	protected override layoutBody(height: number, width: number): void { super.layoutBody(height, width); if (this.rootElement) { this.rootElement.style.height = `${height}px`; } }
	override focus(): void { super.focus(); this.rootElement?.focus(); }
	override dispose(): void { for (const row of this.rows.values()) { row.store.dispose(); } this.rows.clear(); super.dispose(); }
}
