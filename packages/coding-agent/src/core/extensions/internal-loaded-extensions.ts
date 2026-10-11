/**
 * Internal loaded-extension list (spec 057 R10).
 *
 * The bundled subagent needs to know which extensions the parent loaded, which
 * providers each one registered, and which events each one handles, so it can
 * decide what a worker gets with `--no-extensions` (R3-R7a). This is not public
 * API: it is not on `ExtensionAPI`, not exported from the package index, and not
 * documented. The only way in is the `Symbol.for` key below, which carries no
 * stability promise.
 */

import * as path from "node:path";
import type { SourceOrigin, SourceScope } from "../source-info.ts";
import type { Extension, ExtensionAPI, ExtensionRuntime } from "./types.ts";

export const LOADED_EXTENSIONS_SYMBOL = Symbol.for("omk.internal.loadedExtensions");

export interface LoadedExtensionInfo {
	readonly name: string;
	readonly path: string;
	readonly resolvedPath: string;
	readonly source: string;
	readonly scope: SourceScope;
	readonly origin: SourceOrigin;
	/** Provider names this extension owns (last registration wins, R9/R11). */
	readonly providers: readonly string[];
	/** Sorted event names with at least one handler. */
	readonly hooks: readonly string[];
}

export type LoadedExtensionsAccessor = () => ReadonlyArray<LoadedExtensionInfo>;

/** Extension list backing each runtime; the resource loader adds built-ins to the same array. */
const listsByRuntime = new WeakMap<ExtensionRuntime, readonly Extension[]>();

/** Remember the array `loadExtensions()` returns for this runtime, and return it unchanged. */
export function trackLoadedExtensions(runtime: ExtensionRuntime, extensions: Extension[]): Extension[] {
	listsByRuntime.set(runtime, extensions);
	return extensions;
}

const INDEX_FILE = /^index\.(ts|js|mjs)$/;

/** Package name from a package source (R4.2): `npm:@s/n@1` → `@s/n`, `git:host/o/repo@ref` → `repo`. */
function packageNameFromSource(source: string): string | undefined {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4).trim();
		const versionAt = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
		return (versionAt === -1 ? spec : spec.slice(0, versionAt)) || undefined;
	}
	const withoutScheme = source.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "");
	const lastSegment =
		withoutScheme
			.replace(/[\\/]+$/, "")
			.split(/[\\/:]/)
			.pop() ?? "";
	return lastSegment.replace(/@[^@]*$/, "").replace(/\.git$/, "") || undefined;
}

/** Name used by `OMK_WORKER_EXTENSIONS` matching (spec 057 R4.2). */
export function deriveLoadedExtensionName(extension: Pick<Extension, "path" | "resolvedPath" | "sourceInfo">): string {
	if (extension.sourceInfo.origin === "package") {
		const fromSource = packageNameFromSource(extension.sourceInfo.source);
		if (fromSource) return fromSource;
	}
	const file = path.basename(extension.resolvedPath);
	if (INDEX_FILE.test(file)) return path.basename(path.dirname(extension.resolvedPath));
	return file.replace(/\.[^.]+$/, "");
}

/** Snapshot of the user extensions loaded on this runtime. Built-ins (`<builtin:…>`, `<inline…>`) are skipped. */
export function listLoadedExtensions(runtime: ExtensionRuntime): ReadonlyArray<LoadedExtensionInfo> {
	const extensions = listsByRuntime.get(runtime) ?? [];
	const owned = new Map<string, string[]>();
	for (const [provider, owner] of runtime.providerOwners) {
		owned.set(owner, [...(owned.get(owner) ?? []), provider]);
	}
	const infos = extensions
		.filter((extension) => !extension.path.startsWith("<"))
		.map((extension) =>
			Object.freeze({
				name: deriveLoadedExtensionName(extension),
				path: extension.path,
				resolvedPath: extension.resolvedPath,
				source: extension.sourceInfo.source,
				scope: extension.sourceInfo.scope,
				origin: extension.sourceInfo.origin,
				providers: Object.freeze([...(owned.get(extension.resolvedPath) ?? [])].sort()),
				hooks: Object.freeze(
					[...extension.handlers]
						.filter(([, handlers]) => handlers.length > 0)
						.map(([event]) => event)
						.sort(),
				),
			}),
		);
	return Object.freeze(infos);
}

/** Attach the non-enumerable, read-only accessor to a per-extension API object, and return the object. */
export function attachLoadedExtensionsAccessor(api: ExtensionAPI, runtime: ExtensionRuntime): ExtensionAPI {
	const accessor: LoadedExtensionsAccessor = () => listLoadedExtensions(runtime);
	Object.defineProperty(api, LOADED_EXTENSIONS_SYMBOL, {
		value: accessor,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return api;
}
