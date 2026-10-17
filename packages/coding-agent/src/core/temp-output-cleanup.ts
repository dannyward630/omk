/**
 * Spec 068: cleanup of full-output temp files (`omk-bash-*.log`, `omk-mcp-*.log`).
 *
 * Behind `OMK_TEMP_OUTPUT_CLEANUP=1` (default off). When off, nothing here installs a listener, timer or sweep.
 * - A: files created while the session is not persisted are registered and unlinked synchronously on exit.
 * - Hourly touch: registered files get a fresh mtime so other processes' sweeps keep them (timer is unref()ed).
 * - C: a once-per-day startup sweep deletes strict-pattern files owned by our uid, regular, older than 24 h.
 */
import { unlinkSync, utimesSync } from "node:fs";
import { lstat, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEMP_OUTPUT_CLEANUP_ENV = "OMK_TEMP_OUTPUT_CLEANUP";
/** Exact generated name; never a loose `omk-*.log` glob. */
export const TEMP_OUTPUT_NAME_PATTERN = /^omk-(bash|mcp)-[0-9a-f]{16}\.log$/u;
export const TEMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TEMP_OUTPUT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const TEMP_OUTPUT_SWEEP_STAMP = "temp-output-sweep.stamp";

const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function isTempOutputCleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[TEMP_OUTPUT_CLEANUP_ENV] === "1";
}

const registered = new Set<string>();
let installed = false;
let touchTimer: NodeJS.Timeout | undefined;
const signalListeners = new Map<string, () => void>();

/** Synchronous, best effort; never throws and never touches the exit code. */
export function cleanupRegisteredTempOutputFiles(): number {
	let removed = 0;
	for (const path of registered) {
		try {
			unlinkSync(path);
			removed++;
		} catch {
			// best effort
		}
	}
	registered.clear();
	return removed;
}

export function touchRegisteredTempOutputFiles(now: Date = new Date()): void {
	for (const path of registered) {
		try {
			utimesSync(path, now, now);
		} catch {
			// best effort
		}
	}
}

function onExit(): void {
	cleanupRegisteredTempOutputFiles();
}

/**
 * Signal listener that keeps the signal's normal outcome. If other listeners exist they decide (their
 * `process.exit()` reaches the exit hook). If ours is the only one, files are deleted, the listener is removed and
 * the signal is re-raised so the default action (termination by that signal) still happens.
 */
function makeSignalListener(sig: (typeof CLEANUP_SIGNALS)[number]): () => void {
	const listener = () => {
		// Another handler owns this signal (e.g. the TUI ignores SIGINT): the process may live on, so keep the
		// files; if that handler exits, the exit hook deletes them.
		if (process.listenerCount(sig) !== 1) return;
		cleanupRegisteredTempOutputFiles();
		process.removeListener(sig, listener);
		process.kill(process.pid, sig);
	};
	return listener;
}

function install(): void {
	if (installed) return;
	installed = true;
	process.on("exit", onExit);
	for (const sig of CLEANUP_SIGNALS) {
		const listener = makeSignalListener(sig);
		signalListeners.set(sig, listener);
		process.on(sig, listener);
	}
	touchTimer = setInterval(() => touchRegisteredTempOutputFiles(), TEMP_OUTPUT_TOUCH_INTERVAL_MS);
	touchTimer.unref();
}

export interface RegisterTempOutputOptions {
	/** True when a persisted session may reference the path: keep today's behaviour (not registered). */
	readonly persisted: boolean;
	readonly env?: NodeJS.ProcessEnv;
}

/** Registers a temp file for deletion at exit. No-op when the flag is off or the session is persisted. */
export function registerTempOutputFile(path: string, options: RegisterTempOutputOptions): boolean {
	if (options.persisted || !isTempOutputCleanupEnabled(options.env)) return false;
	install();
	registered.add(path);
	return true;
}

export function isTempOutputCleanupInstalled(): boolean {
	return installed;
}

export function getRegisteredTempOutputFiles(): readonly string[] {
	return [...registered];
}

/** Test helper: remove listeners and timer, forget registrations (does not delete files). */
export function resetTempOutputCleanupForTests(): void {
	if (installed) {
		process.removeListener("exit", onExit);
		for (const [sig, listener] of signalListeners) process.removeListener(sig, listener);
	}
	signalListeners.clear();
	if (touchTimer) clearInterval(touchTimer);
	touchTimer = undefined;
	installed = false;
	registered.clear();
}

export interface TempOutputSweepOptions {
	readonly agentDir: string;
	readonly tmpDir?: string;
	readonly now?: number;
	readonly uid?: number;
	readonly env?: NodeJS.ProcessEnv;
}

export type TempOutputSweepResult =
	| { readonly status: "disabled" | "not-due" | "stamp-unwritable" }
	| { readonly status: "swept"; readonly removed: number; readonly kept: number };

async function claimDailyStamp(agentDir: string, now: number): Promise<"due" | "not-due" | "unwritable"> {
	const stampPath = join(agentDir, TEMP_OUTPUT_SWEEP_STAMP);
	try {
		const info = await stat(stampPath);
		if (now - info.mtimeMs < TEMP_OUTPUT_MAX_AGE_MS) return "not-due";
	} catch {
		// missing stamp: due
	}
	try {
		await writeFile(stampPath, "", { mode: 0o600 });
		const t = new Date(now);
		await utimes(stampPath, t, t);
		return "due";
	} catch {
		return "unwritable";
	}
}

/**
 * Startup sweep (C). Asynchronous; callers do not await it on the startup path.
 * Only names matching {@link TEMP_OUTPUT_NAME_PATTERN}, `lstat` regular files of our uid, mtime older than 24 h.
 */
export async function sweepTempOutputFiles(options: TempOutputSweepOptions): Promise<TempOutputSweepResult> {
	if (!isTempOutputCleanupEnabled(options.env)) return { status: "disabled" };
	const now = options.now ?? Date.now();
	const claim = await claimDailyStamp(options.agentDir, now);
	if (claim === "not-due") return { status: "not-due" };
	if (claim === "unwritable") return { status: "stamp-unwritable" };
	const dir = options.tmpDir ?? tmpdir();
	const uid = options.uid ?? process.getuid?.();
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return { status: "swept", removed: 0, kept: 0 };
	}
	let removed = 0;
	let kept = 0;
	for (const name of names) {
		if (!TEMP_OUTPUT_NAME_PATTERN.test(name)) continue;
		const path = join(dir, name);
		try {
			const info = await lstat(path);
			if (!info.isFile()) {
				kept++;
				continue;
			}
			if (uid !== undefined && info.uid !== uid) {
				kept++;
				continue;
			}
			if (now - info.mtimeMs <= TEMP_OUTPUT_MAX_AGE_MS) {
				kept++;
				continue;
			}
			await unlink(path);
			removed++;
		} catch {
			// raced or unreadable: leave it
		}
	}
	return { status: "swept", removed, kept };
}

/** Fire-and-forget sweep; never throws, never blocks the caller. */
export function scheduleTempOutputSweep(options: TempOutputSweepOptions): void {
	if (!isTempOutputCleanupEnabled(options.env)) return;
	setImmediate(() => {
		void sweepTempOutputFiles(options).catch(() => undefined);
	}).unref();
}
