/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

export const AGENT_CONSOLE_VIEW_ID = 'phpcode.agent.console.view';
export const IPhpcodeAgentTerminalService = createDecorator<PhpcodeAgentTerminalService>('phpcodeAgentTerminalService');
const HISTORY_KEY = 'phpcode.agent.commands.v1';
const MAX_OUTPUT = 64000;

export interface AgentCommandRecord {
	id: string;
	sessionId: string;
	sessionTitle: string;
	command: string;
	cwd: string;
	started: number;
	ended?: number;
	state: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'interrupted';
	output: string;
	truncated?: boolean;
	exitCode?: number;
}

/** Hidden transient PTYs execute commands; a bounded workspace journal supplies the shared console. */
export class PhpcodeAgentTerminalService extends Disposable {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	readonly records: AgentCommandRecord[] = [];
	private readonly running = new Map<string, AbortController>();
	private readonly saveLater = this._register(new RunOnceScheduler(() => this.save(), 1000));

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalProfileResolverService private readonly profiles: ITerminalProfileResolverService,
		@IViewsService private readonly views: IViewsService,
		@IRemoteAgentService private readonly remoteAgent: IRemoteAgentService,
	) {
		super();
		try {
			const saved = JSON.parse(storage.get(HISTORY_KEY, StorageScope.WORKSPACE, '[]')) as AgentCommandRecord[];
			if (Array.isArray(saved)) {
				for (const record of saved.slice(-100)) {
					if (typeof record.id !== 'string' || typeof record.command !== 'string' || typeof record.cwd !== 'string' || typeof record.output !== 'string' || typeof record.sessionTitle !== 'string' || !Number.isFinite(record.started) || !['running', 'completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(record.state)) { continue; }
					this.records.push({ ...record, command: record.command.slice(0, 8000), output: record.output.slice(-MAX_OUTPUT), state: record.state === 'running' ? 'interrupted' : record.state });
				}
			}
		} catch { /* A broken journal must not prevent commands from running. */ }
		this.trim();
		this._register(storage.onWillSaveState(() => this.save()));
	}

	private trim(): void {
		let size = this.records.reduce((sum, record) => sum + record.command.length + record.output.length, 0);
		while (this.records.length > 100 || size > 2_000_000) {
			const index = this.records.findIndex(record => record.state !== 'running');
			if (index < 0) { break; }
			const [removed] = this.records.splice(index, 1); size -= removed.command.length + removed.output.length;
		}
	}
	private save(): void {
		this.trim();
		this.storage.store(HISTORY_KEY, JSON.stringify(this.records), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
	clearCompleted(): void {
		for (let index = this.records.length - 1; index >= 0; index--) { if (this.records[index].state !== 'running') { this.records.splice(index, 1); } }
		this.save(); this.changed.fire();
	}
	stop(id: string): void { this.running.get(id)?.abort(); }

	async run(command: string, cwd: URI, session: { id: string; title: string }, signal: AbortSignal): Promise<string> {
		if (signal.aborted) { return 'Command cancelled before launch.'; }
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal.addEventListener('abort', cancel, { once: true });
		const record: AgentCommandRecord = { id: generateUuid(), sessionId: session.id, sessionTitle: session.title, command, cwd: cwd.scheme === 'file' ? cwd.fsPath : cwd.toString(), started: Date.now(), state: 'running', output: '' };
		this.running.set(record.id, controller); this.records.push(record); this.save(); this.changed.fire();
		// Preserve editor focus while making the command journal visible in the bottom panel.
		void this.views.openView(AGENT_CONSOLE_VIEW_ID, false).catch(() => { /* Execution does not depend on the console being visible. */ });
		try {
			const remote = cwd.scheme === 'vscode-remote' ? await this.remoteAgent.getEnvironment() : undefined;
			const operatingSystem = remote?.os ?? OS;
			const shell = await this.profiles.getDefaultShell({ remoteAuthority: cwd.scheme === 'vscode-remote' ? cwd.authority : undefined, os: operatingSystem });
			if (controller.signal.aborted) { record.state = 'cancelled'; return 'Command cancelled before launch.'; }
			const args = operatingSystem === OperatingSystem.Windows ? (/cmd(?:\.exe)?$/i.test(shell) ? ['/d', '/c', command] : ['-NoProfile', '-NonInteractive', '-Command', command]) : ['-lc', command];
			// These PTYs have no user input surface. Git otherwise sees a TTY and opens
			// its pager, waiting forever at (END). Scope overrides to agent processes,
			// including remote/container shells, without changing user terminal settings.
			const env = { GIT_PAGER: 'cat', PAGER: 'cat', MANPAGER: 'cat', SYSTEMD_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
			const terminal = await this.terminals.createTerminal({ config: { name: 'phpcode Agent', executable: shell, args, env, hideFromUser: true, isFeatureTerminal: true, isTransient: true, waitOnExit: false }, cwd });
			return await new Promise<string>(resolve => {
				const store = new DisposableStore(); let done = false; let raw = '';
				const finish = (state: AgentCommandRecord['state'], code?: number) => {
					if (done) { return; } done = true;
					clearTimeout(timer); controller.signal.removeEventListener('abort', abort); store.dispose();
					record.state = state; record.exitCode = code;
					if (!terminal.isDisposed) { terminal.dispose(); }
					const result = state === 'cancelled' ? 'Command cancelled by the user. Do not retry without a new request.' : state === 'timeout' ? 'Command timed out after 120 seconds.' : `Exit: ${code ?? 'unknown'}`;
					resolve(result + '\n' + record.output.slice(-22000) + (record.truncated || record.output.length > 22000 ? '\n[Output limited. Full retained output is available in the Agent Commands panel.]' : ''));
				};
				const abort = () => finish('cancelled');
				const timer = setTimeout(() => finish('timeout'), 120000);
				store.add(terminal.onData(data => {
					raw += data;
					if (raw.length > MAX_OUTPUT) { raw = raw.slice(-MAX_OUTPUT); record.truncated = true; }
					record.output = removeAnsiEscapeCodes(raw).replace(/\r\n?/g, '\n'); this.changed.fire();
					if (!this.saveLater.isScheduled()) { this.saveLater.schedule(); }
				}));
				store.add(terminal.onExit(code => finish(typeof code === 'number' && code === 0 ? 'completed' : 'failed', typeof code === 'number' ? code : undefined)));
				store.add(terminal.onDisposed(() => finish(controller.signal.aborted ? 'cancelled' : 'failed')));
				controller.signal.addEventListener('abort', abort, { once: true });
				if (controller.signal.aborted) { abort(); }
				else if (terminal.exitCode !== undefined || terminal.exitReason !== undefined || terminal.isDisposed) { finish(terminal.exitCode === 0 ? 'completed' : 'failed', terminal.exitCode); }
			});
		} catch {
			record.state = controller.signal.aborted ? 'cancelled' : 'failed';
			return record.state === 'cancelled' ? 'Command cancelled before launch.' : 'Command could not be started. Check the configured shell and workspace availability.';
		} finally {
			signal.removeEventListener('abort', cancel); this.running.delete(record.id); record.ended = Date.now(); this.save(); this.changed.fire();
		}
	}
	override dispose(): void {
		for (const controller of this.running.values()) { controller.abort(); }
		this.save(); super.dispose();
	}
}
