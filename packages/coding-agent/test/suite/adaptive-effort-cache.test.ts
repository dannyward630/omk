/**
 * Spec 037 Requirement 4 (Tech Lead): with adaptive effort on, a real `AgentSession` that switches into
 * the high group and back keeps the cacheable prefix stable. The model object, system prompt and tool
 * list are the same on every request, earlier messages (including thinking blocks produced at another
 * effort) are passed back byte for byte, and every `llm-call.jsonl` line has cache fields.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, StreamFn } from "omk-agent-core";
import {
	type Api,
	type AssistantMessage,
	type FauxContentBlock,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type Model,
} from "omk-ai";
import { messagesPrefixHash, serializePromptMessage, systemHash, toolsHash } from "omk-ai/prompt-hash";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAdaptiveEffortStreamFn } from "../../src/core/adaptive-effort.ts";
import {
	createLlmCallRunLogStreamFn,
	resetLlmCallRunLogClock,
	setLlmCallPhaseFields,
} from "../../src/core/llm-call-run-log.ts";
import { createHarness, type Harness } from "./harness.ts";

interface Captured {
	readonly model: unknown;
	readonly reasoning: string | undefined;
	readonly system: string;
	readonly tools: string;
	readonly messages: readonly string[];
	readonly prefix: string;
	/** `messagesPrefixHash` of this request over the previous request's message count. */
	readonly previousPrefix: string | undefined;
}

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: `${name} ok` }], details: {} }),
	};
}

let signature = 0;
/** A tool turn with a signed thinking block, as a reasoning provider returns it. */
const turn = (name: string) =>
	fauxAssistantMessage(
		[
			{ ...fauxThinking(`thinking before ${name}`), thinkingSignature: `sig-${++signature}` } as FauxContentBlock,
			fauxToolCall(name, { path: "a.txt" }),
		],
		{ stopReason: "toolUse" },
	);

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	setLlmCallPhaseFields(undefined);
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("adaptive effort keeps the prompt cache prefix (spec 037 R4)", () => {
	it("switches to the high group and back with a stable model, system, tools and message prefix", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-reasoning", reasoning: true }],
			tools: [tool("read"), tool("diagnostics")],
		});
		harnesses.push(harness);
		const model = harness.session.agent.state.model as Model<Api>;
		model.thinkingLevelMap = { ...model.thinkingLevelMap, xhigh: "xhigh" };
		harness.session.setThinkingLevel("xhigh");

		const dir = mkdtempSync(join(tmpdir(), "omk-037-cache-"));
		dirs.push(dir);
		resetLlmCallRunLogClock();
		const calls: Captured[] = [];
		const inner = harness.session.agent.streamFn;
		const capture: StreamFn = (requestModel, context, options) => {
			calls.push({
				model: requestModel,
				reasoning: options?.reasoning,
				system: systemHash(context),
				tools: toolsHash(context),
				messages: context.messages.map((message) => serializePromptMessage(message)),
				prefix: messagesPrefixHash(context),
				previousPrefix:
					calls.length === 0 ? undefined : messagesPrefixHash(context, calls[calls.length - 1].messages.length),
			});
			return inner(requestModel, context, options);
		};
		harness.session.agent.streamFn = createAdaptiveEffortStreamFn(
			createLlmCallRunLogStreamFn(capture, { env: { OMK_RUN_LOG_DIR: dir } }),
		);

		// verify, verify (→ high), read, read (→ low), done.
		harness.setResponses([
			turn("diagnostics"),
			turn("diagnostics"),
			turn("read"),
			turn("read"),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Check a.txt");
		await new Promise((resolve) => setImmediate(resolve));

		expect(calls.length).toBe(5);
		// The effort really moved: low group `high`, the high group the ceiling `xhigh`.
		expect(calls.map((call) => call.reasoning)).toEqual(["high", "high", "xhigh", "xhigh", "high"]);
		for (const call of calls) {
			expect(call.model).toBe(calls[0].model);
			expect(call.system).toBe(calls[0].system);
			expect(call.tools).toBe(calls[0].tools);
		}
		for (let i = 1; i < calls.length; i++) {
			const previous = calls[i - 1];
			expect(calls[i].previousPrefix).toBe(previous.prefix);
			expect(calls[i].messages.slice(0, previous.messages.length)).toEqual(previous.messages);
		}

		// Thinking blocks come back exactly as the provider returned them, across both switches.
		const returned = harness.session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		const last = calls[calls.length - 1].messages;
		for (const message of returned.slice(0, 4)) expect(last).toContain(serializePromptMessage(message));

		const lines = readFileSync(join(dir, "llm-call.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines).toHaveLength(5);
		for (const line of lines) {
			expect(line).toHaveProperty("cacheRead");
			expect(line).toHaveProperty("cacheWrite");
		}
		expect(lines.map((line) => line.effortSwitch)).toEqual([
			null,
			null,
			{ from: "low", to: "high", n: 1 },
			null,
			{ from: "high", to: "low", n: 2 },
		]);
	});
});
