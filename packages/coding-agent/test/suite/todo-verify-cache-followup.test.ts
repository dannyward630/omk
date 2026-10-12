import type { StreamFn } from "omk-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "omk-ai";
import { systemHash, toolsHash } from "omk-ai/prompt-hash";
import { afterEach, describe, expect, it } from "vitest";
import todoChecklist from "../../src/core/extensions/builtin/todo-checklist.ts";
import { getCurrentTodoState, resetCurrentTodoState } from "../../src/core/todo-runtime-state.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	resetCurrentTodoState();
});

describe("typed todo session request prefix (049 AC 8)", () => {
	it("keeps system and tools hashes across actual tool updates and a mid-session flag change", async () => {
		const env: NodeJS.ProcessEnv = { OMK_TODO_VERIFY: "on" };
		const harness = await createHarness({ extensionFactories: [(omk) => todoChecklist(omk, { env })] });
		harnesses.push(harness);
		const hashes: { system: string; tools: string }[] = [];
		const original = harness.session.agent.streamFn;
		const capture: StreamFn = (model, context, options) => {
			hashes.push({ system: systemHash(context), tools: toolsHash(context) });
			if (hashes.length === 1) env.OMK_TODO_VERIFY = "0";
			return original(model, context, options);
		};
		harness.session.agent.streamFn = capture;
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("update_todo", {
						items: [{ id: "t1", label: "SYNTHETIC_LABEL_FIRST", status: "active", kind: "plan" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("update_todo", {
						items: [{ id: "t1", label: "SYNTHETIC_LABEL_LAST", status: "done", kind: "verify" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Update the synthetic todo twice.");
		expect(hashes).toHaveLength(3);
		expect(hashes.every((hash) => hash.system === hashes[0].system && hash.tools === hashes[0].tools)).toBe(true);
		expect(getCurrentTodoState().items).toMatchObject([{ id: "t1", status: "done", kind: "verify" }]);
		expect(harness.eventsOfType("tool_execution_end").every((event) => !event.isError)).toBe(true);
	});
});
