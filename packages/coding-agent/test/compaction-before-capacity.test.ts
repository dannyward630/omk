import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "omk-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "omk-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, fauxModel, type Harness } from "./test-harness.ts";

// Spec 060 regression: tool output that keeps growing must auto-compact before hard input
// admission rejects the next prompt with PromptInputCapacityError.

function outputTool(text: string): AgentTool {
	return {
		name: "out",
		label: "out",
		description: "returns a fixed output",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: {} }),
	};
}

/** Answer summarization requests with a valid summary so compaction can actually succeed. */
interface SummaryControl {
	summaries: number;
	/** Model calls in the current prompt; admission (hard-limit) compaction runs before the first. */
	callsThisPrompt: number;
	failEmergency: boolean;
}

function answerSummaries(h: Harness, failEmergency: boolean): SummaryControl {
	const counter: SummaryControl = { summaries: 0, callsThisPrompt: 0, failEmergency };
	const original = h.agent.streamFn;
	h.agent.streamFn = (model, context, options) => {
		if (!/summar/i.test(String(context.systemPrompt ?? ""))) {
			counter.callsThisPrompt++;
			return original(model, context, options);
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

interface RunResult {
	errors: string[];
	completedTurns: number;
	compactionStartTurns: number[];
	failedCompactions: string[];
}

async function runTurns(text: string, turns: number, failEmergency = false): Promise<RunResult> {
	h = createHarness({
		contextWindow: 64_000,
		baseToolsOverride: { out: outputTool(text) },
		// Faux usage stays at its default (input 100), like a provider that under-reports history.
		responses: [{ toolCalls: [{ name: "out", args: {} }] }, "ok"],
	});
	const control = answerSummaries(h, failEmergency);
	let turn = 0;
	const compactionStartTurns: number[] = [];
	h.session.subscribe((event) => {
		if (event.type === "compaction_start") compactionStartTurns.push(turn);
	});
	const errors: string[] = [];
	let completedTurns = 0;
	for (turn = 1; turn <= turns; turn++) {
		control.callsThisPrompt = 0;
		try {
			await h.session.prompt(`turn ${turn}`);
			completedTurns++;
		} catch (error) {
			errors.push(`${turn}: ${(error as Error).name}: ${(error as Error).message}`);
			break;
		}
	}
	const failedCompactions = h
		.eventsOfType("compaction_end")
		.filter((e) => e.errorMessage)
		.map((e) => String(e.errorMessage));
	return { errors, completedTurns, compactionStartTurns, failedCompactions };
}

let h: Harness | undefined;
afterEach(() => {
	h?.cleanup();
	h = undefined;
});

describe("auto-compaction before input capacity rejection", () => {
	it("compacts before the first rejection as large tool output accumulates", async () => {
		const r = await runTurns("x".repeat(24_000), 16); // ~6k estimated tokens per result
		expect(r.errors).toEqual([]);
		expect(r.failedCompactions).toEqual([]);
		expect(r.completedTurns).toBe(16);
		// The admission ceiling (~41k of 64k) is reached at turn 7 without compaction on main.
		expect(r.compactionStartTurns.length).toBeGreaterThan(0);
		expect(r.compactionStartTurns[0]).toBeLessThan(7);
		// Anti-thrash: measured 2 compactions (turns 6 and 12) with the fix; cap = measured + 1.
		expect(r.compactionStartTurns.length).toBeLessThanOrEqual(3);
	}, 60_000);

	it("records the compaction trigger source and both token values in the run log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omk-060-runlog-"));
		process.env.OMK_RUN_LOG_DIR = dir;
		try {
			await runTurns("x".repeat(24_000), 8);
			const records = readFileSync(join(dir, "compaction-trigger.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records.length).toBeGreaterThan(0);
			expect(records[0]).toMatchObject({ trigger: "estimate" });
			expect(records[0].estimatedTokens).toBeGreaterThan(records[0].usageTokens);
			expect(typeof records[0].usageTokens).toBe("number");
		} finally {
			delete process.env.OMK_RUN_LOG_DIR;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("measures a resumed history before the first admission (default counter, not 0)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omk-060-resume-"));
		process.env.OMK_RUN_LOG_DIR = dir;
		try {
			h = createHarness({
				contextWindow: 64_000,
				baseToolsOverride: { out: outputTool("small") },
				responses: ["ok"],
			});
			answerSummaries(h, false);
			// Resumed transcript: ~36k estimated tokens of tool output, provider usage reported as 100.
			const usage = {
				input: 100,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 101,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const resumed: AgentMessage[] = [];
			for (let i = 0; i < 5; i++) {
				resumed.push({ role: "user", content: [{ type: "text", text: `turn ${i}` }], timestamp: i });
				resumed.push({
					role: "assistant",
					content: [{ type: "toolCall", id: `r${i}`, name: "out", arguments: {} }],
					api: fauxModel.api,
					provider: fauxModel.provider,
					model: fauxModel.id,
					usage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				} as AgentMessage);
				resumed.push({
					role: "toolResult",
					toolCallId: `r${i}`,
					toolName: "out",
					content: [{ type: "text", text: "x".repeat(26_500) }],
					isError: false,
					timestamp: i,
				} as AgentMessage);
				resumed.push({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: fauxModel.api,
					provider: fauxModel.provider,
					model: fauxModel.id,
					usage,
					stopReason: "stop",
					timestamp: Date.now(),
				} as AgentMessage);
			}
			for (const message of resumed) h.sessionManager.appendMessage(message as never);
			h.agent.state.messages = resumed;
			await h.session.prompt("resume");
			expect(h.eventsOfType("compaction_end").map((e) => e.errorMessage ?? "ok")).toEqual(["ok"]);
			const records = readFileSync(join(dir, "compaction-trigger.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			// The pre-prompt check (agent-session `_checkCompaction(lastAssistant, false)`) runs before
			// admit(); it must still see the history through admission's default counter.
			expect(records[0]).toMatchObject({ trigger: "estimate", usageTokens: 101 });
			expect(records[0].estimatedTokens).toBeGreaterThan(30_000);
		} finally {
			delete process.env.OMK_RUN_LOG_DIR;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("completes every turn when the hard-limit (emergency) summary fails", async () => {
		// main: no threshold compaction before the ceiling, the one emergency compaction fails,
		// and the session dies with PromptInputCapacityError at turn 7.
		const r = await runTurns("x".repeat(24_000), 16, true);
		expect(r.errors).toEqual([]);
		expect(r.completedTurns).toBe(16);
	}, 60_000);

	it("survives a single tool output larger than the whole window", async () => {
		const r = await runTurns("y".repeat(400_000), 2); // ~100k tokens, window 64k
		expect(r.errors.filter((e) => e.includes("PromptInputCapacityError"))).toEqual([]);
		expect(r.completedTurns).toBe(2);
	}, 60_000);

	it("does not compact a small-output session (start turn unchanged vs main)", async () => {
		const r = await runTurns("z".repeat(200), 16);
		expect(r.errors).toEqual([]);
		expect(r.compactionStartTurns).toEqual([]);
	}, 60_000);
});
