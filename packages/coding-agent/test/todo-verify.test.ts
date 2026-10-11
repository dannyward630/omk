import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import finishCheck from "../src/core/extensions/builtin/finish-check.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { buildFinishCheckMessage } from "../src/core/finish-check-requirements.ts";
import {
	activeTodoDifficulty,
	activeTodoKind,
	resetCurrentTodoState,
	setCurrentTodoState,
} from "../src/core/todo-runtime-state.ts";
import { resolveTodoVerify, type TodoItem } from "../src/core/todo-state.ts";
import {
	hostFileCheck,
	normalizeTodoCheck,
	normalizeTodoFields,
	parseTodoLedger,
	TODO_VERIFY_MAX_CHECKS,
	todoChecksLine,
	todoCheckTargets,
	todoSnapshotRecord,
} from "../src/core/todo-verify.ts";
import { createTodoCheckRun } from "../src/core/todo-verify-run.ts";

let dir: string;
beforeEach(() => {
	dir = join(tmpdir(), `omk-todo-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	resetCurrentTodoState();
});
afterEach(() => {
	resetCurrentTodoState();
	rmSync(dir, { recursive: true, force: true });
});

const item = (id: string, status: TodoItem["status"], extra: Partial<TodoItem> = {}): TodoItem => ({
	id,
	label: `task ${id}`,
	status,
	...extra,
});
const state = (items: TodoItem[]) => ({ items, updatedAt: 1 });

describe("spec 049 flag", () => {
	it("is on only for 1/true/on/enable/enabled", () => {
		for (const value of ["1", "true", "ON", " on ", "enable", "Enabled"]) expect(resolveTodoVerify(value)).toBe(true);
		for (const value of [undefined, "", "0", "off", "always", "yes"]) expect(resolveTodoVerify(value)).toBe(false);
	});
});

describe("spec 049 R1: item fields", () => {
	it("keeps known kinds and difficulties and turns anything else into unknown without an error (AC 6)", () => {
		expect(normalizeTodoFields({ kind: "debug", difficulty: "high" })).toEqual({ kind: "debug", difficulty: "high" });
		expect(normalizeTodoFields({ kind: "build", difficulty: "extreme" })).toEqual({});
		expect(normalizeTodoFields({ kind: 3 })).toEqual({});
		expect(todoSnapshotRecord([item("a", "active", normalizeTodoFields({ kind: "nope" }))]).byKind).toEqual({
			unknown: 1,
		});
	});

	it("normalizes checks and cuts command 500, contains 200, path 4096", () => {
		expect(normalizeTodoCheck({ type: "file", path: "out.txt", minBytes: 10, contains: "ok" })).toEqual({
			type: "file",
			path: "out.txt",
			minBytes: 10,
			contains: "ok",
		});
		expect(normalizeTodoCheck({ type: "command", command: "make test", expect: "exit0" })).toEqual({
			type: "command",
			command: "make test",
		});
		const long = normalizeTodoCheck({ type: "command", command: "x".repeat(900), expect: "y".repeat(900) });
		expect(long).toEqual({ type: "command", command: "x".repeat(500), expect: "y".repeat(200) });
		const file = normalizeTodoCheck({ type: "file", path: "p".repeat(5000), contains: "c".repeat(300) });
		expect(file).toEqual({ type: "file", path: "p".repeat(4096), contains: "c".repeat(200) });
		for (const bad of [undefined, null, "make", { type: "file" }, { type: "command", command: " " }, { type: "url" }])
			expect(normalizeTodoCheck(bad)).toBeUndefined();
	});

	it("verifies at most 8 checked items per list, the first ones in list order", () => {
		const items = Array.from({ length: 12 }, (_, index) =>
			item(String(index), "done", index % 3 === 0 ? {} : { check: { type: "command", command: `c${index}` } }),
		);
		const targets = todoCheckTargets(items);
		expect(TODO_VERIFY_MAX_CHECKS).toBe(8);
		expect(targets.map((target) => target.id)).toEqual(["1", "2", "4", "5", "7", "8", "10", "11"]);
		expect(todoChecksLine(items)).toBe("checks: 8 attached · 4 without check");
	});
});

describe("spec 049 R2: host file check", () => {
	it("checks existence, regular file, size and text in the first 1 MiB", () => {
		writeFileSync(join(dir, "out.txt"), "result: 42\n");
		mkdirSync(join(dir, "sub"));
		expect(hostFileCheck({ type: "file", path: "out.txt" }, dir)).toBeUndefined();
		expect(hostFileCheck({ type: "file", path: join(dir, "out.txt"), contains: "42" }, "/")).toBeUndefined();
		expect(hostFileCheck({ type: "file", path: "missing.txt" }, dir)).toBe("missing");
		expect(hostFileCheck({ type: "file", path: "sub" }, dir)).toBe("not-a-file");
		expect(hostFileCheck({ type: "file", path: "out.txt", minBytes: 1000 }, dir)).toBe("too-small");
		expect(hostFileCheck({ type: "file", path: "out.txt", contains: "43" }, dir)).toBe("no-match");
		writeFileSync(join(dir, "big.txt"), `${"a".repeat(1024 * 1024)}needle`);
		expect(hostFileCheck({ type: "file", path: "big.txt", contains: "needle" }, dir)).toBe("no-match");
	});
});

describe("spec 049 R2: check message and ledger", () => {
	it("leaves the check message unchanged with no done command check (AC 2)", () => {
		const requirements = ["The output must be at most 150MB."];
		const items = [
			item("a", "done"),
			item("b", "done", { check: { type: "file", path: "x" } }),
			item("c", "pending", { check: { type: "command", command: "make" } }),
		];
		expect(createTodoCheckRun(state(items), requirements).message).toBe(buildFinishCheckMessage(requirements));
		expect(createTodoCheckRun(state([]), []).message).toBe(buildFinishCheckMessage([]));
	});

	it("adds TODO lines for done command checks and raises the tool cap, never above 12 (AC 4, 7)", () => {
		const items = [
			item("a", "done", { check: { type: "file", path: "x" } }),
			item("b", "done", { label: "run the tests", check: { type: "command", command: "make test" } }),
			item("c", "done", { label: "grep", check: { type: "command", command: "cat out", expect: "ok" } }),
		];
		const run = createTodoCheckRun(state(items), []);
		expect(run.commandCount).toBe(2);
		expect(run.message).toContain("Use at most 6 tool calls");
		expect(run.message).toContain("TODO 2: run the tests — check: make test");
		expect(run.message).toContain("TODO 3: grep — check: cat out (output must contain: ok)");
		expect(run.message).not.toContain("TODO 1:");
		expect(run.message).toContain("`TODO <n>: PASS|FAIL - <measured value>`");
		const many = Array.from({ length: 8 }, (_, index) =>
			item(String(index), "done", { check: { type: "command", command: `c${index}` } }),
		);
		const reqs = Array.from({ length: 8 }, (_, index) => `/out/file${index}/result.txt must exist.`);
		const capped = createTodoCheckRun(state(many), reqs);
		expect(capped.message).toContain("Use at most 12 tool calls");
		expect(buildFinishCheckMessage(reqs)).toContain("Use at most 11 tool calls");
		expect(capped.message).not.toContain("Use at most 11 tool calls");
	});

	it("parses TODO lines like REQ lines", () => {
		const reply = "Done.\nTODO 1: PASS - 3/3 tests\n- **TODO 2: FAIL** — exit 2\nTODO 3: pass";
		expect([...parseTodoLedger(reply)]).toEqual([
			[1, { status: "pass", measured: "3/3 tests" }],
			[2, { status: "fail", measured: "exit 2" }],
			[3, { status: "pass" }],
		]);
	});

	it("fails a done item whose file check fails, whatever the model reports (AC 3)", () => {
		const items = [item("a", "done", { check: { type: "file", path: "missing.bin" } })];
		const run = createTodoCheckRun(state(items), []);
		expect(run.finish("TODO 1: PASS - it is there", dir)).toBe(1);
		const message = run.continueMessage([]);
		expect(message).toContain("TODO 1: task a");
		expect(message).toContain("the file does not exist");
	});

	it("marks host checks past the 200 ms budget unknown", () => {
		let clock = 0;
		const items = [
			item("a", "done", { check: { type: "file", path: "missing" } }),
			item("b", "done", { check: { type: "file", path: "missing" } }),
		];
		const run = createTodoCheckRun(state(items), [], {
			now: () => {
				clock += 150;
				return clock;
			},
		});
		expect(run.finish("", dir)).toBe(1);
	});
});

type Handler = (event: unknown, ctx: unknown) => unknown;
const settled = (text: string) => ({
	messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }],
});

/** finish-check with OMK_TODO_VERIFY on, driven to the check turn with `items` as the todo list. */
async function toCheck(items: TodoItem[], env: NodeJS.ProcessEnv = {}) {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const sent: string[] = [];
	const omk = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
			if (options?.deliverAs === "followUp") sent.push(text);
		},
		appendEntry: () => {},
		events: {
			emit: (channel: string, data: unknown) => {
				for (const listener of listeners.get(channel) ?? []) listener(data);
			},
			on: (channel: string, listener: (data: unknown) => void) => {
				listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
				return () => {};
			},
		},
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: false, hasPendingMessages: () => false, cwd: dir };
	const fire = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	finishCheck(omk, { env: { OMK_TODO_VERIFY: "on", OMK_RUN_LOG_DIR: join(dir, "log"), ...env } });
	await new Promise((resolve) => setTimeout(resolve, 50)); // the verifier import started at load
	await fire("input", { type: "input", text: "Fix the build.", source: "interactive" });
	setCurrentTodoState(state(items));
	await fire("tool_execution_end", { toolName: "write" });
	await fire("agent_settled", settled("done"));
	expect(sent).toHaveLength(1);
	const log = () =>
		readFileSync(join(dir, "log", "todo-verify.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return { fire, sent, log };
}

describe("spec 049 R2: finish-check flow", () => {
	it("joins a host file failure to spec 035's single extra turn, and adds no second one (AC 3)", async () => {
		const run = await toCheck([item("a", "done", { kind: "edit", check: { type: "file", path: "out.bin" } })], {
			OMK_FINISH_CHECK_EXTRA_TURN: "on",
		});
		await run.fire("agent_settled", settled("TODO 1: PASS - exists"));
		expect(run.sent).toHaveLength(2);
		expect(run.sent[1]).toContain("TODO 1: task a");
		expect(run.sent[1]).toContain("host check: the file does not exist");
		await run.fire("agent_settled", settled("TODO 1: FAIL - still missing"));
		expect(run.sent).toHaveLength(2);
		expect(run.log().at(-1)).toMatchObject({
			type: "todo-verify",
			checked: 1,
			fail: 1,
			hostFail: 1,
			extraTurn: true,
			items: [{ kind: "edit", checkType: "file", result: "fail" }],
		});
	});

	it("only records the failure when the extra turn is off", async () => {
		const run = await toCheck([item("a", "done", { check: { type: "file", path: "out.bin" } })]);
		await run.fire("agent_settled", settled("all good"));
		expect(run.sent).toHaveLength(1);
		expect(run.log().at(-1)).toMatchObject({ fail: 1, hostFail: 1, extraTurn: false });
	});

	it("reads a command check's TODO line, and counts a missing line as unreported (AC 4)", async () => {
		const items = [
			item("a", "done", { check: { type: "command", command: "make test" } }),
			item("b", "done", { check: { type: "command", command: "make lint" } }),
		];
		const run = await toCheck(items, { OMK_FINISH_CHECK_EXTRA_TURN: "on" });
		expect(run.sent[0]).toContain("TODO 1: task a — check: make test");
		await run.fire("agent_settled", settled("TODO 1: FAIL - 2 tests fail"));
		expect(run.sent[1]).toContain("measured: 2 tests fail");
		expect(run.log().at(-1)).toMatchObject({ checked: 2, fail: 1, unreported: 1, hostFail: 0, extraTurn: true });
	});

	it("does not check pending items and counts them as not done (AC 5)", async () => {
		writeFileSync(join(dir, "ok.txt"), "ok");
		const items = [
			item("a", "pending", { check: { type: "command", command: "make test" } }),
			item("b", "blocked", { check: { type: "file", path: "missing" } }),
			item("c", "done", { check: { type: "file", path: "ok.txt" } }),
		];
		const run = await toCheck(items, { OMK_FINISH_CHECK_EXTRA_TURN: "on" });
		expect(run.sent[0]).toBe(buildFinishCheckMessage([]));
		await run.fire("agent_settled", settled("ok"));
		expect(run.sent).toHaveLength(1);
		expect(run.log().at(-1)).toMatchObject({ checked: 1, pass: 1, fail: 0, notDone: 2, extraTurn: false });
	});

	it("never writes label, detail, command, path or contains text to the run log (AC 9)", async () => {
		const items = [
			item("secret-id-1", "done", {
				label: "LABEL_MARKER_7f3",
				detail: "DETAIL_MARKER_7f3",
				check: { type: "command", command: "COMMAND_MARKER_7f3" },
			}),
			item("b", "done", { check: { type: "file", path: "PATH_MARKER_7f3", contains: "CONTAINS_MARKER_7f3" } }),
		];
		const run = await toCheck(items, { OMK_FINISH_CHECK_EXTRA_TURN: "on" });
		await run.fire("agent_settled", settled("TODO 1: FAIL - MEASURED_MARKER_7f3"));
		const raw = readFileSync(join(dir, "log", "todo-verify.jsonl"), "utf8");
		expect(raw).toContain('"type":"todo-verify"');
		for (const marker of ["LABEL_", "DETAIL_", "COMMAND_", "PATH_", "CONTAINS_", "MEASURED_", "secret-id"])
			expect(raw).not.toContain(marker);
	});
});

describe("spec 049 R3: accessors for spec 037", () => {
	it("reads the kind and difficulty of nextActiveTodo's item, undefined when unknown", () => {
		expect(activeTodoKind()).toBeUndefined();
		setCurrentTodoState(
			state([item("a", "done", { kind: "plan" }), item("b", "active", { kind: "debug", difficulty: "high" })]),
		);
		expect(activeTodoKind()).toBe("debug");
		expect(activeTodoDifficulty()).toBe("high");
		setCurrentTodoState(state([item("a", "pending")]));
		expect(activeTodoKind()).toBeUndefined();
		expect(activeTodoDifficulty()).toBeUndefined();
		setCurrentTodoState(state([{ ...item("a", "active"), kind: "build" as never }]));
		expect(activeTodoKind()).toBeUndefined();
	});
});
