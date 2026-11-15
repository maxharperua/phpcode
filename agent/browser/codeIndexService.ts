/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { match } from '../../../../base/common/glob.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { extUri, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IFileService, IFileStatWithPartialMetadata } from '../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { CodeIndex, CodeMatch } from '../common/codeIndex.js';

export interface CodeIndexStatus {
	readonly phase: 'idle' | 'building' | 'ready' | 'error';
	readonly files: number;
	readonly chunks?: number;
	readonly updated?: number;
	readonly limited?: boolean;
	readonly bytes?: number;
	readonly message?: string;
}

export const IPhpcodeCodeIndexService = createDecorator<PhpcodeCodeIndexService>('phpcodeCodeIndexService');
const maxFiles = 3000;
const maxFileBytes = 200000;
const maxCorpusBytes = 20 * 1024 * 1024;
const indexOptions = { maxFiles, maxChunks: 20000, maxFileCharacters: maxFileBytes, maxTotalCharacters: maxCorpusBytes };
const excludedDirectories = new Set(['.git', '.phpcode-server', '.vscode-server', '.cursor-server', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.output', '.turbo', '.parcel-cache']);
const secretNames = new Set(['.npmrc', '.netrc', '.pypirc', '.dockercfg', '.yarnrc.yml', 'auth.json', 'credentials', 'credentials.json', '.ssh', '.aws', '.azure', '.gcloud', '.kube']);
const binaryExtension = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|pdf|mp[34]|mov|webm|wav|ogg|flac|zip|gz|bz2|xz|7z|tar|rar|jar|war|phar|woff2?|ttf|eot|otf|sqlite3?|db|exe|dll|dylib|so|a|o|class|pyc|pyo|wasm|map|lock|pem|key|p12|pfx|jks|keystore)$/i;

/** Indexing policy is deliberately stricter than explicit file attachments. */
export function isIndexableCodePath(path: string): boolean {
	if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0') || binaryExtension.test(path) || /\.min\.(?:js|css)$/i.test(path)) { return false; }
	return path.split('/').every(part => {
		const name = part.toLowerCase();
		return !!name && name !== '.' && name !== '..' && !excludedDirectories.has(name) && !secretNames.has(name) && !/^\.env/i.test(name) && !/^id_(?:rsa|dsa|ecdsa|ed25519)/i.test(name) && !/(?:^|[._-])(?:secrets?|credentials?|service-account)(?:[._-]|$)/i.test(name);
	});
}

interface IgnoreRule { readonly pattern: string; readonly negated: boolean }

/** Root .phpcodeignore supports ordered glob rules and ! exceptions. */
function ignored(path: string, rules: readonly IgnoreRule[]): boolean {
	let result = false;
	for (const rule of rules) {
		if (match(rule.pattern, path) || match(`${rule.pattern}/**`, path)) { result = !rule.negated; }
	}
	return result;
}

/** Local lexical index; no source code is sent to a network service while indexing. */
export class PhpcodeCodeIndexService extends Disposable {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private currentStatus: CodeIndexStatus = { phase: 'idle', files: 0, chunks: 0 };
	get status(): CodeIndexStatus { return this.currentStatus; }
	private diskIndex = new CodeIndex(indexOptions);
	private liveIndex = new CodeIndex(indexOptions);
	private readonly modelListeners = this._register(new DisposableMap<string, IDisposable>());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => { void this.refresh(false); }, 700));
	private readonly overlayScheduler = this._register(new RunOnceScheduler(() => this.updateOverlays(), 200));
	private readonly queryBuilder: QueryBuilder;
	private operation: Promise<void> | undefined;
	private cancellation: CancellationTokenSource | undefined;
	private readonly changedPaths = new Set<string>();
	private readonly fileBytes = new Map<string, number>();
	private eligiblePaths = new Set<string>();
	private readonly overlaidPaths = new Set<string>();
	private needsRefresh = false;
	private forceRefresh = false;
	private initialized = false;
	private started = false;
	private disposed = false;
	private epoch = 0;
	private totalBytes = 0;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@IFileService private readonly files: IFileService,
		@IModelService private readonly models: IModelService,
		@ITextFileService private readonly textFiles: ITextFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkbenchEnvironmentService private readonly environment: IWorkbenchEnvironmentService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.queryBuilder = instantiation.createInstance(QueryBuilder);
		this._register(files.onDidFilesChange(event => {
			if (!this.started) { return; }
			const root = this.root();
			if (!root) { return; }
			let relevant = false;
			for (const resource of [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]) {
				if (!extUri.isEqualOrParent(resource, root)) { continue; }
				const path = relativePath(root, resource);
				if (path && (isIndexableCodePath(path) || /(?:^|\/)\.(?:gitignore|phpcodeignore)$/.test(path))) {
					this.changedPaths.add(path);
					relevant = true;
				}
			}
			if (relevant) { this.refreshScheduler.schedule(); }
		}));
		this._register(textFiles.files.onDidSave(event => {
			const root = this.root();
			const path = root && relativePath(root, event.model.resource);
			if (this.started && path && isIndexableCodePath(path)) { this.changedPaths.add(path); this.refreshScheduler.schedule(); }
		}));
		this._register(models.onModelAdded(model => this.trackModel(model)));
		this._register(models.onModelRemoved(model => { this.modelListeners.deleteAndDispose(model.uri.toString()); this.overlayScheduler.schedule(); }));
		for (const model of models.getModels()) { this.trackModel(model); }
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.reset()));
		this._register(trust.onDidChangeTrust(() => this.reset()));
	}

	start(): void {
		if (this.started || this.disposed) { return; }
		this.started = true;
		void this.ensureReady().catch(() => { /* Status reports indexing failures; disposal can cancel startup. */ });
	}

	async ensureReady(): Promise<void> {
		if (this.disposed) { throw canceled(); }
		this.started = true;
		if (!this.initialized || this.refreshScheduler.isScheduled()) {
			this.refreshScheduler.cancel();
			await this.refresh(false);
		} else {
			await this.operation;
		}
	}

	async rebuild(): Promise<void> {
		this.started = true;
		this.refreshScheduler.cancel();
		await this.refresh(true);
	}

	async search(query: string, signal?: AbortSignal): Promise<CodeMatch[]> {
		if (signal?.aborted) { throw canceled(); }
		const ready = this.ensureReady();
		if (signal) {
			await new Promise<void>((resolve, reject) => {
				const abort = () => { signal.removeEventListener('abort', abort); reject(canceled()); };
				signal.addEventListener('abort', abort, { once: true });
				ready.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error); });
				if (signal.aborted) { abort(); }
			});
		} else { await ready; }
		if (signal?.aborted || this.disposed) { throw canceled(); }
		if (!this.initialized || this.currentStatus.phase === 'error' || !this.trust.isWorkspaceTrusted() || !this.root()) { return []; }
		this.overlayScheduler.cancel();
		this.updateOverlays();
		return this.liveIndex.search(query, { limit: 6, maxCharacters: 12000 });
	}

	private root(): URI | undefined { return this.workspace.getWorkspace().folders[0]?.uri; }

	private setStatus(status: CodeIndexStatus): void {
		if (!this.disposed) { this.currentStatus = status; this.changed.fire(); }
	}

	private reset(): void {
		this.epoch++;
		this.cancellation?.cancel();
		this.initialized = false;
		this.diskIndex = new CodeIndex(indexOptions); this.liveIndex = new CodeIndex(indexOptions);
		this.fileBytes.clear(); this.overlaidPaths.clear(); this.eligiblePaths.clear(); this.totalBytes = 0;
		this.setStatus({ phase: 'idle', files: 0, chunks: 0 });
		if (this.started) { this.refreshScheduler.schedule(); }
	}

	private trackModel(model: ITextModel): void {
		const root = this.root();
		const path = root && relativePath(root, model.uri);
		if (!path || !isIndexableCodePath(path)) { return; }
		const listener = model.onDidChangeContent(() => { if (this.started) { this.overlayScheduler.schedule(); } });
		this.modelListeners.set(model.uri.toString(), listener);
	}

	private updateOverlays(): void {
		if (!this.initialized || !this.trust.isWorkspaceTrusted() || this.disposed) { return; }
		const root = this.root();
		if (!root) { return; }
		const dirty = new Map<string, ITextModel>();
		for (const model of this.models.getModels()) {
			const path = relativePath(root, model.uri);
			if (path && this.eligiblePaths.has(path) && this.textFiles.isDirty(model.uri) && !model.isDisposed()) { dirty.set(path, model); }
		}
		const baseline = new Map(this.diskIndex.serialize().files.map(file => [file.path, file]));
		for (const path of this.overlaidPaths) {
			if (!dirty.has(path)) {
				const saved = baseline.get(path);
				if (saved) { this.liveIndex.replaceFile(path, saved.content, saved.fingerprint); } else { this.liveIndex.removeFile(path); }
				this.overlaidPaths.delete(path);
			}
		}
		for (const [path, model] of dirty) {
			const text = model.getValue();
			if (!text.includes('\0') && VSBuffer.fromString(text).byteLength <= maxFileBytes) {
				this.liveIndex.replaceFile(path, text, `dirty:${model.getVersionId()}`);
			} else { this.liveIndex.removeFile(path); }
			this.overlaidPaths.add(path);
		}
	}

	private refresh(force: boolean): Promise<void> {
		if (this.disposed) { return Promise.resolve(); }
		this.needsRefresh = true;
		this.forceRefresh ||= force;
		if (!this.operation) {
			this.operation = (async () => {
				while (this.needsRefresh && !this.disposed) {
					const rebuild = this.forceRefresh; this.forceRefresh = false; this.needsRefresh = false;
					try { await this.refreshOnce(rebuild); } catch (error) {
						if (!isCancellationError(error)) { this.setStatus({ phase: 'error', files: this.diskIndex.fileCount, chunks: this.diskIndex.chunkCount, message: localize('phpcode.indexError', 'Не удалось обновить локальный индекс. Повторите индексацию.') }); }
					}
				}
			})().finally(() => { this.operation = undefined; });
		}
		return this.operation;
	}

	private cacheResource(): URI {
		return URI.joinPath(this.environment.workspaceStorageHome, this.workspace.getWorkspace().id, 'phpcode', 'code-index-v1.json');
	}

	private async loadCache(root: URI, epoch: number): Promise<void> {
		try {
			const resource = this.cacheResource();
			if (!await this.files.exists(resource) || (await this.files.stat(resource)).size > 64 * 1024 * 1024) { return; }
			const payload = JSON.parse((await this.files.readFile(resource)).value.toString()) as { version?: number; root?: string; index?: unknown };
			if (!payload || payload.version !== 1 || payload.root !== root.toString()) { return; }
			const index = CodeIndex.restore(payload.index, indexOptions);
			let bytes = 0;
			const fileBytes = new Map<string, number>();
			for (const file of index.serialize().files) {
				if (!isIndexableCodePath(file.path)) { index.removeFile(file.path); continue; }
				const size = VSBuffer.fromString(file.content).byteLength;
				bytes += size;
				if (size > maxFileBytes || bytes > maxCorpusBytes) { return; }
				fileBytes.set(file.path, size);
			}
			if (this.disposed || epoch !== this.epoch || !this.trust.isWorkspaceTrusted() || this.root()?.toString() !== root.toString()) { return; }
			this.fileBytes.clear(); for (const [path, size] of fileBytes) { this.fileBytes.set(path, size); }
			this.diskIndex = index;
			this.liveIndex = CodeIndex.restore(index.serialize(), indexOptions);
			this.totalBytes = bytes;
		} catch { /* Missing, incompatible or corrupt caches are rebuilt from the workspace. */ }
	}

	private async ignoreRules(root: URI): Promise<IgnoreRule[]> {
		const resource = URI.joinPath(root, '.phpcodeignore');
		if (!await this.files.exists(resource)) { return []; }
		const stat = await this.files.stat(resource);
		if (stat.isSymbolicLink || stat.size > maxFileBytes) { return []; }
		const real = await this.files.realpath(resource);
		const rootReal = await this.files.realpath(root);
		if (!real || !rootReal || !extUri.isEqualOrParent(real, rootReal)) { return []; }
		const rules: IgnoreRule[] = [];
		for (let line of (await this.files.readFile(resource)).value.toString().split(/\r?\n/).slice(0, 1000)) {
			line = line.trim();
			if (!line || line.startsWith('#')) { continue; }
			const negated = line.startsWith('!');
			if (negated) { line = line.slice(1); }
			const anchored = line.startsWith('/');
			line = line.replace(/^\/+|\/+$/g, '');
			if (!line || line.length > 1000) { continue; }
			rules.push({ pattern: anchored || line.includes('/') ? line : `**/${line}`, negated });
		}
		return rules;
	}

	private async refreshOnce(force: boolean): Promise<void> {
		const root = this.root();
		if (!root || !this.trust.isWorkspaceTrusted()) {
			this.setStatus({ phase: 'idle', files: 0, chunks: 0, message: localize('phpcode.indexTrust', 'Откройте доверенный проект для локальной индексации.') });
			return;
		}
		const epoch = this.epoch;
		const cancellation = this.cancellation = new CancellationTokenSource();
		const check = () => { if (this.disposed || cancellation.token.isCancellationRequested || epoch !== this.epoch || !this.trust.isWorkspaceTrusted()) { throw canceled(); } };
		try {
			this.setStatus({ phase: 'building', files: this.diskIndex.fileCount, chunks: this.diskIndex.chunkCount });
			if (!this.initialized && !force) { await this.loadCache(root, epoch); }
			check();
			if (force) { this.diskIndex = new CodeIndex(indexOptions); this.liveIndex = new CodeIndex(indexOptions); this.fileBytes.clear(); this.overlaidPaths.clear(); this.totalBytes = 0; }
			const rootStat = await this.files.stat(root);
			const rootReal = await this.files.realpath(root);
			if (rootStat.isSymbolicLink || !rootReal) { throw new Error('invalid-root'); }
			const rules = await this.ignoreRules(root);
			const result = await this.searchService.fileSearch(this.queryBuilder.file([root], {
				maxResults: maxFiles * 4 + 1, ignoreSymlinks: true,
				excludePattern: [{ pattern: `**/{${[...excludedDirectories].join(',')}}/**` }]
			}), cancellation.token);
			check();
			const paths = [...new Set(result.results.map(file => relativePath(root, file.resource)).filter((path): path is string => !!path && isIndexableCodePath(path) && !ignored(path, rules)))].sort();
			this.eligiblePaths = new Set(paths.slice(0, maxFiles));
			let limited = !!result.limitHit || paths.length > maxFiles;
			for (const path of this.diskIndex.listPaths()) { if (!this.eligiblePaths.has(path)) { this.remove(path); } }
			const changed = [...this.changedPaths]; this.changedPaths.clear();
			const verifiedParents = new Map<string, Promise<void>>();
			const verifyParents = async (path: string) => {
				const parts = path.split('/'); parts.pop(); let parent = root;
				for (const part of parts) {
					parent = URI.joinPath(parent, part);
					const key = parent.toString();
					let verified = verifiedParents.get(key);
					if (!verified) {
						const resource = parent;
						verified = (async () => { const stat = await this.files.stat(resource); const real = await this.files.realpath(resource); if (stat.isSymbolicLink || !real || !extUri.isEqualOrParent(real, rootReal)) { throw new Error('unsafe-path'); } })();
						verifiedParents.set(key, verified);
					}
					await verified;
				}
			};
			const pending = [...this.eligiblePaths];
			let next = 0;
			const worker = async () => {
				while (next < pending.length) {
					check();
					const path = pending[next++];
					try {
						await verifyParents(path); check();
						const resource = URI.joinPath(root, path);
						const stat: IFileStatWithPartialMetadata = await this.files.stat(resource);
						const real = await this.files.realpath(resource);
						check();
						if (!stat.isFile || stat.isSymbolicLink || !real || !extUri.isEqualOrParent(real, rootReal) || stat.size > maxFileBytes) { this.remove(path); continue; }
						const prefix = `${stat.mtime}:${stat.size}:${stat.etag}:`;
						if (!force && !changed.some(item => path === item || path.startsWith(`${item}/`)) && this.diskIndex.getFingerprint(path)?.startsWith(prefix)) { continue; }
						const content = await this.files.readFile(resource, { limits: { size: maxFileBytes } }, cancellation.token);
						check();
						const text = content.value.toString();
						if (content.value.byteLength > maxFileBytes || text.includes('\0')) { this.remove(path); continue; }
						const bytes = content.value.byteLength;
						const newTotal = this.totalBytes - (this.fileBytes.get(path) || 0) + bytes;
						if (newTotal > maxCorpusBytes) { limited = true; this.remove(path); continue; }
						const fingerprint = prefix + hash(text);
						this.diskIndex.replaceFile(path, text, fingerprint);
						if (this.diskIndex.getFingerprint(path) !== fingerprint) { limited = true; this.remove(path); continue; }
						this.totalBytes = newTotal; this.fileBytes.set(path, bytes);
						this.liveIndex.replaceFile(path, text, fingerprint);
					} catch (error) { if (isCancellationError(error)) { throw error; } this.remove(path); }
				}
			};
			await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
			check();
			this.initialized = true;
			this.updateOverlays();
			const updated = Date.now();
			const resource = this.cacheResource();
			await this.files.createFolder(URI.joinPath(resource, '..'));
			check();
			await this.files.writeFile(resource, VSBuffer.fromString(JSON.stringify({ version: 1, root: root.toString(), updated, limited, index: this.diskIndex.serialize() })));
			check();
			this.setStatus({ phase: 'ready', files: this.diskIndex.fileCount, chunks: this.diskIndex.chunkCount, bytes: this.totalBytes, updated, limited, message: limited ? localize('phpcode.indexLimited', 'Частичный индекс: предел 3000 файлов, 20 МБ или 20000 фрагментов.') : undefined });
		} finally {
			if (this.cancellation === cancellation) { this.cancellation = undefined; }
			cancellation.dispose();
		}
	}

	private remove(path: string): void {
		this.diskIndex.removeFile(path); this.liveIndex.removeFile(path); this.overlaidPaths.delete(path);
		this.totalBytes -= this.fileBytes.get(path) || 0; this.fileBytes.delete(path);
	}

	override dispose(): void {
		this.disposed = true;
		this.cancellation?.cancel();
		super.dispose();
	}
}

