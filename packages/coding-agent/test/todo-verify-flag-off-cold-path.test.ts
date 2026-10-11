import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";

// Spec 049 R4 / AC 1, 10: with OMK_TODO_VERIFY off, neither update_todo nor the finish check
// loads the verifier modules, through a whole check turn. Each module is wrapped with a load
// counter (vi.doMock + importOriginal), so a static import on the flag-off path fails here.
// Extension-level: it drives the two built-in extensions directly, not `main()`.
const VERIFIER_MODULES = ["../src/core/todo-verify.ts", "../src/core/todo-verify-run.ts"] as const;
let loads = 0;

beforeEach(() => {
	vi.resetModules();
	loads = 0;
	for (const path of VERIFIER_MODULES) {
		vi.doMock(path, async (importOriginal) => {
			loads += 1;
			return await importOriginal();
		});
	}
});

async function runCheckTurn(env: NodeJS.ProcessEnv): Promise<string[]> {
	const { default: todoChecklist } = await import("../src/core/extensions/builtin/todo-checklist.ts");
	const { default: finishCheck } = await import("../src/core/extensions/builtin/finish-check.ts");
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const sent: string[] = [];
	let tool: ToolDefinition | undefined;
	const omk = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		sendUserMessage: (text: string) => sent.push(text),
		appendEntry: () => {},
		events: { emit: () => {}, on: () => () => {} },
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: false, hasPendingMessages: () => false, cwd: "/tmp" };
	const fire = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await todoChecklist(omk, { env });
	finishCheck(omk, { env });
	await new Promise((resolve) => setTimeout(resolve, 50));
	await fire("input", { type: "input", text: "Write /app/out.txt.", source: "interactive" });
	await tool?.execute(
		"c",
		{ items: [{ id: "a", label: "x", status: "done", check: { type: "file", path: "/app/out.txt" } }] } as never,
		undefined,
		undefined,
		{ hasUI: false } as never,
	);
	await fire("tool_execution_end", { toolName: "write" });
	const reply = (text: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
	await fire("agent_settled", reply("done"));
	await fire("agent_settled", reply("REQ 1: PASS - exists"));
	return sent;
}

describe("OMK_TODO_VERIFY off: verifier cold path (spec 049 R4)", () => {
	it("loads no verifier module when the flag is off", async () => {
		const sent = await runCheckTurn({});
		expect(sent).toHaveLength(1);
		expect(loads).toBe(0);
	});

	it("loads them when the flag is on (the counter works)", async () => {
		await runCheckTurn({ OMK_TODO_VERIFY: "on" });
		expect(loads).toBeGreaterThan(0);
	});
});
