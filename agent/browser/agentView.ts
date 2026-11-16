/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { extractEditorsDropData } from '../../../../platform/dnd/browser/dnd.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { PHPCODE_PROVIDERS, PhpcodeProviderId } from '../../../../platform/phpcodeProvider/common/providerProfiles.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IPhpcodeCodeIndexService, PhpcodeCodeIndexService } from './codeIndexService.js';
import { resolveExecutionPolicy } from '../common/executionPolicy.js';
import { findFileReferences } from '../common/fileReferences.js';
import { AgentEntry, AgentSession, IPhpcodeAgentService, PhpcodeAgentService } from './agentService.js';
import './media/agent.css';

const $ = dom.$;
export class PhpcodeAgentView extends ViewPane {
	private rootElement!: HTMLElement;
	private tabs!: HTMLElement;
	private transcript!: HTMLElement;
	private changes!: HTMLElement;
	private contexts!: HTMLElement;
	private approval!: HTMLElement;
	private status!: HTMLElement;
	private usage!: HTMLElement;
	private cache!: HTMLInputElement;
	private input!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private mode!: HTMLSelectElement;
	private contextButton!: HTMLButtonElement;
	private readonly folds = new Map<string, boolean>();
	private modelButton!: HTMLButtonElement;
	private settings!: HTMLElement;
	private indexButton!: HTMLButtonElement;
	private indexInfo!: HTMLElement;
	private indexDetails!: HTMLElement;
	private keyInput!: HTMLInputElement;
	private providerButton!: HTMLButtonElement;
	private providerSelect!: HTMLSelectElement;
	private providerHeading!: HTMLElement;
	private providerHelp!: HTMLElement;
	private renderedConnection = '';
	private history!: HTMLElement;
	private showHistory = false;
	private renderedSession = '';
	private readonly messageDateFormatter = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
	private timer: ReturnType<typeof setTimeout> | undefined;
	private elapsedTimer: ReturnType<typeof setInterval> | undefined;
	private readonly elapsedLabels: { element: HTMLElement; started: number; finished?: number }[] = [];
	private readonly renderStore = this._register(new DisposableStore());
	private readonly contentStore = this._register(new DisposableStore());

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
		@IPhpcodeAgentService private readonly agent: PhpcodeAgentService,
		@IPhpcodeCodeIndexService private readonly codeIndex: PhpcodeCodeIndexService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IMarkdownRendererService private readonly markdown: IMarkdownRendererService,
	) {
		super(options, keybindings, contextMenu, configuration, contextKeys, descriptor, instantiation, opener, theme, hover);
		const scheduleRender = () => {
			if (!this.rootElement || this.timer) { return; }
			this.timer = setTimeout(() => { this.timer = undefined; this.renderAgent(); }, 60);
		};
		this._register(agent.onDidChange(scheduleRender));
		this._register(codeIndex.onDidChange(scheduleRender));
	}
	private button(parent: HTMLElement, label: string, action: () => void | Promise<void>, store = this.renderStore, className = ''): HTMLButtonElement {
		const button = dom.append(parent, $('button.phpcode-agent-button' + (className ? '.' + className : ''), { type: 'button', 'aria-label': label }, label)) as HTMLButtonElement;
		store.add(this.hoverService.setupDelayedHover(button, () => ({ content: button.getAttribute('aria-label') || label })));
		store.add(dom.addDisposableListener(button, 'click', () => { Promise.resolve().then(action).catch(error => this.notifications.error(error)); }));
		return button;
	}
	private iconButton(parent: HTMLElement, label: string, icon: string, action: () => void | Promise<void>, className: string): HTMLButtonElement {
		const button = this.button(parent, label, action, this.renderStore, className + '.icon-button');
		button.title = label;
		this.icon(button, icon);
		return button;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.rootElement = dom.append(container, $('.phpcode-agent'));
		const toolbar = dom.append(this.rootElement, $('.phpcode-agent-toolbar'));
		this.tabs = dom.append(toolbar, $('.phpcode-agent-tabs', { role: 'tablist', 'aria-label': localize('phpcode.chats', 'Чаты агента') }));
		this.button(toolbar, '+', () => { this.agent.newSession(); this.input.focus(); }, this._store, 'new-chat').setAttribute('aria-label', localize('phpcode.newChat', 'Новый чат'));
		this.button(toolbar, localize('phpcode.history', 'История'), () => { this.showHistory = !this.showHistory; this.renderAgent(); }, this._store);
		this.providerButton = this.button(toolbar, this.agent.providerName, () => { this.settings.hidden = !this.settings.hidden; if (!this.settings.hidden) { this.keyInput.focus(); } }, this._store);
		this.indexDetails = dom.append(this.rootElement, $('.phpcode-agent-index-details')); this.indexDetails.hidden = true;
		dom.append(this.indexDetails, $('strong', undefined, localize('phpcode.projectIndex', 'Индекс проекта')));
		dom.append(this.indexDetails, $('p', undefined, localize('phpcode.indexHelp', 'Индекс хранится локально и обновляется при изменении файлов. Агент получает найденные фрагменты с номерами строк. Платные embeddings не используются.')));
		this.indexInfo = dom.append(this.indexDetails, $('p'));
		this.button(this.indexDetails, localize('phpcode.rebuildIndex', 'Пересоздать индекс'), () => this.codeIndex.rebuild(), this._store, 'rebuild-index');
		this.history = dom.append(this.rootElement, $('.phpcode-agent-history')); this.history.hidden = true;
		this.settings = dom.append(this.rootElement, $('.phpcode-agent-settings')); this.settings.hidden = true;
		this.providerHeading = dom.append(this.settings, $('strong'));
		const providerLabel = dom.append(this.settings, $('label.phpcode-agent-provider-label', undefined, localize('phpcode.providerSelect', 'Провайдер')));
		this.providerSelect = dom.append(providerLabel, $('select.phpcode-agent-provider', { 'aria-label': localize('phpcode.providerSelect', 'Провайдер') })) as HTMLSelectElement;
		for (const profile of Object.values(PHPCODE_PROVIDERS)) { dom.append(this.providerSelect, $('option', { value: profile.id }, profile.name)); }
		this._register(dom.addDisposableListener(this.providerSelect, 'change', () => {
			this.agent.setProvider(this.providerSelect.value as PhpcodeProviderId);
			this.keyInput.value = '';
		}));
		this.providerHelp = dom.append(this.settings, $('p'));
		this.keyInput = dom.append(this.settings, $('input', { type: 'password', autocomplete: 'off', placeholder: localize('phpcode.key', 'API-ключ BotHub'), 'aria-label': localize('phpcode.key', 'API-ключ BotHub') })) as HTMLInputElement;
		this.button(this.settings, localize('phpcode.saveKey', 'Сохранить ключ'), async () => {
			if (!this.keyInput.value.trim()) { return; }
			const providerId = this.agent.providerId; const sessionId = this.agent.activeId;
			await this.agent.setKey(this.keyInput.value, providerId);
			if (this.agent.providerId === providerId && this.agent.activeId === sessionId) { this.keyInput.value = ''; this.settings.hidden = true; }
			this.notifications.info(localize('phpcode.providerKeySaved', 'Ключ {0} сохранён. Выберите модель.', PHPCODE_PROVIDERS[providerId].name));
		}, this._store, 'save-key');
		const cacheLabel = dom.append(this.settings, $('label.phpcode-agent-cache'));
		this.cache = dom.append(cacheLabel, $('input', { type: 'checkbox', 'aria-label': localize('phpcode.cache', 'Кеш Claude (5 минут)') })) as HTMLInputElement;
		dom.append(cacheLabel, $('span', undefined, localize('phpcode.cache', 'Кеш Claude (5 минут)')));
		this._register(dom.addDisposableListener(this.cache, 'change', () => { this.agent.active.cache = this.cache.checked ? 'auto' : 'off'; this.agent.update(); }));
		dom.append(this.settings, $('p', undefined, localize('phpcode.cacheHelp', 'Запись кеша может оплачиваться отдельно. Автоматический кеш других моделей работает на стороне провайдера; экономия зависит от повторных запросов.')));
		this.button(this.settings, localize('phpcode.refreshModels', 'Обновить модели'), async () => { await this.agent.loadModels(); }, this._store);
		this.button(this.settings, localize('phpcode.removeKey', 'Удалить ключ'), async () => { await this.agent.setKey(''); this.keyInput.value = ''; }, this._store);
		this.transcript = dom.append(this.rootElement, $('.phpcode-agent-transcript', { role: 'log', 'aria-label': localize('phpcode.transcript', 'Переписка с агентом'), 'aria-live': 'off' }));
		this.changes = dom.append(this.rootElement, $('.phpcode-agent-changes'));
		this.approval = dom.append(this.rootElement, $('.phpcode-agent-approval'));
		const composer = dom.append(this.rootElement, $('.phpcode-agent-composer'));
		const resources = (event: DragEvent) => {
			const found = extractEditorsDropData(event).flatMap(item => item.resource ? [item.resource] : []);
			for (const line of (event.dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/)) {
				if (!line || line.startsWith('#')) { continue; }
				try { const uri = URI.parse(line); if (uri.scheme === 'file' || uri.scheme === 'vscode-remote') { found.push(uri); } } catch { /* Invalid drops do not become context. */ }
			}
			return [...new Map(found.map(uri => [uri.toString(), uri])).values()];
		};
		this._register(dom.addDisposableListener(composer, 'dragover', (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) { event.dataTransfer.dropEffect = 'copy'; } composer.classList.add('drop-target'); }));
		this._register(dom.addDisposableListener(composer, 'dragleave', (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !composer.contains(event.relatedTarget)) { composer.classList.remove('drop-target'); } }));
		this._register(dom.addDisposableListener(composer, 'drop', (event: DragEvent) => {
			event.preventDefault(); event.stopPropagation(); composer.classList.remove('drop-target');
			void (async () => { const items = resources(event); if (!items.length) { return; } for (const uri of items.slice(0, 8)) { await this.agent.attachResource(uri); } this.input.focus(); })().catch(error => this.notifications.error(error));
		}));
		this.contexts = dom.append(composer, $('.phpcode-agent-contexts'));
		this.input = dom.append(composer, $('textarea', { placeholder: localize('phpcode.prompt', 'Задача для агента… @ контекст'), 'aria-label': localize('phpcode.promptLabel', 'Сообщение агенту'), rows: 2 })) as HTMLTextAreaElement;
		this._register(dom.addDisposableListener(this.input, 'input', () => { this.agent.active.draft = this.input.value; this.sendButton.disabled = this.agent.active.status !== 'running' && !this.input.value.trim(); }));
		this._register(dom.addDisposableListener(this.input, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); }
			if (event.key === '@' && !this.input.value) { event.preventDefault(); void this.pickContext(); }
		}));
		this._register(this.hoverService.setupDelayedHover(this.input, { content: localize('phpcode.inputHelp', 'Enter — отправить · Shift+Enter — новая строка. Перетащите сюда файлы или папки проекта.') }));
		const controls = dom.append(composer, $('.phpcode-agent-controls'));
		this.mode = dom.append(controls, $('select.phpcode-agent-mode', { 'aria-label': localize('phpcode.mode', 'Режим агента') })) as HTMLSelectElement;
		this.mode.add(new Option(localize('phpcode.agentManual', 'Ручной'), 'agent-manual'));
		this.mode.add(new Option(localize('phpcode.agentSemi', 'Полуавтоматический'), 'agent-semi'));
		this.mode.add(new Option(localize('phpcode.agentAuto', 'Автоматический'), 'agent-auto')); this.mode.add(new Option('Ask', 'ask'));
		this._register(this.hoverService.setupDelayedHover(this.mode, { content: localize('phpcode.modeHelp', 'Ручной: подтверждение правок и команд. Полуавтоматический: правки сразу, команды с подтверждением. Автоматический: правки и команды сразу.') }));
		this._register(dom.addDisposableListener(this.mode, 'change', () => { this.agent.active.mode = this.mode.value === 'ask' ? 'ask' : 'agent'; if (this.mode.value !== 'ask') { this.agent.active.applyMode = this.mode.value === 'agent-manual' ? 'manual' : 'auto'; this.agent.active.terminalMode = this.mode.value === 'agent-auto' ? 'auto' : 'confirm'; } this.agent.update(); }));
		this.modelButton = this.button(controls, localize('phpcode.chooseModel', 'Выберите модель'), () => this.pickModel(), this._store, 'model-picker');

		const attach = this.button(controls, localize('phpcode.addContext', 'Добавить контекст'), () => this.pickContext(), this._store, 'add-context');
		this.icon(attach, 'attach');
		this.sendButton = this.button(controls, localize('phpcode.send', 'Отправить'), () => this.agent.active.status === 'running' ? this.agent.stop() : this.send(), this._store, 'send');
		this.status = dom.append(composer, $('.phpcode-agent-status', { role: 'status', 'aria-live': 'polite' }));
		const metadata = dom.append(this.rootElement, $('.phpcode-agent-metadata'));
		this.contextButton = this.button(metadata, localize('phpcode.contextBudget', 'Контекст'), () => this.pickContextBudget(), this._store, 'context-budget');
		this.indexButton = this.button(metadata, localize('phpcode.indexLoading', 'Индекс проекта'), () => { this.indexDetails.hidden = !this.indexDetails.hidden; }, this._store, 'index-status');
		const usageDetails = dom.append(metadata, $('details.phpcode-agent-usage-details'));
		dom.append(usageDetails, $('summary', undefined, localize('phpcode.tokens', 'Токены')));
		this.usage = dom.append(usageDetails, $('.phpcode-agent-usage'));
		this.renderAgent();
		// Update clocks without rebuilding the transcript, stealing focus or resetting disclosures.
		this.elapsedTimer = setInterval(() => this.updateElapsed(), 1000);
		this.codeIndex.start();
		void this.agent.hasKey().then(hasKey => { if (!hasKey) { this.settings.hidden = false; } });
	}
	private async send(): Promise<void> {
		try { await this.agent.send(this.input.value); } catch (error) { this.notifications.error(error); if (!await this.agent.hasKey()) { this.settings.hidden = false; this.keyInput.focus(); } }
	}
	private icon(button: HTMLButtonElement, icon: string): void { dom.clearNode(button); dom.append(button, $(`span.codicon.codicon-${icon}`, { 'aria-hidden': 'true' })); }
	private async pickContextBudget(): Promise<void> {
		if (this.agent.active.status === 'running') { return; }
		const model = this.agent.models.find(model => model.id === this.agent.active.model);
		const automatic = localize('phpcode.contextAuto', 'Автоматически по модели');
		const custom = localize('phpcode.contextCustom', 'Указать бюджет…');
		const value = await this.quickInput.pick([
			{ label: automatic, description: model?.contextWindow ? localize('phpcode.providerModelWindow', 'Окно модели: {0} токенов; часть оставлена для ответа.', model.contextWindow) : localize('phpcode.unknownWindow', 'Окно модели неизвестно; временный бюджет 128k.'), budget: 0 },
			...[8000, 16000, 32000, 64000, 128000, 200000, 256000, 512000, 1000000].map(budget => ({ label: `${budget / 1000}k`, budget })),
			{ label: custom, budget: -1 }
		], { ignoreFocusLost: true, placeHolder: localize('phpcode.contextBudgetHelp', 'Входной бюджет контекста, с резервом для ответа модели. Суммаризация автоматически на 80%.') });
		if (!value) { return; }
		let budget = value.budget;
		if (budget < 0) {
			const input = await this.quickInput.input({ ignoreFocusLost: true, prompt: localize('phpcode.customBudget', 'Бюджет в токенах (2000–2000000), ограниченный известным окном модели'), value: String(this.agent.contextBudget()), validateInput: async value => /^\d+$/.test(value) && Number(value) >= 2000 && Number(value) <= 2000000 ? undefined : localize('phpcode.validBudget', 'Введите целое число от 2000 до 2000000.') });
			if (!input) { return; } budget = Number(input);
		}
		this.agent.active.contextBudgetMode = budget === 0 ? 'auto' : 'manual';
		this.agent.active.contextBudget = budget || undefined; this.agent.update();
	}
	private async pickContext(): Promise<void> {
		try {
			const kind = await this.quickInput.pick([{ label: localize('phpcode.fileContext', 'Файл'), kind: 'file' }, { label: localize('phpcode.folderContext', 'Папка'), kind: 'folder' }, { label: localize('phpcode.selection', 'Выделение'), kind: 'selection' }], { ignoreFocusLost: true, placeHolder: localize('phpcode.contextKind', 'Добавить в контекст') });
			if (!kind) { return; }
			if (kind.kind === 'selection') { await this.agent.attachActive(true); this.input.focus(); return; }
			const paths = kind.kind === 'folder' ? await this.agent.listFolders() : await this.agent.listFiles();
			const picked = await this.quickInput.pick(paths.map(path => ({ label: path })), { ignoreFocusLost: true, placeHolder: localize('phpcode.contextPick', 'Выберите файл или папку проекта') });
			if (picked) { if (kind.kind === 'folder') { await this.agent.attachFolder(picked.label); } else { await this.agent.attachPath(picked.label); } this.input.focus(); }
		} catch (error) { this.notifications.error(error); }
	}
	private async pickModel(): Promise<void> {
		const sessionId = this.agent.activeId; const providerId = this.agent.providerId; const providerName = this.agent.providerName;
		if (!this.agent.models.length) {
			try { await this.agent.loadModels(); } catch { /* Manual model IDs remain available when catalog loading fails. */ }
		}
		if (sessionId !== this.agent.activeId || providerId !== this.agent.providerId) { return; }
		const manual = localize('phpcode.manualModel', 'Ввести ID модели');
		const picked = await this.quickInput.pick([...this.agent.models.map(model => ({ label: model.id, description: model.contextWindow ? localize('phpcode.contextWindow', 'Контекст: {0}k', model.contextWindow / 1000) : undefined })), { label: manual }], { ignoreFocusLost: true, placeHolder: localize('phpcode.providerModelPick', 'Выберите модель {0}', providerName) });
		if (!picked || sessionId !== this.agent.activeId || providerId !== this.agent.providerId) { return; }
		if (picked.label === manual) {
			const model = await this.quickInput.input({ ignoreFocusLost: true, prompt: localize('phpcode.providerModelId', 'ID модели {0}', providerName), value: this.agent.active.model, validateInput: async value => value.trim() && value.length < 200 ? undefined : localize('phpcode.validModel', 'Введите ID модели.') });
			if (model && sessionId === this.agent.activeId && providerId === this.agent.providerId) { this.agent.setModel(model.trim()); }
		} else { this.agent.setModel(picked.label); }
	}

	private renderAgent(): void {
		this.renderStore.clear(); this.contentStore.clear(); this.elapsedLabels.length = 0;
		const session = this.agent.active;
		const providerId = this.agent.providerId; const providerName = this.agent.providerName;
		const connection = session.id + ':' + providerId;
		if (connection !== this.renderedConnection) { this.keyInput.value = ''; this.renderedConnection = connection; }
		this.providerButton.textContent = providerName; this.providerButton.setAttribute('aria-label', providerName);
		this.providerButton.title = localize('phpcode.providerSettings', 'Провайдер: {0}. Настройки подключения', providerName);
		this.providerSelect.value = providerId; this.providerSelect.disabled = session.status === 'running';
		this.providerHeading.textContent = localize('phpcode.providerConnection', 'Подключение {0}', providerName);
		this.providerHelp.textContent = localize('phpcode.providerKeyHelp', 'Ключ хранится в защищённом хранилище. Запросы и выбранный контекст этого чата отправляются в {0}. Ключи провайдеров сохраняются отдельно.', providerName);
		this.keyInput.placeholder = localize('phpcode.providerKey', 'API-ключ {0}', providerName);
		this.keyInput.setAttribute('aria-label', this.keyInput.placeholder);
		const index = this.codeIndex.status;
		const phase = index.phase === 'ready' ? (index.limited ? localize('phpcode.indexPartial', 'частичный') : localize('phpcode.indexReady', 'готов')) : index.phase === 'building' ? localize('phpcode.indexBuilding', 'обновляется') : index.phase === 'error' ? localize('phpcode.indexError', 'недоступен') : localize('phpcode.indexIdle', 'ожидание');
		this.indexButton.textContent = localize('phpcode.indexStatus', 'Индекс: {0} · {1} файлов', phase, index.files);
		this.indexButton.dataset.phase = index.phase; this.indexButton.setAttribute('aria-label', this.indexButton.textContent);
		this.indexInfo.textContent = index.message || localize('phpcode.indexScope', 'Файлов: {0}. Фрагментов: {1}.', index.files, index.chunks || 0);
		this.cache.checked = session.cache !== 'off'; this.cache.disabled = session.status === 'running';
		const followBottom = this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 100;
		dom.clearNode(this.tabs);
		for (const chat of this.agent.sessions.filter(s => !s.closed)) {
			const tab = dom.append(this.tabs, $('.phpcode-agent-tab' + (chat.id === session.id ? '.active' : '')));
			const button = this.button(tab, chat.title, () => this.agent.select(chat.id));
			if (chat.status === 'running') { button.prepend(this.spinner()); }
			button.classList.toggle('is-working', chat.status === 'running');
			button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(chat.id === session.id));
			this.button(tab, '×', () => this.agent.close(chat.id), this.renderStore, 'close-chat').setAttribute('aria-label', localize('phpcode.closeChat', 'Закрыть чат {0}', chat.title));
		}
		this.history.hidden = !this.showHistory; dom.clearNode(this.history);
		if (this.showHistory) { this.renderHistory(session); }
		dom.clearNode(this.transcript);
		if (!session.entries.length) {
			const empty = dom.append(this.transcript, $('.phpcode-agent-empty'));
			dom.append(empty, $('div.phpcode-agent-mark', undefined, '✦'));
			dom.append(empty, $('h2', undefined, localize('phpcode.title', 'С чего начнём?')));
			dom.append(empty, $('p', undefined, localize('phpcode.empty', 'Agent изучает проект, предлагает правки и выполняет команды с вашего разрешения. Ask отвечает без изменений.')));
			for (const suggestion of [localize('phpcode.suggest1', 'Объясни структуру проекта'), localize('phpcode.suggest2', 'Найди причину ошибки'), localize('phpcode.suggest3', 'Помоги изменить выбранный файл')]) {
				this.button(empty, suggestion, () => { this.input.value = suggestion; session.draft = suggestion; this.input.focus(); });
			}
		}
		for (let offset = 0; offset < session.entries.length;) {
			const first = session.entries[offset];
			if (first.kind === 'user') { this.renderEntry(this.transcript, first); offset++; }
			const turn: AgentEntry[] = [];
			while (offset < session.entries.length && session.entries[offset].kind !== 'user') { turn.push(session.entries[offset++]); }
			const answer = turn.findLast(entry => entry.kind === 'assistant' && entry.phase !== 'progress');
			const processes = turn.filter(entry => entry !== answer && entry.kind !== 'error');
			const activeTurn = offset === session.entries.length && session.status === 'running';
			if (processes.length || activeTurn) {
				const key = `${session.id}:${first.turnId || offset}`;
				const details = dom.append(this.transcript, $('details.phpcode-agent-processes')) as HTMLDetailsElement;
				details.open = this.folds.get(key) || false;
				const summary = dom.append(details, $('summary.phpcode-agent-process-summary'));
				details.setAttribute('aria-busy', String(activeTurn));
				if (activeTurn && !session.approval) { summary.appendChild(this.spinner()); }
				const title = dom.append(summary, $('span.phpcode-agent-process-label', undefined, localize('phpcode.processes', 'Действия · {0}', processes.length)));
				if (activeTurn) {
					const runningChildren = processes.filter(entry => entry.subagent?.status === 'running').length;
					const current = processes.findLast(entry => entry.state === 'running' && entry.kind !== 'subagent');
					title.textContent = session.approval ? localize('phpcode.processApproval', 'Ожидаю подтверждения') : runningChildren ? localize('phpcode.processChildren', 'Работают субагенты · {0}', runningChildren) : current ? current.text.split('\n')[0] : answer?.state === 'running' ? localize('phpcode.processAnswer', 'Пишу ответ…') : localize('phpcode.processThinking', 'Ожидаю ответа модели…');
					this.elapsed(summary, session.updated);
				}
				for (let index = 0; index < processes.length; index++) { this.renderEntry(details, processes[index], `${key}:${index}`); }
				if (!processes.length) { dom.append(details, $('p.phpcode-agent-process-wait', undefined, localize('phpcode.processWait', 'Запрос выполняется. Здесь появятся действия агента и результаты инструментов.'))); }
				this.renderStore.add(dom.addDisposableListener(details, 'toggle', () => this.folds.set(key, details.open)));
			}
			if (answer) { this.renderEntry(this.transcript, answer); }
			for (const entry of turn.filter(entry => entry.kind === 'error')) { this.renderEntry(this.transcript, entry); }
		}
		if (session.status === 'error' && (session.errorCode === 'step-limit' || session.errorCode === 'repeated-tools')) {
			this.button(this.transcript, localize('phpcode.continueTask', 'Продолжить задачу'), () => this.agent.send(localize('phpcode.continuePrompt', 'Продолжи незавершённую задачу с текущего места. Используй сохранённые выводы и уже прочитанный код, не начинай исследование заново. Выполни оставшиеся правки и проверки либо укажи конкретное препятствие.')), this.renderStore, 'continue-task');
		}

		if (session.id !== this.renderedSession || followBottom) { this.transcript.scrollTop = this.transcript.scrollHeight; }
		dom.clearNode(this.changes);
		const latestChanges = this.agent.changesFor(session);
		const activeChanges = latestChanges.filter(change => change.state === 'pending' || change.state === 'applied');
		this.changes.hidden = !activeChanges.length;
		const changeFold = dom.append(this.changes, $('details.phpcode-agent-change-fold')) as HTMLDetailsElement;
		const changeKey = session.id + ':changes'; changeFold.open = this.folds.get(changeKey) || false;
		const changeSummary = dom.append(changeFold, $('summary'));
		dom.append(changeSummary, $('span', undefined, localize('phpcode.changedFiles', 'Изменения · {0}', activeChanges.length)));
		const review = this.button(changeSummary, localize('phpcode.reviewChanges', 'Просмотр'), async () => { this.folds.set(changeKey, true); changeFold.open = true; for (const change of activeChanges) { await this.agent.review(change); } }, this.renderStore, 'review-changes');
		this.renderStore.add(dom.addDisposableListener(review, 'click', event => { event.preventDefault(); event.stopPropagation(); }));
		this.renderStore.add(dom.addDisposableListener(changeFold, 'toggle', () => this.folds.set(changeKey, changeFold.open)));
		for (const change of latestChanges) {
			const row = dom.append(changeFold, $('.phpcode-agent-change', { 'data-state': change.state }));
			dom.append(row, $('span', undefined, change.path));
			this.iconButton(row, localize('phpcode.diff', 'Diff'), 'diff', () => this.agent.review(change), 'diff-change');
			if (change.state === 'pending') {
				this.button(row, localize('phpcode.apply', 'Применить'), () => this.agent.apply(change), this.renderStore, 'apply-change');
				this.button(row, localize('phpcode.reject', 'Отклонить'), () => { change.state = 'rejected'; this.agent.update(); });
			} else if (change.state === 'applied') {
				this.iconButton(row, localize('phpcode.undo', 'Отменить'), 'discard', () => this.agent.apply(change, true), 'undo-change');
			} else { dom.append(row, $('small', undefined, change.state === 'undone' ? localize('phpcode.undone', 'Отменено') : localize('phpcode.rejected', 'Отклонено'))); }
		}
		dom.clearNode(this.approval); this.approval.hidden = !session.approval;
		if (session.approval) {
			dom.append(this.approval, $('strong', undefined, localize('phpcode.commandApproval', 'Запустить команду в проекте?')));
			dom.append(this.approval, $('pre', undefined, session.approval.command)); const id = session.approval.id;
			this.button(this.approval, localize('phpcode.run', 'Разрешить'), () => this.agent.approve(id, true), this.renderStore, 'approve-command');
			this.button(this.approval, localize('phpcode.decline', 'Отклонить'), () => this.agent.approve(id, false));
		}
		dom.clearNode(this.contexts);
		for (const context of session.contexts) { this.button(this.contexts, (context.kind === 'folder' ? '▸ ' : '') + context.path + ' ×', () => { session.contexts = session.contexts.filter(c => c !== context); this.agent.update(); }); }
		if (this.renderedSession !== session.id || session.status === 'running') { this.input.value = session.draft; }
		this.renderedSession = session.id; const policy = resolveExecutionPolicy(session); this.mode.value = policy.id === 'ask' ? 'ask' : 'agent-' + policy.id; this.mode.disabled = session.status === 'running';
		this.contextButton.textContent = `≈${Math.round(this.agent.contextTokens(session) / 100) / 10}k / ${Math.round(this.agent.contextBudget(session) / 100) / 10}k${session.contextBudgetMode === 'manual' ? '' : ' · Auto'}`; this.contextButton.disabled = session.status === 'running';
		this.modelButton.textContent = session.model || localize('phpcode.chooseModel', 'Выберите модель'); this.modelButton.disabled = session.status === 'running'; this.modelButton.setAttribute('aria-label', localize('phpcode.currentModel', 'Модель: {0}', session.model || localize('phpcode.chooseModel', 'Выберите модель')));
		this.modelButton.title = this.modelButton.getAttribute('aria-label')!;
		this.sendButton.textContent = session.status === 'running' ? localize('phpcode.stop', 'Остановить') : localize('phpcode.send', 'Отправить');
		this.sendButton.setAttribute('aria-label', this.sendButton.textContent);
		this.icon(this.sendButton, session.status === 'running' ? 'primitive-square' : 'arrow-up');
		this.sendButton.disabled = session.status !== 'running' && !session.draft.trim();
		dom.clearNode(this.status);
		if (session.status === 'running' && !session.approval) { this.status.appendChild(this.spinner()); }
		dom.append(this.status, $('span', undefined, session.approval ? localize('phpcode.waiting', 'Ожидаю разрешения') : session.status === 'running' ? localize('phpcode.working', 'Агент работает…') : session.status === 'cancelled' ? localize('phpcode.stopped', 'Остановлено') : session.status === 'error' ? localize('phpcode.failed', 'Запрос не завершён') : session.status === 'completed' ? localize('phpcode.complete', 'Готово') : ''));
		this.status.hidden = session.status === 'idle' && !session.approval;
		this.status.dataset.state = session.status;
		const count = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString();
		this.usage.hidden = !session.usage;
		this.usage.textContent = session.usage ? localize('phpcode.usage', 'Ввод {0} · из кеша {1} · запись кеша {2} · вывод {3}. Данные {4}/{5} запросов.', count(session.usage.inputTokens), count(session.usage.cachedTokens), count(session.usage.cacheWriteTokens), count(session.usage.outputTokens), session.usageReports || 0, session.requestCount || 0) : '';
	}
	private spinner(): HTMLElement {
		const spinner = $('span.phpcode-agent-spinner', { 'aria-hidden': 'true' });
		// Streaming rerenders retain the same visual phase instead of restarting at zero.
		spinner.style.animationDelay = `-${Date.now() % 900}ms`;
		return spinner;
	}
	private elapsed(parent: HTMLElement, started: number, finished?: number): void {
		if (!Number.isFinite(started)) { return; }
		const element = dom.append(parent, $('span.phpcode-agent-elapsed', { 'aria-hidden': 'true' }));
		this.elapsedLabels.push({ element, started, finished });
		this.updateElapsed();
	}
	private updateElapsed(): void {
		for (const item of this.elapsedLabels) {
			const seconds = Math.max(0, Math.floor(((item.finished ?? Date.now()) - item.started) / 1000));
			item.element.textContent = seconds < 60 ? `${seconds}с` : `${Math.floor(seconds / 60)}м ${seconds % 60}с`;
		}
	}
	private renderEntry(parent: HTMLElement, entry: AgentEntry, fallbackKey?: string): void {
		const row = dom.append(parent, $('.phpcode-agent-entry.' + entry.kind));
		row.dataset.state = entry.state || 'done';
		if (entry.kind === 'subagent' && entry.subagent) {
			const child = entry.subagent;
			const details = dom.append(row, $('details.phpcode-agent-subagent')) as HTMLDetailsElement;
			const key = `subagent:${child.id}`;
			details.open = this.folds.get(key) || false;
			details.dataset.status = child.status;
			details.setAttribute('aria-busy', String(child.status === 'running'));
			const summary = dom.append(details, $('summary.phpcode-agent-subagent-summary'));
			if (child.status === 'running') { summary.appendChild(this.spinner()); }
			else { dom.append(summary, $('span.phpcode-agent-state-icon', { 'aria-hidden': 'true' }, child.status === 'error' ? '!' : child.status === 'cancelled' ? '■' : '✓')); }
			dom.append(summary, $('span.phpcode-agent-subagent-name', undefined, child.name));
			const status = child.status === 'running' ? localize('phpcode.childRunning', 'работает') : child.status === 'error' ? localize('phpcode.childError', 'ошибка') : child.status === 'cancelled' ? localize('phpcode.childStopped', 'остановлен') : localize('phpcode.childDone', 'готово');
			dom.append(summary, $('span.phpcode-agent-subagent-status', undefined, status));
			this.elapsed(summary, child.started, child.finished);
			const body = dom.append(details, $('.phpcode-agent-subagent-body'));
			const type = child.type === 'explore' ? localize('phpcode.childExplore', 'Исследование') : child.type === 'shell' ? localize('phpcode.childShell', 'Терминал') : localize('phpcode.childGeneral', 'Разработка');
			const toolCount = child.entries.filter(item => item.kind === 'tool').length;
			dom.append(body, $('div.phpcode-agent-subagent-meta', undefined, localize('phpcode.childMeta', '{0} · {1} · действий: {2}', type, child.model, toolCount)));
			for (let index = 0; index < child.entries.length; index++) { this.renderEntry(body, child.entries[index], `${key}:${index}`); }
			if (!child.entries.length && child.status === 'running') { dom.append(body, $('p.phpcode-agent-process-wait', undefined, localize('phpcode.childStarting', 'Субагент получает задачу…'))); }
			if (child.result && !child.entries.some(item => item.kind === 'assistant' && item.phase !== 'progress' && !!item.text.trim() && child.result!.endsWith(item.text.trim()))) {
				this.renderEntry(body, { kind: 'assistant', createdAt: child.finished || child.started, text: child.result });
			}
			this.renderStore.add(dom.addDisposableListener(details, 'toggle', () => this.folds.set(key, details.open)));
		} else if (entry.kind === 'tool' || entry.kind === 'summary') {
			const details = dom.append(row, $('details')) as HTMLDetailsElement;
			const key = entry.id ? `${fallbackKey || 'root'}:entry:${entry.id}` : fallbackKey;
			if (key) { details.open = this.folds.get(key) || false; this.renderStore.add(dom.addDisposableListener(details, 'toggle', () => this.folds.set(key, details.open))); }
			const summary = dom.append(details, $('summary.phpcode-agent-tool-summary'));
			if (entry.state === 'running') { summary.appendChild(this.spinner()); }
			else { dom.append(summary, $('span.phpcode-agent-state-icon', { 'aria-hidden': 'true' }, entry.state === 'error' ? '!' : entry.state === 'cancelled' ? '■' : '✓')); }
			dom.append(summary, $('span', undefined, entry.text.split('\n')[0]));
			dom.append(details, $('pre', undefined, entry.text.split('\n').slice(1).join('\n')));
		} else if (entry.kind === 'assistant') {
			const md = new MarkdownString(entry.text); md.isTrusted = false; md.supportHtml = false; md.baseUri = this.agent.referenceBaseUri;
			const rendered = this.contentStore.add(this.markdown.render(md, { actionHandler: link => this.openReference(link), sanitizerConfig: { remoteImageIsAllowed: () => false, allowedTags: { override: ['p', 'br', 'pre', 'code', 'span', 'div', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'] } } }));
			row.appendChild(rendered.element);
			this.linkFileReferences(rendered.element);
			const footer = dom.append(row, $('div.phpcode-agent-message-footer'));
			this.iconButton(footer, localize('phpcode.copyAnswer', 'Копировать ответ'), 'copy', () => this.clipboard.writeText(entry.text), 'copy-answer');
			const date = typeof entry.createdAt === 'number' ? new Date(entry.createdAt) : undefined;
			const time = dom.append(footer, $('time.phpcode-agent-message-time')) as HTMLTimeElement;
			if (date && Number.isFinite(date.getTime())) {
				time.dateTime = date.toISOString();
				time.textContent = this.messageDateFormatter.format(date);
				time.title = date.toLocaleString();
			} else { time.textContent = localize('phpcode.unknownAnswerTime', 'Дата не сохранена'); }
		} else { row.textContent = entry.text; }
	}
	private openReference(link: string): void {
		void (async () => {
			if (/^https?:\/\//i.test(link)) { await this.openerService.open(URI.parse(link), { allowCommands: false }); }
			else if (!/^[a-z][a-z\d+.-]*:/i.test(link) || /^(?:file|vscode-remote):/i.test(link)) { await this.agent.openFileReference(decodeURIComponent(link)); }
		})().catch(error => this.notifications.error(error));
	}
	private linkFileReferences(element: HTMLElement): void {
		const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		while (walker.nextNode()) { const node = walker.currentNode as Text; if (!node.parentElement?.closest('a, pre')) { nodes.push(node); } }
		for (const node of nodes) {
			const text = node.textContent || ''; const references = findFileReferences(text);
			if (!references.length) { continue; }
			const fragment = element.ownerDocument.createDocumentFragment(); let offset = 0;
			for (const reference of references) {
				fragment.append(text.slice(offset, reference.start));
				const target = text.slice(reference.start, reference.end);
				const link = dom.$('a.phpcode-agent-file-link', { href: '#', 'aria-label': localize('phpcode.openReferencedFile', 'Открыть {0}', target) }, target);
				this.contentStore.add(dom.addDisposableListener(link, 'click', event => { event.preventDefault(); event.stopPropagation(); void this.agent.openFileReference(target).catch(error => this.notifications.error(error)); }));
				fragment.append(link); offset = reference.end;
			}
			fragment.append(text.slice(offset)); node.replaceWith(fragment);
		}
	}
	private renderHistory(active: AgentSession): void {
		dom.append(this.history, $('strong', undefined, localize('phpcode.historyTitle', 'Недавние чаты')));
		const search = dom.append(this.history, $('input', { placeholder: localize('phpcode.searchChats', 'Найти чат'), 'aria-label': localize('phpcode.searchChats', 'Найти чат') })) as HTMLInputElement;
		const list = dom.append(this.history, $('.phpcode-agent-history-list'));
		for (const chat of [...this.agent.sessions].sort((a, b) => b.updated - a.updated)) {
			const row = dom.append(list, $('.phpcode-agent-history-item'));
			this.button(row, chat.title, () => { this.agent.select(chat.id); this.showHistory = false; this.renderAgent(); });
			dom.append(row, $('small', undefined, chat.closed ? localize('phpcode.closed', 'Закрыт · восстановить') : chat.id === active.id ? localize('phpcode.current', 'Текущий') : localize('phpcode.open', 'Открыт')));
			row.dataset.title = chat.title.toLocaleLowerCase();
		}
		this.renderStore.add(dom.addDisposableListener(search, 'input', () => { for (const row of Array.from(list.children) as HTMLElement[]) { row.hidden = !row.dataset.title?.includes(search.value.toLocaleLowerCase()); } }));
	}
	protected override layoutBody(height: number, width: number): void { super.layoutBody(height, width); if (this.rootElement) { this.rootElement.style.height = `${height}px`; } }
	override focus(): void { super.focus(); this.input?.focus(); }
	override dispose(): void { if (this.timer) { clearTimeout(this.timer); } if (this.elapsedTimer) { clearInterval(this.elapsedTimer); } super.dispose(); }
}
