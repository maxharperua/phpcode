/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface FileReference { start: number; end: number; path: string; line?: number; column?: number }
const plainExtensions = /\.(?:php|md|txt|sql|jsonc?|ya?ml|[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|html?|xml|sh|bash|zsh|py|rb|go|rs|java|[ch](?:pp)?|cs|toml|ini|conf|lock|env|twig|blade|graphql|gql|proto|csv|log)$/i;

/** Detect workspace-looking paths without converting domains, URLs or arbitrary prose into links. */
export function findFileReferences(text: string): FileReference[] {
	const pattern = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?(?:[\p{L}\p{N}_@.+-]+[\\/])*[\p{L}\p{N}_@.+-]+\.[\p{L}\p{N}_-]+(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?|(?:\.{1,2}[\\/]|\/)?(?:[\p{L}\p{N}_@.+-]+[\\/])+/gu;
	const result: FileReference[] = [];
	for (const match of text.matchAll(pattern)) {
		if (match.index > 0 && /[\p{L}\p{N}_@.\\/]/u.test(text[match.index - 1])) { continue; }
		if (/(?:[a-z][a-z\d+.-]*:\/\/|mailto:)[^\s]*$/i.test(text.slice(0, match.index))) { continue; }
		const location = /(?::(?<line>\d+)(?::(?<column>\d+))?|#L(?<hashLine>\d+)(?:C(?<hashColumn>\d+))?)$/.exec(match[0]);
		const path = location ? match[0].slice(0, location.index) : match[0];
		if (!/[\\/]/.test(path) && !plainExtensions.test(path)) { continue; }
		result.push({ start: match.index, end: match.index + match[0].length, path, ...(location ? { line: Math.max(1, Math.min(1_000_000, Number(location.groups?.line || location.groups?.hashLine))), column: Math.max(1, Math.min(1_000_000, Number(location.groups?.column || location.groups?.hashColumn || 1))) } : {}) });
	}
	return result;
}
