import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	getRegisteredTempOutputFiles,
	isTempOutputCleanupInstalled,
	registerTempOutputFile,
	resetTempOutputCleanupForTests,
	scheduleTempOutputSweep,
	sweepTempOutputFiles,
	TEMP_OUTPUT_NAME_PATTERN,
	TEMP_OUTPUT_SWEEP_STAMP,
} from "../src/core/temp-output-cleanup.ts";

const CHILD = join(import.meta.dirname, "fixtures", "spec068", "child.ts");
const ON = { OMK_TEMP_OUTPUT_CLEANUP: "1" } as NodeJS.ProcessEnv;
const DAY = 24 * 3600 * 1000;
const dirs: string[] = [];

/** Per-run private TMPDIR (OMK rule: never the shared /tmp). */
function privateDir(prefix = "omk-spec068-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function hex16(n: number): string {
	return n.toString(16).padStart(16, "0");
}

function touchFile(path: string, ageMs: number, now = Date.now()): void {
	writeFileSync(path, "x", { mode: 0o600 });
	const t = new Date(now - ageMs);
	utimesSync(path, t, t);
}

function omkFiles(dir: string): string[] {
	return readdirSync(dir).filter((n) => TEMP_OUTPUT_NAME_PATTERN.test(n));
}

interface ChildRun {
	child: ChildProcess;
	result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	ready: Promise<{ paths: string[]; recovered: number; listenerCounts: number[] }>;
}

function runChild(mode: string, tmp: string, flag: "1" | "0" = "1", extraEnv: NodeJS.ProcessEnv = {}): ChildRun {
	const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, ...extraEnv };
	delete env.OMK_TEMP_OUTPUT_CLEANUP;
	env.OMK_TEMP_OUTPUT_CLEANUP = flag;
	const child = spawn(process.execPath, [CHILD, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	const ready = new Promise<{ paths: string[]; recovered: number; listenerCounts: number[] }>((resolve, reject) => {
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString();
			const nl = out.indexOf("\n");
			if (nl !== -1) resolve(JSON.parse(out.slice(0, nl)));
		});
		child.stderr?.on("data", (d: Buffer) => {
			err += d.toString();
		});
		child.on("exit", () => {
			if (!out.includes("\n")) reject(new Error(`child failed: ${err}`));
		});
	});
	const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.on("exit", (code, signal) => resolve({ code, signal })),
	);
	return { child, result, ready };
}

const CHILD_WAIT_MS = 5_000;

/** Bounded wait: a child that does not settle in time is SIGKILLed and the test fails (never hangs CI). */
async function within<T>(run: ChildRun, promise: Promise<T>, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), CHILD_WAIT_MS);
	});
	try {
		const winner = await Promise.race([promise, timeout]);
		if (winner === "timeout") {
			run.child.kill("SIGKILL");
			expect.fail(
				`spec068 child (pid ${run.child.pid}) did not ${what} within ${CHILD_WAIT_MS} ms; killed with SIGKILL`,
			);
		}
		return winner as T;
	} finally {
		clearTimeout(timer);
	}
}

const ready = (run: ChildRun) => within(run, run.ready, "report its spill paths");
const exited = (run: ChildRun, after = "exit") => within(run, run.result, after);

afterEach(() => resetTempOutputCleanupForTests());
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("spec 068 criteria 1-2: exit cleanup, recovery while alive (n=20)", () => {
	it("leaves 0 files created by the run and recovers the middle fact 20/20", async () => {
		let left = 0;
		let recovered = 0;
		let created = 0;
		for (let i = 0; i < 20; i++) {
			const tmp = privateDir();
			const before = omkFiles(tmp).length;
			const run = runChild("exit", tmp);
			const info = await ready(run);
			const { code } = await exited(run);
			expect(code).toBe(0);
			expect(info.paths).toHaveLength(2); // one omk-bash, one omk-mcp
			created += info.paths.length;
			if (info.recovered === 2) recovered++;
			left += omkFiles(tmp).length - before;
		}
		expect(created).toBe(40);
		expect(recovered).toBe(20);
		expect(left).toBe(0);
	}, 120_000);
});

describe("spec 068 criterion 3: SIGINT / SIGTERM (n=20 each)", () => {
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		it(`${sig}: 0 leftovers, still terminated by the signal`, async () => {
			let left = 0;
			let bySignal = 0;
			for (let i = 0; i < 20; i++) {
				const tmp = privateDir();
				const run = runChild("wait", tmp);
				const info = await ready(run);
				expect(info.paths.every((p) => existsSync(p))).toBe(true);
				run.child.kill(sig);
				const { signal } = await exited(run, `exit after ${sig}`);
				if (signal === sig) bySignal++;
				left += omkFiles(tmp).length;
			}
			expect(left).toBe(0);
			expect(bySignal).toBe(20);
		}, 120_000);
	}
});

describe("spec 068 criterion 3 regression: real settings-manager -> proper-lockfile -> signal-exit 3.0.7", () => {
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		it(`${sig}: same terminating signal flag on vs off, 0 files with flag on`, async () => {
			const out: Record<string, { signal: NodeJS.Signals | null; left: number; listeners: number[] }> = {};
			for (const flag of ["0", "1"] as const) {
				const tmp = privateDir();
				const run = runChild("wait", tmp, flag, { SPEC068_LOAD_SETTINGS: "1" });
				const info = await ready(run);
				expect(info.paths).toHaveLength(2);
				run.child.kill(sig);
				const { signal } = await exited(run, `exit after ${sig}`);
				out[flag] = { signal, left: omkFiles(tmp).length, listeners: info.listenerCounts };
			}
			expect(out["0"]!.signal).toBe(sig);
			expect(out["1"]!.signal).toBe(sig);
			expect(out["1"]!.left).toBe(0);
			expect(out["0"]!.left).toBe(2); // flag off: today's behaviour
			// signal-exit owns one listener per signal; our cleanup adds none (onExit only).
			expect(out["0"]!.listeners).toEqual([1, 1, 1]);
			expect(out["1"]!.listeners).toEqual(out["0"]!.listeners);
		}, 30_000);
	}
});

describe("spec 068 criteria 4-5, 8: startup sweep", () => {
	it("SIGKILL leftover: removed only when older than 24 h; fresh one survives", async () => {
		const tmp = privateDir();
		const run = runChild("wait", tmp);
		const info = await ready(run);
		run.child.kill("SIGKILL");
		await exited(run, "exit after SIGKILL");
		expect(omkFiles(tmp)).toHaveLength(2); // SIGKILL skips the exit hook
		const now = Date.now();
		// One aged past 24 h, one fresh (faked mtimes).
		utimesSync(info.paths[0]!, new Date(now - DAY - 60_000), new Date(now - DAY - 60_000));
		utimesSync(info.paths[1]!, new Date(now - DAY + 60_000), new Date(now - DAY + 60_000));
		const res = await sweepTempOutputFiles({ agentDir: privateDir(), tmpDir: tmp, now, env: ON });
		expect(res).toEqual({ status: "swept", removed: 1, kept: 1 });
		expect(existsSync(info.paths[0]!)).toBe(false);
		expect(existsSync(info.paths[1]!)).toBe(true);
	}, 30_000);

	it("decoys untouched: omk-build.log, bad hex, young matching file", async () => {
		const tmp = privateDir();
		const old = 3 * DAY;
		touchFile(join(tmp, "omk-build.log"), old);
		touchFile(join(tmp, "omk-bash-xyz.log"), old);
		touchFile(join(tmp, "omk-bash-0123456789ABCDEF.log"), old); // upper-case hex is not generated
		touchFile(join(tmp, "omk-bash-0123456789abcde.log"), old); // 15 hex
		touchFile(join(tmp, "omk-spill-0123456789abcdef.log"), old); // other prefix, out of scope
		touchFile(join(tmp, `omk-mcp-${hex16(1)}.log`), DAY - 3_600_000); // young
		touchFile(join(tmp, `omk-bash-${hex16(2)}.log`), old); // should go
		const res = await sweepTempOutputFiles({ agentDir: privateDir(), tmpDir: tmp, env: ON });
		expect(res).toEqual({ status: "swept", removed: 1, kept: 1 });
		expect(readdirSync(tmp).sort()).toEqual(
			[
				"omk-bash-0123456789ABCDEF.log",
				"omk-bash-0123456789abcde.log",
				"omk-bash-xyz.log",
				"omk-build.log",
				`omk-mcp-${hex16(1)}.log`,
				"omk-spill-0123456789abcdef.log",
			].sort(),
		);
	});

	it("lstat: symlink not followed, target kept; directory, FIFO and other uid skipped", async () => {
		const tmp = privateDir();
		const outside = privateDir("omk-spec068-target-");
		const target = join(outside, "real-old.log");
		touchFile(target, 3 * DAY);
		const link = join(tmp, `omk-bash-${hex16(10)}.log`);
		symlinkSync(target, link);
		const dir = join(tmp, `omk-mcp-${hex16(11)}.log`);
		mkdirSync(dir);
		utimesSync(dir, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
		const fifo = join(tmp, `omk-mcp-${hex16(12)}.log`);
		execFileSync("mkfifo", [fifo]);
		utimesSync(fifo, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
		const res = await sweepTempOutputFiles({ agentDir: privateDir(), tmpDir: tmp, env: ON });
		expect(res).toEqual({ status: "swept", removed: 0, kept: 3 });
		expect(existsSync(target)).toBe(true);
		expect(readdirSync(tmp)).toHaveLength(3);

		// Other uid: simulated by sweeping as a different uid (chown needs root).
		const tmp2 = privateDir();
		touchFile(join(tmp2, `omk-bash-${hex16(13)}.log`), 3 * DAY);
		const res2 = await sweepTempOutputFiles({
			agentDir: privateDir(),
			tmpDir: tmp2,
			env: ON,
			uid: (process.getuid?.() ?? 0) + 1,
		});
		expect(res2).toEqual({ status: "swept", removed: 0, kept: 1 });
	});

	it("once per day via <agentDir>/temp-output-sweep.stamp; read-only agent dir skips", async () => {
		const tmp = privateDir();
		const agentDir = privateDir();
		const now = Date.now();
		expect((await sweepTempOutputFiles({ agentDir, tmpDir: tmp, env: ON, now })).status).toBe("swept");
		expect(existsSync(join(agentDir, TEMP_OUTPUT_SWEEP_STAMP))).toBe(true);
		expect((await sweepTempOutputFiles({ agentDir, tmpDir: tmp, env: ON, now: now + 3_600_000 })).status).toBe(
			"not-due",
		);
		expect((await sweepTempOutputFiles({ agentDir, tmpDir: tmp, env: ON, now: now + DAY + 1 })).status).toBe("swept");
		const ro = privateDir();
		chmodSync(ro, 0o500);
		const isRoot = process.getuid?.() === 0;
		const res = await sweepTempOutputFiles({ agentDir: ro, tmpDir: tmp, env: ON });
		chmodSync(ro, 0o700);
		if (!isRoot) expect(res.status).toBe("stamp-unwritable");
	});
});

describe("spec 068 criterion 6: persisted sessions keep today's behaviour", () => {
	it("bash spill is not registered and survives exit (count unchanged vs flag off)", async () => {
		const counts: number[] = [];
		for (const flag of ["1", "0"] as const) {
			const tmp = privateDir();
			const run = runChild("persisted", tmp, flag);
			await ready(run);
			await exited(run);
			counts.push(omkFiles(tmp).filter((n) => n.startsWith("omk-bash-")).length);
		}
		expect(counts).toEqual([1, 1]);
		expect(registerTempOutputFile("/nonexistent/omk-bash-x.log", { persisted: true, env: ON })).toBe(false);
		expect(isTempOutputCleanupInstalled()).toBe(false);
	}, 30_000);
});

describe("spec 068 criterion 7: concurrent process, same uid, shared private TMPDIR", () => {
	it("process 2's sweep keeps process 1's live (touched) files", async () => {
		const tmp = privateDir();
		const p1 = runChild("wait", tmp); // ages its files 48 h, then touch tick
		const info = await ready(p1);
		for (const p of info.paths) expect(Date.now() - statSync(p).mtimeMs).toBeLessThan(60_000);
		const res = await sweepTempOutputFiles({ agentDir: privateDir(), tmpDir: tmp, env: ON });
		expect(res).toEqual({ status: "swept", removed: 0, kept: 2 });
		expect(info.paths.every((p) => existsSync(p))).toBe(true);
		p1.child.kill("SIGTERM");
		await exited(p1, "exit after SIGTERM");
		expect(omkFiles(tmp)).toHaveLength(0);
	}, 30_000);
});

describe("spec 068 criterion 9: flag off is inert", () => {
	it("no registration, listener, timer or sweep", async () => {
		const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
		const baseline = events.map((e) => process.listenerCount(e));
		expect(registerTempOutputFile("/x/omk-bash-0.log", { persisted: false, env: {} })).toBe(false);
		expect(
			registerTempOutputFile("/x/omk-bash-0.log", { persisted: false, env: { OMK_TEMP_OUTPUT_CLEANUP: "0" } }),
		).toBe(false);
		expect(isTempOutputCleanupInstalled()).toBe(false);
		expect(getRegisteredTempOutputFiles()).toEqual([]);
		expect(events.map((e) => process.listenerCount(e))).toEqual(baseline);
		const tmp = privateDir();
		touchFile(join(tmp, `omk-bash-${hex16(20)}.log`), 3 * DAY);
		const agentDir = privateDir();
		expect(await sweepTempOutputFiles({ agentDir, tmpDir: tmp, env: {} })).toEqual({ status: "disabled" });
		expect(existsSync(join(agentDir, TEMP_OUTPUT_SWEEP_STAMP))).toBe(false);
		expect(omkFiles(tmp)).toHaveLength(1);
	});

	it("flag off child: same creation count, nothing deleted", async () => {
		const tmp = privateDir();
		const run = runChild("exit", tmp, "0");
		const info = await ready(run);
		await exited(run);
		expect(info.paths).toHaveLength(2);
		expect(omkFiles(tmp)).toHaveLength(2);
	}, 30_000);
});

describe("spec 068 criterion 10: sweep never blocks the caller", () => {
	it("scheduleTempOutputSweep returns before the sweep runs", async () => {
		const tmp = privateDir();
		const agentDir = privateDir();
		const prevTmp = process.env.TMPDIR;
		touchFile(join(tmp, `omk-bash-${hex16(30)}.log`), 3 * DAY);
		process.env.TMPDIR = tmp;
		try {
			scheduleTempOutputSweep({ agentDir, tmpDir: tmp, env: ON });
			expect(omkFiles(tmp)).toHaveLength(1); // still there synchronously
			expect(existsSync(join(agentDir, TEMP_OUTPUT_SWEEP_STAMP))).toBe(false);
			for (let i = 0; i < 50 && omkFiles(tmp).length > 0; i++) await new Promise((r) => setTimeout(r, 10));
			expect(omkFiles(tmp)).toHaveLength(0);
		} finally {
			if (prevTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = prevTmp;
		}
	});
});
