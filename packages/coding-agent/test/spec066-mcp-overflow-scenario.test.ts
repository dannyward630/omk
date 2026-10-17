/**
 * Spec 066: the spec 061 scenario with the oversized output coming from an MCP tool (400KB, 64k window,
 * faux provider reporting realistic usage). Capped (default) vs `OMK_MCP_OUTPUT_CAP=0` (the main behavior).
 * `SPEC066_RUNS=20` repeats each arm; the default suite runs each arm once.
 */

import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "omk-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "omk-ai";
import { afterAll, describe, expect, it } from "vitest";
import { OVERFLOW_RECOVERY_FAILED } from "../src/core/compaction/overflow-recovery-progress.ts";
import { createTokenCounterForMode } from "../src/core/context-budget-token-counter.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { McpClient } from "../src/core/mcp/client.ts";
import { createMcpToolDefinition } from "../src/core/mcp/tools.ts";
import { estimateContextInputTokens } from "../src/core/prompt-budget.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { createHarness, fauxModel, type Harness } from "./test-harness.ts";

const realisticCounter = createTokenCounterForMode("fallback");
let replyId = 0;

/**
 * Faux reply whose usage reports the prompt it actually received, counted like a provider would
 * (system prompt + tools + messages): a tool call after user input, then a short text reply.
 */
function realisticReply(context: Parameters<Harness["agent"]["streamFn"]>[1]): AssistantMessage {
	const input = estimateContextInputTokens({
		systemPrompt: String(context.systemPrompt ?? ""),
		messages: context.messages as AgentMessage[],
		tools: (context.tools ?? []) as AgentTool[],
		modelId: fauxModel.id,
		tokenCounter: realisticCounter,
	}).localTokens;
	const last = context.messages.at(-1);
	const toolTurn = last?.role === "user";
	return {
		role: "assistant",
		content: toolTurn
			? [{ type: "toolCall", id: `rt_${++replyId}`, name: "out", arguments: {} }]
			: [{ type: "text", text: "ok" }],
		api: fauxModel.api,
		provider: fauxModel.provider,
		model: fauxModel.id,
		usage: {
			input,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolTurn ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

/** Answer summarization requests with a valid summary so compaction can actually succeed. */
interface SummaryControl {
	summaries: number;
	/** Model calls in the current prompt; admission (hard-limit) compaction runs before the first. */
	callsThisPrompt: number;
	failEmergency: boolean;
}

function answerSummaries(h: Harness, failEmergency: boolean, realisticUsage = true): SummaryControl {
	const counter: SummaryControl = { summaries: 0, callsThisPrompt: 0, failEmergency };
	const original = h.agent.streamFn;
	h.agent.streamFn = (model, context, options) => {
		if (!/summar/i.test(String(context.systemPrompt ?? ""))) {
			counter.callsThisPrompt++;
			if (!realisticUsage) return original(model, context, options);
			const reply = realisticReply(context);
			const replyStream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				replyStream.push({ type: "start", partial: reply });
				replyStream.push({ type: "done", reason: reply.stopReason as "stop" | "toolUse", message: reply });
			});
			return replyStream;
		}
		counter.summaries++;
		const emergency = counter.failEmergency && counter.callsThisPrompt === 0;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "## Goal\nbench\n## Progress\nran tool turns" }],
			api: fauxModel.api,
			provider: fauxModel.provider,
			model: fauxModel.id,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: emergency ? "error" : "stop",
			errorMessage: emergency ? "faux summarizer unavailable" : undefined,
			timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			if (emergency) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return counter;
}

function mcpOutputTool(text: string, cwd: string): AgentTool {
	const client = {
		callTool: async () => ({ content: [{ type: "text", text }], isError: false }),
	} as unknown as McpClient;
	const definition = createMcpToolDefinition("srv", client, { name: "out", inputSchema: { type: "object" } });
	const ctx = { cwd, sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext;
	return { ...wrapToolDefinition(definition, () => ctx), name: "out" };
}

interface RunResult {
	overflowCompactions: number;
	giveUps: number;
	elapsedMs: number;
	lastText: string;
}

async function runOnce(): Promise<RunResult> {
	const h: Harness = createHarness({ contextWindow: 64_000, responses: ["unused"] });
	try {
		h.agent.state.tools = [mcpOutputTool("y".repeat(400_000), h.tempDir)];
		answerSummaries(h, false);
		let overflowCompactions = 0;
		h.session.subscribe((event) => {
			if (event.type === "compaction_start" && event.reason === "overflow") overflowCompactions++;
		});
		const started = performance.now();
		await h.session.prompt("turn 1").catch(() => undefined);
		const giveUps = h
			.eventsOfType("compaction_end")
			.filter((e) => typeof e.errorMessage === "string" && e.errorMessage.includes(OVERFLOW_RECOVERY_FAILED)).length;
		const last = h.agent.state.messages.at(-1) as AssistantMessage | undefined;
		const lastText = last?.content?.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
		return { overflowCompactions, giveUps, elapsedMs: Math.round(performance.now() - started), lastText };
	} finally {
		h.cleanup();
	}
}

// Temp spills (no-session mode) are never cleaned up by omk, like bash's; remove the ones these tests made.
const tempSpillsBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("omk-mcp-")));
afterAll(() => {
	for (const f of readdirSync(tmpdir()))
		if (f.startsWith("omk-mcp-") && !tempSpillsBefore.has(f)) rmSync(join(tmpdir(), f), { force: true });
});

const RUNS = Number(process.env.SPEC066_RUNS ?? "1");

describe("spec 066 MCP oversized output (061 scenario)", () => {
	it("capped (default): 0 give-ups and 0 overflow compactions", async () => {
		const results: RunResult[] = [];
		for (let i = 0; i < RUNS; i++) results.push(await runOnce());
		if (process.env.SPEC066_PRINT) process.stderr.write(`066-capped ${JSON.stringify(results)}\n`);
		expect(results.map((r) => r.giveUps)).toEqual(results.map(() => 0));
		expect(results.map((r) => r.overflowCompactions)).toEqual(results.map(() => 0));
		expect(results.every((r) => r.lastText === "ok")).toBe(true);
	}, 120_000);

	it("OMK_MCP_OUTPUT_CAP=0 (main behavior): overflow compactions and the 061 give-up", async () => {
		process.env.OMK_MCP_OUTPUT_CAP = "0";
		try {
			const results: RunResult[] = [];
			for (let i = 0; i < RUNS; i++) results.push(await runOnce());
			if (process.env.SPEC066_PRINT) process.stderr.write(`066-uncapped ${JSON.stringify(results)}\n`);
			expect(results.every((r) => r.giveUps === 1 && r.overflowCompactions >= 1)).toBe(true);
		} finally {
			delete process.env.OMK_MCP_OUTPUT_CAP;
		}
	}, 120_000);
});
