/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface CodeMatch {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	score: number;
}

export interface CodeIndexOptions {
	maxFiles?: number;
	maxChunks?: number;
	maxFileCharacters?: number;
	maxTotalCharacters?: number;
}

export interface CodeIndexSnapshot {
	version: 1;
	files: { path: string; content: string; fingerprint?: string }[];
}

interface IndexedFile {
	content: string;
	fingerprint?: string;
	chunkIds: number[];
}

interface IndexedChunk {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	length: number;
	terms: string[];
	pathTerms: Set<string>;
	symbolTerms: Set<string>;
}

interface PreparedChunk {
	chunk: IndexedChunk;
	frequencies: Map<string, number>;
}

const MAX_CHUNK_CHARACTERS = 3000;
const MAX_CHUNK_LINES = 80;
const OVERLAP_LINES = 10;
const MAX_TERMS_PER_CHUNK = 400;
const MAX_QUERY_TERMS = 32;

function limit(value: number | undefined, fallback: number, maximum: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}

function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Include complete identifiers and their camel/snake/path components. */
function tokens(text: string): string[] {
	const result: string[] = [];
	for (const match of text.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*|\p{N}+/gu)) {
		const identifier = match[0];
		const complete = identifier.toLowerCase();
		if (complete.length <= 128) {
			result.push(complete);
		}
		const parts = identifier.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2').replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2').split(/[_$\s]+/u).map(part => part.toLowerCase()).filter(part => part.length > 0 && part.length <= 128);
		if (parts.length > 1) {
			result.push(...parts);
		}
	}
	return result;
}

function lineStarts(content: string): number[] {
	const starts = [0];
	for (const match of content.matchAll(/\r\n|\r|\n/g)) {
		starts.push(match.index + match[0].length);
	}
	return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (starts[middle] <= offset) { low = middle + 1; } else { high = middle; }
	}
	return Math.max(0, low - 1);
}

function symbolTokens(text: string): Set<string> {
	const result = new Set<string>();
	for (const match of text.matchAll(/\b(?:class|interface|trait|enum|function|def|fn|func|struct|type|const|let|var|namespace)\s+&?\s*([\p{L}_$][\p{L}\p{N}_$]*)/gu)) {
		for (const term of tokens(match[1])) { result.add(term); }
	}
	return result;
}

function prepareChunks(path: string, content: string): PreparedChunk[] {
	const starts = lineStarts(content);
	const pathTerms = new Set(tokens(path));
	const result: PreparedChunk[] = [];
	let offset = 0;
	do {
		const firstLine = lineAt(starts, offset);
		const lineBoundary = starts[firstLine + MAX_CHUNK_LINES] ?? content.length;
		let end = Math.min(content.length, lineBoundary, offset + MAX_CHUNK_CHARACTERS);
		if (end < lineBoundary && end < content.length) {
			const previousLineStart = starts[lineAt(starts, end)];
			if (previousLineStart > offset) { end = previousLineStart; }
		}
		// Keep a UTF-16 surrogate pair together when an extremely long line is split.
		if (end > offset && end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) { end--; }
		const text = content.slice(offset, end);
		const lastLine = lineAt(starts, Math.max(offset, end - 1));
		const symbols = symbolTokens(text);
		const frequencies = new Map<string, number>();
		const add = (term: string, weight: number) => {
			if (frequencies.has(term) || frequencies.size < MAX_TERMS_PER_CHUNK) {
				frequencies.set(term, (frequencies.get(term) ?? 0) + weight);
			}
		};
		// Admit names before body terms so large chunks cannot evict their own identity.
		for (const term of pathTerms) { add(term, 6); }
		for (const term of symbols) { add(term, 4); }
		const bodyTokens = tokens(text);
		for (const term of bodyTokens) { add(term, 1); }
		result.push({ chunk: { path, startLine: firstLine + 1, endLine: lastLine + 1, text, length: Math.max(1, bodyTokens.length), terms: [...frequencies.keys()], pathTerms, symbolTerms: symbols }, frequencies });
		if (end >= content.length) { break; }
		const overlap = starts[Math.max(firstLine + 1, lastLine - OVERLAP_LINES + 1)];
		offset = overlap > offset && overlap < end ? overlap : end;
	} while (offset < content.length);
	return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validPath(path: string): boolean {
	return path.length > 0 && path.length <= 4096 && !path.includes('\0');
}

function truncatedEndLine(startLine: number, text: string): number {
	const breaks = [...text.matchAll(/\r\n|\r|\n/g)];
	const trailingBreak = breaks.at(-1);
	return startLine + breaks.length - (trailingBreak && trailingBreak.index + trailingBreak[0].length === text.length ? 1 : 0);
}

/** Local lexical retrieval over identifiers and declaration names; no embeddings or filesystem access. */
export class CodeIndex {
	private readonly files = new Map<string, IndexedFile>();
	private readonly chunks = new Map<number, IndexedChunk>();
	private readonly postings = new Map<string, Map<number, number>>();
	private readonly limits: Required<CodeIndexOptions>;
	private nextChunkId = 0;
	private documentLength = 0;
	private sourceCharacters = 0;

	constructor(options: CodeIndexOptions = {}) {
		this.limits = {
			maxFiles: limit(options.maxFiles, 2000, 10000),
			maxChunks: limit(options.maxChunks, 20000, 50000),
			maxFileCharacters: limit(options.maxFileCharacters, 200000, 1000000),
			maxTotalCharacters: limit(options.maxTotalCharacters, 20000000, 100000000)
		};
	}

	get fileCount(): number { return this.files.size; }
	get chunkCount(): number { return this.chunks.size; }
	getFingerprint(path: string): string | undefined { return this.files.get(path)?.fingerprint; }
	listPaths(): string[] { return [...this.files.keys()].sort(comparePath); }

	/** Atomically replace a file; false means unchanged or not admitted by configured limits. */
	replaceFile(path: string, content: string, fingerprint?: string): boolean {
		if (!validPath(path) || content.length > this.limits.maxFileCharacters || (fingerprint !== undefined && fingerprint.length > 2048)) { return false; }
		const previous = this.files.get(path);
		if (previous?.content === content) {
			if (previous.fingerprint === fingerprint) { return false; }
			previous.fingerprint = fingerprint;
			return true;
		}
		if ((!previous && this.files.size >= this.limits.maxFiles) || this.sourceCharacters - (previous?.content.length ?? 0) + content.length > this.limits.maxTotalCharacters) { return false; }
		const prepared = prepareChunks(path, content);
		if (this.chunks.size - (previous?.chunkIds.length ?? 0) + prepared.length > this.limits.maxChunks) { return false; }
		this.removeFile(path);
		const chunkIds: number[] = [];
		for (const { chunk, frequencies } of prepared) {
			const id = this.nextChunkId++;
			chunkIds.push(id); this.chunks.set(id, chunk); this.documentLength += chunk.length;
			for (const [term, frequency] of frequencies) {
				let posting = this.postings.get(term);
				if (!posting) { posting = new Map(); this.postings.set(term, posting); }
				posting.set(id, frequency);
			}
		}
		this.files.set(path, { content, fingerprint, chunkIds });
		this.sourceCharacters += content.length;
		return true;
	}

	removeFile(path: string): boolean {
		const file = this.files.get(path);
		if (!file) { return false; }
		for (const id of file.chunkIds) {
			const chunk = this.chunks.get(id)!;
			for (const term of chunk.terms) {
				const posting = this.postings.get(term)!;
				posting.delete(id);
				if (!posting.size) { this.postings.delete(term); }
			}
			this.documentLength -= chunk.length; this.chunks.delete(id);
		}
		this.sourceCharacters -= file.content.length; this.files.delete(path);
		return true;
	}

	/** Score only matching inverted postings, then return snippets within the serialized output budget. */
	search(query: string, options: { limit?: number; maxCharacters?: number } = {}): CodeMatch[] {
		const count = Math.max(0, Math.min(8, Math.floor(options.limit ?? 8)));
		const budget = Math.max(0, Math.min(12000, Math.floor(options.maxCharacters ?? 12000)));
		if (!count || !budget || !this.chunks.size || !Number.isFinite(count) || !Number.isFinite(budget)) { return []; }
		const terms = [...new Set(tokens(query.slice(0, 2000)))].slice(0, MAX_QUERY_TERMS);
		const scores = new Map<number, number>();
		const averageLength = this.documentLength / this.chunks.size;
		for (const term of terms) {
			const posting = this.postings.get(term);
			if (!posting) { continue; }
			const inverseFrequency = Math.log(1 + (this.chunks.size - posting.size + 0.5) / (posting.size + 0.5));
			for (const [id, frequency] of posting) {
				const chunk = this.chunks.get(id)!;
				const normalizer = 1.2 * (0.25 + 0.75 * chunk.length / averageLength);
				const weight = frequency * 2.2 / (frequency + normalizer) + (chunk.pathTerms.has(term) ? 2 : 0) + (chunk.symbolTerms.has(term) ? 1.2 : 0);
				scores.set(id, (scores.get(id) ?? 0) + inverseFrequency * weight);
			}
		}
		const ranked = [...scores].sort(([left, leftScore], [right, rightScore]) => rightScore - leftScore || comparePath(this.chunks.get(left)!.path, this.chunks.get(right)!.path) || this.chunks.get(left)!.startLine - this.chunks.get(right)!.startLine || left - right);
		const result: CodeMatch[] = [];
		for (const [id, score] of ranked) {
			const chunk = this.chunks.get(id)!;
			if (result.some(match => match.path === chunk.path && Math.max(0, Math.min(match.endLine, chunk.endLine) - Math.max(match.startLine, chunk.startLine) + 1) > Math.min(match.endLine - match.startLine + 1, chunk.endLine - chunk.startLine + 1) * 0.5)) { continue; }
			const match: CodeMatch = { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text, score: Math.round(score * 1000000) / 1000000 };
			if (JSON.stringify([...result, { ...match, text: '' }]).length > budget) { continue; }
			if (JSON.stringify([...result, match]).length > budget) {
				let low = 0; let high = match.text.length;
				while (low < high) {
					const middle = Math.ceil((low + high) / 2);
					if (JSON.stringify([...result, { ...match, text: chunk.text.slice(0, middle) }]).length <= budget) { low = middle; } else { high = middle - 1; }
				}
				if (!low && chunk.text.length) { continue; }
				if (low < chunk.text.length && /[\uD800-\uDBFF]/.test(chunk.text[low - 1])) { low--; }
				match.text = chunk.text.slice(0, low); match.endLine = truncatedEndLine(match.startLine, match.text);
			}
			result.push(match);
			if (result.length >= count) { break; }
		}
		return result;
	}

	serialize(): CodeIndexSnapshot {
		return { version: 1, files: this.listPaths().map(path => { const file = this.files.get(path)!; return { path, content: file.content, ...(file.fingerprint !== undefined ? { fingerprint: file.fingerprint } : {}) }; }) };
	}

	/** Reject incompatible/corrupt snapshots rather than silently returning a partial cached index. */
	static restore(payload: unknown, options: CodeIndexOptions = {}): CodeIndex {
		const source = record(payload);
		const index = new CodeIndex(options);
		if (source?.version !== 1 || !Array.isArray(source.files) || source.files.length > index.limits.maxFiles) { throw new Error('invalid-code-index'); }
		for (const item of source.files) {
			const file = record(item);
			if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || (file.fingerprint !== undefined && typeof file.fingerprint !== 'string') || index.files.has(file.path) || !index.replaceFile(file.path, file.content, file.fingerprint as string | undefined)) {
				throw new Error('invalid-code-index');
			}
		}
		return index;
	}
}
