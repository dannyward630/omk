import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type ignore from "ignore";

/**
 * Ignore-file rules for resource discovery walks (package-manager). Moved out of
 * package-manager.ts unchanged so that module stays within its size budget.
 */

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type IgnoreMatcher = ReturnType<typeof ignore>;

export function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * Ignore-file names present in a `readdir` listing: `true` for an exact match,
 * `false` when only a case variant (".GitIgnore") is listed. A case-insensitive
 * filesystem resolves such a variant, so the caller still probes it.
 */
function listedIgnoreFiles(listing: readonly { name: string }[]): Map<string, boolean> {
	const found = new Map<string, boolean>();
	for (const { name } of listing) {
		if (!name.startsWith(".")) continue;
		const lower = name.toLowerCase();
		if (!IGNORE_FILE_NAMES.includes(lower)) continue;
		found.set(lower, found.get(lower) === true || name === lower);
	}
	return found;
}

/**
 * Add the ignore-file rules of `dir`. With `listing` (the `readdir` result of
 * `dir`), files absent from it are skipped without an `existsSync` probe; a
 * listed name that is not a readable file fails `readFileSync` and is skipped,
 * as a failed probe was before (spec 055).
 */
export function addIgnoreRules(
	ig: IgnoreMatcher,
	dir: string,
	rootDir: string,
	listing?: readonly { name: string }[],
): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	const listed = listing ? listedIgnoreFiles(listing) : undefined;

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		const state = listed?.get(filename);
		if (listed && state === undefined) continue;
		if (state !== true && !existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}
