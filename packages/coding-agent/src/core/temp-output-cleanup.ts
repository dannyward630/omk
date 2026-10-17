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
import onExit from "signal-exit";

export const TEMP_OUTPUT_CLEANUP_ENV = "OMK_TEMP_OUTPUT_CLEANUP";
/** Exact generated name; never a loose `omk-*.log` glob. */
export const TEMP_OUTPUT_NAME_PATTERN = /^omk-(bash|mcp)-[0-9a-f]{16}\.log$/u;
export const TEMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TEMP_OUTPUT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const TEMP_OUTPUT_SWEEP_STAMP = "temp-output-sweep.stamp";

export function isTempOutputCleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[TEMP_OUTPUT_CLEANUP_ENV] === "1";
}

const registered = new Set<string>();
let installed = false;
let touchTimer: NodeJS.Timeout | undefined;
let removeExitHandler: (() => void) | undefined;

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

/**
 * signal-exit 3.x (the same instance proper-lockfile loads) already owns SIGINT/SIGTERM/SIGHUP and re-raises the
 * signal; we only add a synchronous cleanup on top of it. The process dies right after the callback, so no async work.
 */
function install(): void {
	if (installed) return;
	installed = true;
	removeExitHandler = onExit(() => {
		cleanupRegisteredTempOutputFiles();
	});
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
	removeExitHandler?.();
	removeExitHandler = undefined;
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
