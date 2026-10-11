/**
 * Which extensions a subagent worker loads (spec 057).
 *
 * Workers start with `--no-extensions` (R1). `OMK_WORKER_EXTENSIONS=all` keeps
 * today's discovery; a comma-separated list forwards named extensions the parent
 * loaded, by absolute path (R3, R4, R6). The extension that registered the
 * worker's model provider is forwarded automatically (R5, R11). The parent's own
 * `-e` list is never forwarded as such (R2). Warnings never stop a spawn (R7).
 *
 * The parent's loaded-extension list comes from an internal, symbol-keyed
 * accessor that the omk extension loader attaches to each extension API object
 * (R10). It is not public API; a host without it gets the default and `all`
 * behavior only.
 */

/** Same key as `core/extensions/internal-loaded-extensions.ts`. */
const LOADED_EXTENSIONS_SYMBOL = Symbol.for("omk.internal.loadedExtensions");

export const WORKER_EXTENSIONS_ENV = "OMK_WORKER_EXTENSIONS";
const WARNING_PREFIX = `omk subagent: ${WORKER_EXTENSIONS_ENV}`;
const REQUEST_HOOK = "before_provider_request";

/** Shape of one item of the internal loaded-extension list (R10). */
export interface WorkerLoadedExtension {
	readonly name: string;
	readonly path: string;
	readonly resolvedPath: string;
	readonly source: string;
	readonly scope: string;
	readonly origin: string;
	readonly providers: readonly string[];
	readonly hooks: readonly string[];
}

export interface WorkerExtensionArgsInput {
	readonly env: NodeJS.ProcessEnv;
	/** Extensions the parent loaded; `null` when the host has no internal accessor (R10 fallback). */
	readonly loaded: readonly WorkerLoadedExtension[] | null;
	/** Provider of the worker's `--model`, or undefined when the worker has no model. */
	readonly workerProvider: string | undefined;
	/** R7a warnings are produced only for the first spawn in a parent process. Default true. */
	readonly firstSpawn?: boolean;
}

export interface WorkerExtensionArgs {
	/** Inserted right after `--no-session`: `--no-extensions` and `-e <abs path>` pairs, or nothing under `all`. */
	readonly args: string[];
	readonly warnings: string[];
}

/** Read the parent's loaded-extension list from the internal accessor; empty when it is missing. */
export function readLoadedExtensions(omk: object): readonly WorkerLoadedExtension[] {
	const accessor = (omk as Record<symbol, unknown>)[LOADED_EXTENSIONS_SYMBOL];
	if (typeof accessor !== "function") return [];
	const list = (accessor as () => unknown)();
	return Array.isArray(list) ? (list as WorkerLoadedExtension[]) : [];
}

export function hasLoadedExtensionsAccessor(omk: object): boolean {
	return typeof (omk as Record<symbol, unknown>)[LOADED_EXTENSIONS_SYMBOL] === "function";
}

/** `npm:`, `git:`, `https:` … but not a Windows drive letter such as `C:\` (R6). */
function isPackageSource(entry: string): boolean {
	if (/^[a-z]:([\\/]|$)/i.test(entry)) return false;
	return /^[a-z][a-z0-9+.-]*:/i.test(entry);
}

function parseEntries(value: string | undefined): { all: boolean; entries: string[] } {
	const trimmed = value?.trim() ?? "";
	if (trimmed.toLowerCase() === "all") return { all: true, entries: [] };
	const entries = trimmed
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return { all: false, entries: [...new Set(entries)] };
}

/** Pure: compute the worker's extension argv and warnings (R1-R7a). No I/O. */
export function workerExtensionArgs(input: WorkerExtensionArgsInput): WorkerExtensionArgs {
	const { all, entries } = parseEntries(input.env[WORKER_EXTENSIONS_ENV]);
	if (all) return { args: [], warnings: [] };

	const warnings: string[] = [];
	const loaded = input.loaded ?? [];
	const forwarded: string[] = [];
	const forward = (extension: WorkerLoadedExtension) => {
		if (!forwarded.includes(extension.resolvedPath)) forwarded.push(extension.resolvedPath);
	};

	if (input.loaded === null) {
		const named = entries.filter((entry) => !isPackageSource(entry));
		if (named.length > 0) {
			warnings.push(
				`${WARNING_PREFIX}: this omk cannot list its loaded extensions, so these entries were not forwarded: ${named.join(", ")}`,
			);
		}
	}
	for (const entry of entries) {
		if (isPackageSource(entry)) {
			warnings.push(
				`${WARNING_PREFIX}: "${entry}" is a package source, not a loaded extension; only extensions this session loaded are forwarded, by absolute path`,
			);
			continue;
		}
		if (input.loaded === null) continue;
		const byPath = loaded.find((extension) => extension.resolvedPath === entry);
		if (byPath) {
			forward(byPath);
			continue;
		}
		const byName = loaded.filter((extension) => extension.name === entry);
		if (byName.length === 1) {
			forward(byName[0]);
		} else if (byName.length > 1) {
			const candidates = byName.map((extension) => extension.resolvedPath).join(", ");
			warnings.push(
				`${WARNING_PREFIX}: "${entry}" matches more than one loaded extension (${candidates}); none forwarded. Name the one you want by its absolute path`,
			);
		} else {
			warnings.push(
				`${WARNING_PREFIX}: "${entry}" does not match any extension loaded in this session; nothing forwarded`,
			);
		}
	}

	const provider = input.workerProvider;
	const owner = provider ? loaded.find((extension) => extension.providers.includes(provider)) : undefined;
	if (owner) forward(owner);

	if (input.firstSpawn ?? true) {
		for (const extension of loaded) {
			if (!extension.hooks.includes(REQUEST_HOOK) || forwarded.includes(extension.resolvedPath)) continue;
			warnings.push(
				`${WARNING_PREFIX}: extension "${extension.name}" changes provider requests (${REQUEST_HOOK}) and is not loaded in workers; set ${WORKER_EXTENSIONS_ENV}=${extension.name} to keep it`,
			);
		}
	}

	return { args: ["--no-extensions", ...forwarded.flatMap((extensionPath) => ["-e", extensionPath])], warnings };
}

/** Minimal model-registry surface used to resolve a bare model id. */
export interface WorkerModelLookup {
	getAll(): ReadonlyArray<{ provider: string; id: string }>;
}

/** Provider of a worker `--model` value (R5): `provider/id`, or a bare id the registry knows under one provider. */
export function resolveWorkerProvider(
	model: string | undefined,
	registry: WorkerModelLookup | undefined,
): string | undefined {
	const reference = model?.trim();
	if (!reference) return undefined;
	let models: ReadonlyArray<{ provider: string; id: string }> = [];
	try {
		models = registry?.getAll() ?? [];
	} catch {
		models = [];
	}
	const lower = reference.toLowerCase();
	const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
	if (canonical.length === 1) return canonical[0].provider;
	const slash = reference.indexOf("/");
	if (slash > 0) return reference.slice(0, slash).trim();
	const byId = models.filter((m) => m.id.toLowerCase() === lower);
	const providers = new Set(byId.map((m) => m.provider));
	return providers.size === 1 ? byId[0].provider : undefined;
}

export interface WarningState {
	printed: Set<string>;
	spawned: boolean;
}

const STATE_KEY = Symbol.for("omk.subagent.workerExtensionWarnings");

/** Once-per-parent-process state; survives `/reload`, which re-imports this module. */
function processState(): WarningState {
	const holder = globalThis as unknown as Record<symbol, WarningState | undefined>;
	let state = holder[STATE_KEY];
	if (!state) {
		state = createWorkerExtensionWarningState();
		holder[STATE_KEY] = state;
	}
	return state;
}

export interface WorkerExtensionPlanner {
	/** Extension argv for one worker spawn; prints each distinct warning once per parent process (R7). */
	argsFor(model: string | undefined, registry: WorkerModelLookup | undefined): string[];
}

export function createWorkerExtensionPlanner(
	omk: object,
	options: {
		env?: NodeJS.ProcessEnv;
		warn?: (message: string) => void;
		state?: WarningState;
	} = {},
): WorkerExtensionPlanner {
	const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
	const state = options.state ?? processState();
	return {
		argsFor(model, registry) {
			const firstSpawn = !state.spawned;
			state.spawned = true;
			const result = workerExtensionArgs({
				env: options.env ?? process.env,
				loaded: hasLoadedExtensionsAccessor(omk) ? readLoadedExtensions(omk) : null,
				workerProvider: resolveWorkerProvider(model, registry),
				firstSpawn,
			});
			for (const message of result.warnings) {
				if (state.printed.has(message)) continue;
				state.printed.add(message);
				warn(message);
			}
			return result.args;
		},
	};
}

/** Fresh warning state, for tests. */
export function createWorkerExtensionWarningState(): WarningState {
	return { printed: new Set(), spawned: false };
}
