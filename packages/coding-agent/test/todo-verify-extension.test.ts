import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import finishCheck from "../src/core/extensions/builtin/finish-check.ts";
import todoChecklist from "../src/core/extensions/builtin/todo-checklist.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	buildFinishCheckContinueMessage,
	buildFinishCheckMessage,
	extractRequirements,
	parseFinishCheckLedger,
} from "../src/core/finish-check-requirements.ts";
import { getCurrentTodoState, resetCurrentTodoState } from "../src/core/todo-runtime-state.ts";

// Spec 049 AC 1 and 8: off, update_todo and the finish check are main's byte for byte; on, the
// tool definition is fixed for the session whatever the todos or the environment do later.

/** main's `update_todo` parameters (b60d3c4), copied verbatim. */
const MAIN_PARAMETERS = Type.Object({
	items: Type.Array(
		Type.Object({
			id: Type.String({ description: "Stable identifier for the task (reuse across updates)." }),
			label: Type.String({ description: "Short human-readable task description." }),
			status: StringEnum(["pending", "active", "done", "blocked"], {
				description: "pending=not started, active=in progress, done=complete, blocked=stuck.",
			}),
			detail: Type.Optional(Type.String({ description: "Optional extra context for the task." })),
		}),
		{ description: "Full current list of checklist items." },
	),
});
const MAIN_DESCRIPTION =
	"Update the visible TODO checklist shown in the terminal UI with the current plan. Pass the FULL current list of tasks on every call (this replaces the previous list). Use this to keep the user informed of progress: mark items pending/active/done/blocked as work proceeds.";

let dir: string;
beforeEach(() => {
	dir = join(tmpdir(), `omk-todo-verify-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	resetCurrentTodoState();
});
afterEach(() => {
	resetCurrentTodoState();
	rmSync(dir, { recursive: true, force: true });
});

async function register(env: NodeJS.ProcessEnv): Promise<ToolDefinition> {
	let tool: ToolDefinition | undefined;
	const omk = {
		on: () => {},
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	await todoChecklist(omk, { env });
	if (!tool) throw new Error("update_todo was not registered");
	return tool;
}

const call = (tool: ToolDefinition, items: unknown[]) =>
	tool.execute("c", { items } as never, undefined, undefined, { hasUI: false } as never);
const definitionJson = (tool: ToolDefinition) =>
	JSON.stringify({
		description: tool.description,
		snippet: tool.promptSnippet,
		guidelines: tool.promptGuidelines,
		parameters: tool.parameters,
	});

describe("spec 049 AC 1: flag off is main", () => {
	it("registers main's schema and description and returns main's result text", async () => {
		for (const value of [undefined, "0", "off", "always"]) {
			const tool = await register({ OMK_TODO_VERIFY: value, OMK_RUN_LOG_DIR: join(dir, "log") });
			expect(JSON.stringify(tool.parameters)).toBe(JSON.stringify(MAIN_PARAMETERS));
			expect(tool.description).toBe(MAIN_DESCRIPTION);
			const result = await call(tool, [{ id: "a", label: "x", status: "done", kind: "edit" }]);
			expect(result.content).toEqual([
				{ type: "text", text: "TODO updated: 1/1 done · 0 active · 0 pending · 0 blocked" },
			]);
		}
		expect(existsSync(join(dir, "log", "todo-verify.jsonl"))).toBe(false);
	});

	it("registers synchronously, as main does", () => {
		let registered = false;
		const omk = {
			on: () => {},
			registerTool: () => {
				registered = true;
			},
		} as unknown as ExtensionAPI;
		expect(todoChecklist(omk, { env: {} })).toBeUndefined();
		expect(registered).toBe(true);
	});

	it("sends main's check and continue messages and writes no todo log, even with checked todos", async () => {
		const sent: string[] = [];
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
		const omk = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			sendUserMessage: (text: string) => sent.push(text),
			appendEntry: () => {},
			events: { emit: () => {}, on: () => () => {} },
		} as unknown as ExtensionAPI;
		const ctx = { hasUI: false, hasPendingMessages: () => false, cwd: dir };
		const fire = async (name: string, event: unknown) => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		};
		const tool = await register({});
		finishCheck(omk, { env: { OMK_FINISH_CHECK_EXTRA_TURN: "on", OMK_RUN_LOG_DIR: join(dir, "log") } });
		const prompt = "The model must be less than 150MB.";
		await fire("input", { type: "input", text: prompt, source: "interactive" });
		await call(tool, [{ id: "a", label: "x", status: "done", check: { type: "command", command: "ls" } }]);
		await fire("tool_execution_end", { toolName: "write" });
		const reply = (text: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
		await fire("agent_settled", reply("done"));
		await fire("agent_settled", reply("REQ 1: FAIL - size 200MB <= 150MB\nTODO 1: FAIL - nope"));
		const requirements = extractRequirements(prompt);
		expect(sent[0]).toBe(buildFinishCheckMessage(requirements));
		const ledger = parseFinishCheckLedger("REQ 1: FAIL - size 200MB <= 150MB", requirements);
		expect(sent[1]).toBe(buildFinishCheckContinueMessage(ledger));
		expect(existsSync(join(dir, "log", "todo-verify.jsonl"))).toBe(false);
	});
});

describe("spec 049 R1 and AC 8: flag on", () => {
	it("adds kind, difficulty and check to items only, with no new guideline", async () => {
		const off = await register({});
		const on = await register({ OMK_TODO_VERIFY: "on" });
		expect(on.description).toBe(off.description);
		expect(on.promptSnippet).toBe(off.promptSnippet);
		expect(on.promptGuidelines).toEqual(off.promptGuidelines);
		const itemProperties = (on.parameters as { properties: { items: { items: { properties: object } } } }).properties
			.items.items.properties;
		expect(Object.keys(itemProperties)).toEqual(["id", "label", "status", "detail", "kind", "difficulty", "check"]);
	});

	it("records a bad kind as unknown without a tool error and adds the checks line (AC 6)", async () => {
		const tool = await register({ OMK_TODO_VERIFY: "on", OMK_RUN_LOG_DIR: join(dir, "log") });
		const result = await call(tool, [
			{ id: "a", label: "x", status: "active", kind: "refactor", difficulty: "high" },
			{ id: "b", label: "y", status: "pending", kind: "verify", check: { type: "command", command: "make" } },
		]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "TODO updated: 0/2 done · 1 active · 1 pending · 0 blocked\nchecks: 1 attached · 1 without check",
		});
		expect(getCurrentTodoState().items[0]).toEqual({ id: "a", label: "x", status: "active", difficulty: "high" });
		const snapshot = JSON.parse(readFileSync(join(dir, "log", "todo-verify.jsonl"), "utf8").trim());
		expect(snapshot).toMatchObject({
			type: "todo-snapshot",
			total: 2,
			byKind: { unknown: 1, verify: 1 },
			byDifficulty: { high: 1, unknown: 1 },
			withCheck: 1,
			checkTypes: { command: 1 },
			done: 0,
		});
	});

	it("keeps the tool definition fixed while todos and the environment change (AC 8)", async () => {
		const env: NodeJS.ProcessEnv = { OMK_TODO_VERIFY: "on" };
		const tool = await register(env);
		const first = definitionJson(tool);
		await call(tool, [{ id: "a", label: "x", status: "active", kind: "plan" }]);
		env.OMK_TODO_VERIFY = "0";
		await call(tool, [{ id: "a", label: "x", status: "done", check: { type: "file", path: "f" } }]);
		expect(definitionJson(tool)).toBe(first);
	});
});
