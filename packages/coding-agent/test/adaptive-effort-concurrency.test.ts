import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "omk-agent-core";
import { type AssistantMessage, type Context, createAssistantMessageEventStream, getModel } from "omk-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAdaptiveEffortStreamFn } from "../src/core/adaptive-effort.ts";
import {
	createLlmCallRunLogStreamFn,
	resetLlmCallRunLogClock,
	setLlmCallPhaseFields,
} from "../src/core/llm-call-run-log.ts";
import { createResponseReasoningCapStreamFn } from "../src/core/response-reasoning-cap.ts";

const model = getModel("xai", "grok-4.7");
const roots: string[] = [];
afterEach(() => {
	setLlmCallPhaseFields(undefined);
	resetLlmCallRunLogClock();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function context(id: string): Context {
	return {
		systemPrompt: "SYNTHETIC_PROMPT",
		messages: [{ role: "user", content: id, timestamp: 0 }],
		tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
	};
}
function message(id: string, aborted = false): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: id,
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "stop",
		timestamp: 0,
	};
}
function gate() {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}
function setup(provider: StreamFn) {
	const root = mkdtempSync(join(tmpdir(), "omk-phase-concurrency-"));
	roots.push(root);
	const logged = createLlmCallRunLogStreamFn(provider, { env: { OMK_RUN_LOG_DIR: root } });
	return {
		logged,
		lines: () =>
			readFileSync(join(root, "llm-call.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>),
	};
}
async function finish(stream: Awaited<ReturnType<StreamFn>>) {
	for await (const _event of stream) {
		/* drain real cap events */
	}
	await stream.result();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("adaptive effort concurrent call ownership", () => {
	it("keeps phase and switch attribution across a real delayed cap retry while another session runs", async () => {
		const abortSeen = gate();
		const drain = gate();
		const attempts = new Map<string, number>();
		const provider: StreamFn = (_model, input, options) => {
			const id = input.messages[0].role === "user" ? String(input.messages[0].content) : "unknown";
			const attempt = (attempts.get(id) ?? 0) + 1;
			attempts.set(id, attempt);
			const stream = createAssistantMessageEventStream();
			const partial = message(`${id}-${attempt}`);
			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				if (id === "A" && attempt === 2) {
					const signal = options?.signal;
					if (!signal) throw new Error("Missing real cap signal");
					signal.addEventListener(
						"abort",
						() => {
							abortSeen.release();
							void drain.ready.then(() => {
								const final = message(`${id}-${attempt}`, true);
								stream.push({ type: "error", reason: "aborted", error: final });
								stream.end(final);
							});
						},
						{ once: true },
					);
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: "x".repeat(40), partial });
				} else {
					stream.push({ type: "done", reason: "stop", message: partial });
					stream.end(partial);
				}
			});
			return stream;
		};
		const { logged, lines } = setup(provider);
		const cap = createResponseReasoningCapStreamFn(logged, { maxReasoningTokens: 2, maxWallMs: 10000 });
		const a = createAdaptiveEffortStreamFn(cap, { todoKind: () => "plan" });
		const b = createAdaptiveEffortStreamFn(cap, { todoKind: () => "edit" });
		const aContext = context("A");
		await finish(await a(model, aContext, { reasoning: "xhigh" }));
		const second = await a(model, aContext, { reasoning: "xhigh" });
		await abortSeen.ready;
		try {
			await finish(await b(model, context("B"), { reasoning: "xhigh" }));
		} finally {
			drain.release();
		}
		await finish(second);
		const byId = Object.fromEntries(lines().map((line) => [String(line.responseId), line]));
		expect(attempts.get("A")).toBe(3);
		expect(byId["A-2"]).toMatchObject({
			phase: "plan",
			phaseSource: "todo",
			effortGroup: "high",
			effortSwitch: { from: "low", to: "high", n: 1 },
		});
		expect(byId["A-3"]).toMatchObject({
			phase: "plan",
			phaseSource: "todo",
			effortGroup: "high",
			effortSwitch: null,
			effort: "high",
		});
		expect(byId["B-1"]).toMatchObject({ phase: "edit", phaseSource: "todo", effortGroup: "low", effortSwitch: null });
		expect(new Set(lines().map((line) => line.systemHash)).size).toBe(1);
		expect(new Set(lines().map((line) => line.toolsHash)).size).toBe(1);
	});
	it("does not attach another session's phase to a plain non-adaptive provider call", async () => {
		const provider: StreamFn = (_model, input) => {
			const id = input.messages[0].role === "user" ? String(input.messages[0].content) : "unknown";
			const stream = createAssistantMessageEventStream();
			const final = message(id);
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: final });
				stream.end(final);
			});
			return stream;
		};
		const { logged, lines } = setup(provider);
		await finish(
			await createAdaptiveEffortStreamFn(logged, { todoKind: () => "plan" })(model, context("adaptive"), {
				reasoning: "xhigh",
			}),
		);
		await finish(await logged(model, context("plain"), { reasoning: "xhigh" }));
		expect(lines().find((line) => line.responseId === "plain")).toMatchObject({ phase: null, phaseSource: null });
		expect(lines().find((line) => line.responseId === "plain")).not.toHaveProperty("effortGroup");
	});
});
