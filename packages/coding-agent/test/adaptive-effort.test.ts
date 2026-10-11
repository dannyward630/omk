import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "omk-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
} from "omk-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdaptiveEffortStreamFn, lowGroupEffort, MAX_EFFORT_SWITCHES } from "../src/core/adaptive-effort.ts";
import {
	createLlmCallRunLogStreamFn,
	type LlmCallPhaseFields,
	resetLlmCallRunLogClock,
	setLlmCallPhaseFields,
} from "../src/core/llm-call-run-log.ts";
import type { TodoKind } from "../src/core/phase-classifier.ts";
import { lowerReasoningEffort } from "../src/core/response-reasoning-cap.ts";

// Assembled at runtime so the secret scanner does not read the sentinel as a key.
const SECRET = ["SENTINEL", "037", "9f2a"].join("_");
const grok47 = getModel("xai", "grok-4.7");
const grok45 = getModel("xai", "grok-4.5");

// ---------------------------------------------------------------------------------------------
// Conversation helpers: a growing tool-using conversation, one outer call per assistant turn.

interface ToolUse {
	readonly name: string;
	readonly args?: Record<string, unknown>;
	readonly failed?: boolean;
}

let callId = 0;
const TOOLS: Context["tools"] = [
	{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
	{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
];

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "xai",
		model: "grok-4.7",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0,
	};
}

/** A conversation; `next(uses)` appends one assistant tool turn with its results and returns the context. */
function conversation(prompt = `Fix the bug ${SECRET}`) {
	const messages: Context["messages"] = [{ role: "user", content: prompt, timestamp: 0 }];
	const context = (): Context => ({ systemPrompt: "You are a coding agent.", messages: [...messages], tools: TOOLS });
	return {
		context,
		next(uses: readonly ToolUse[]): Context {
			const calls = uses.map((use) => ({
				type: "toolCall" as const,
				id: `call-${++callId}`,
				name: use.name,
				arguments: use.args ?? {},
			}));
			messages.push(assistant(calls));
			uses.forEach((use, i) => {
				messages.push({
					role: "toolResult",
					toolCallId: calls[i].id,
					toolName: use.name,
					content: [{ type: "text", text: use.failed ? "error" : "ok" }],
					isError: use.failed === true,
					timestamp: 0,
				});
			});
			return context();
		},
	};
}

const bash = (command: string, failed = false): ToolUse => ({ name: "bash", args: { command }, failed });
const HIGH_TURN = [bash("pytest -q tests/test_parse.py")]; // verify
const LOW_TURN = [bash("ls -la src")]; // explore

/** Fake inner stream recording the options of every call. */
function recorder() {
	const options: (SimpleStreamOptions | undefined)[] = [];
	const fn: StreamFn = (_model, _context, streamOptions) => {
		options.push(streamOptions);
		const stream = createAssistantMessageEventStream();
		const final = assistant([{ type: "text", text: "ok" }]);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: final });
			stream.end(final);
		});
		return stream;
	};
	return { fn, options, reasoning: () => options.map((o) => o?.reasoning) };
}

function adaptive(todo: { kind?: TodoKind } = {}) {
	const inner = recorder();
	const fields: (LlmCallPhaseFields | undefined)[] = [];
	const fn = createAdaptiveEffortStreamFn(inner.fn, { todoKind: () => todo.kind, record: (f) => fields.push(f) });
	const call = async (context: Context, options?: SimpleStreamOptions, model: Model<Api> = grok47) =>
		(await fn(model, context, options)).result();
	return { inner, fields, call, last: () => fields[fields.length - 1] };
}

afterEach(() => {
	setLlmCallPhaseFields(undefined);
	vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------

describe("phase resolution (spec 037 R3.1)", () => {
	it("resolves todo plan > tool signal > todo kind > previous phase", async () => {
		const todo: { kind?: TodoKind } = { kind: "plan" };
		const a = adaptive(todo);
		const conv = conversation();
		await a.call(conv.next([{ name: "edit" }]), { reasoning: "xhigh" });
		expect(a.last()).toMatchObject({ phase: "plan", phaseSource: "todo" });
		todo.kind = "edit";
		await a.call(conv.next(HIGH_TURN), { reasoning: "xhigh" });
		expect(a.last()).toMatchObject({ phase: "verify", phaseSource: "tool" });
		todo.kind = undefined;
		await a.call(conv.next([{ name: "read" }]), { reasoning: "xhigh" });
		expect(a.last()).toMatchObject({ phase: "explore", phaseSource: "tool" });
		todo.kind = "debug";
		await a.call(conv.context(), { reasoning: "xhigh" });
		expect(a.last()).toMatchObject({ phase: "debug", phaseSource: "todo" });
		todo.kind = undefined;
		await a.call(conv.next([{ name: "update_todo" }]), { reasoning: "xhigh" });
		expect(a.last()).toMatchObject({ phase: "debug", phaseSource: "todo" });
	});

	it("starts with no phase in the low group", async () => {
		const a = adaptive();
		await a.call(conversation().context(), { reasoning: "xhigh" });
		expect(a.last()).toEqual({
			phase: null,
			phaseSource: null,
			effortGroup: "low",
			effortSwitch: null,
			lowerClamped: false,
		});
	});
});

describe("effort switching (spec 037 R3.3–R3.5)", () => {
	it("starts low, switches after two high classifications, and back after two low ones", async () => {
		const a = adaptive();
		const conv = conversation();
		const ceiling: SimpleStreamOptions = { reasoning: "xhigh" };
		await a.call(conv.context(), ceiling); // no phase: low
		await a.call(conv.next(HIGH_TURN), ceiling); // 1st high: no switch yet
		expect(a.inner.reasoning()).toEqual(["high", "high"]);
		await a.call(conv.next(HIGH_TURN), ceiling); // 2nd high: switch
		expect(a.last()?.effortSwitch).toEqual({ from: "low", to: "high", n: 1 });
		expect(a.inner.options[2]).toBe(ceiling); // high group passes the caller's options unchanged
		await a.call(conv.next(LOW_TURN), ceiling); // 1st low: stays high
		expect(a.inner.options[3]).toBe(ceiling);
		await a.call(conv.next(LOW_TURN), ceiling); // 2nd low: back to high
		expect(a.last()?.effortSwitch).toEqual({ from: "high", to: "low", n: 2 });
		expect(a.inner.reasoning()).toEqual(["high", "high", "xhigh", "xhigh", "high"]);
	});

	it("does not switch on a single high classification between low ones", async () => {
		const a = adaptive();
		const conv = conversation();
		for (const turn of [LOW_TURN, HIGH_TURN, LOW_TURN, HIGH_TURN, LOW_TURN]) {
			await a.call(conv.next(turn), { reasoning: "xhigh" });
		}
		expect(a.inner.reasoning()).toEqual(["high", "high", "high", "high", "high"]);
		expect(a.fields.every((f) => f?.effortSwitch === null)).toBe(true);
	});

	it(`stops after ${MAX_EFFORT_SWITCHES} switches and stays in low`, async () => {
		const a = adaptive();
		const conv = conversation();
		for (let i = 0; i < 4; i++) {
			for (const turn of [HIGH_TURN, HIGH_TURN, LOW_TURN, LOW_TURN])
				await a.call(conv.next(turn), { reasoning: "xhigh" });
		}
		expect(a.last()?.effortGroup).toBe("low");
		for (const turn of [HIGH_TURN, HIGH_TURN, HIGH_TURN]) await a.call(conv.next(turn), { reasoning: "xhigh" });
		const switches = a.fields.flatMap((f) => (f?.effortSwitch ? [f.effortSwitch.n] : []));
		expect(switches).toEqual([1, 2, 3, 4]);
		expect(a.last()?.effortGroup).toBe("low");
		expect(a.inner.reasoning().slice(-3)).toEqual(["high", "high", "high"]);
	});

	it("counts a resolved debug phase as high (repeat failure of the same command)", async () => {
		const a = adaptive();
		const conv = conversation();
		await a.call(conv.next([bash("./build/app --input x", true)]), { reasoning: "xhigh" });
		expect(a.last()?.phase).toBe("run");
		await a.call(conv.next([bash("./build/app --input y", true)]), { reasoning: "xhigh" });
		expect(a.last()?.phase).toBe("debug");
	});
});

describe("low-group level and clamping (spec 037 R3.4)", () => {
	const noHigh = { ...grok47, thinkingLevelMap: { ...grok47.thinkingLevelMap, high: null } } as Model<Api>;
	const claudeLike = {
		...grok47,
		thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	} as Model<Api>;

	it.each([
		["grok-4.7 at max", grok47, "max", "high"],
		["grok-4.7 at xhigh", grok47, "xhigh", "high"],
		["a model mapping max separately", claudeLike, "max", "high"],
		["a model without high", noHigh, "xhigh", "medium"],
		["grok-4.7 at medium (ceiling below high)", grok47, "medium", undefined],
		["grok-4.7 at high", grok47, "high", undefined],
		["grok-4.5 at max (sends high)", grok45, "max", undefined],
		["reasoning off", grok47, undefined, undefined],
	] as const)("%s", (_label, model, ceiling, expected) => {
		expect(lowGroupEffort(model as Model<Api>, ceiling as ThinkingLevel | undefined)).toBe(expected);
	});

	it("passes options unchanged with lowerClamped and no switch counted when nothing lower can be sent", async () => {
		const a = adaptive();
		const conv = conversation();
		const ceiling: SimpleStreamOptions = { reasoning: "max" };
		for (const turn of [LOW_TURN, HIGH_TURN, HIGH_TURN, LOW_TURN, LOW_TURN])
			await a.call(conv.next(turn), ceiling, grok45);
		expect(a.inner.options.every((o) => o === ceiling)).toBe(true);
		expect(a.fields.every((f) => f?.lowerClamped === true && f.effortSwitch === null)).toBe(true);
		const off = adaptive();
		await off.call(conv.next(LOW_TURN), {});
		expect(off.inner.reasoning()).toEqual([undefined]);
		expect(off.last()?.lowerClamped).toBe(true);
	});

	it("never sends a level above the ceiling", async () => {
		const order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
		for (const ceiling of order as ThinkingLevel[]) {
			const a = adaptive();
			const conv = conversation();
			for (const turn of [LOW_TURN, HIGH_TURN, HIGH_TURN, LOW_TURN])
				await a.call(conv.next(turn), { reasoning: ceiling });
			for (const sent of a.inner.reasoning())
				expect(order.indexOf(sent as string)).toBeLessThanOrEqual(order.indexOf(ceiling));
		}
	});
});

describe("pass-through and state (spec 037 R3.6–R3.8, section 5)", () => {
	it("leaves calls without tools untouched and does not move the state", async () => {
		const a = adaptive();
		const conv = conversation();
		await a.call(conv.next(HIGH_TURN), { reasoning: "xhigh" });
		const summary: SimpleStreamOptions = { reasoning: "xhigh" };
		await a.call({ systemPrompt: "Summarize", messages: conv.context().messages }, summary);
		await a.call({ ...conv.context(), tools: [] }, summary);
		expect(a.inner.options[1]).toBe(summary);
		expect(a.inner.options[2]).toBe(summary);
		expect(a.fields.slice(1)).toEqual([undefined, undefined]);
		await a.call(conv.next(HIGH_TURN), { reasoning: "xhigh" }); // still the 2nd high classification
		expect(a.last()?.effortSwitch).toEqual({ from: "low", to: "high", n: 1 });
	});

	it("classifies each tool call id once, even when the same context is sent again", async () => {
		const a = adaptive();
		const conv = conversation();
		const failing = conv.next([bash("./run.sh", true)]);
		await a.call(failing, { reasoning: "xhigh" });
		await a.call(failing, { reasoning: "xhigh" }); // same context: no new tool call, no repeat failure
		expect(a.fields.map((f) => f?.phase)).toEqual(["run", "run"]);
	});

	it("passes model and context through as the same objects", async () => {
		const seen: unknown[] = [];
		const inner: StreamFn = (model, context, options) => {
			seen.push(model, context);
			return recorder().fn(model, context, options);
		};
		const fn = createAdaptiveEffortStreamFn(inner, { record: () => undefined });
		const context = conversation().next(LOW_TURN);
		await (await fn(grok47, context, { reasoning: "xhigh" })).result();
		expect(seen[0]).toBe(grok47);
		expect(seen[1]).toBe(context);
	});

	it("a 033 retry inside one outer call is not a classification and goes one below the sent effort", async () => {
		const provider = recorder();
		// Minimal stand-in for the 033 cap: one attempt, then a retry one step below the effort it was given.
		const capLike: StreamFn = async (model, context, options) => {
			await (await provider.fn(model, context, options)).result();
			return provider.fn(model, context, { ...options, reasoning: lowerReasoningEffort(options?.reasoning) });
		};
		const fields: (LlmCallPhaseFields | undefined)[] = [];
		const fn = createAdaptiveEffortStreamFn(capLike, { record: (f) => fields.push(f) });
		await (await fn(grok47, conversation().next(LOW_TURN), { reasoning: "xhigh" })).result();
		expect(provider.reasoning()).toEqual(["high", "medium"]);
		expect(fields).toHaveLength(1);
	});
});

describe("llm-call.jsonl fields (spec 037 R5)", () => {
	const roots: string[] = [];
	afterEach(() => {
		while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
	});

	it("fills phase, phaseSource and the effort fields, and never writes command or prompt text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omk-037-log-"));
		roots.push(dir);
		resetLlmCallRunLogClock();
		const provider = recorder();
		const fn = createAdaptiveEffortStreamFn(
			createLlmCallRunLogStreamFn(provider.fn, { env: { OMK_RUN_LOG_DIR: dir } }),
			{
				todoKind: () => undefined,
			},
		);
		const conv = conversation();
		for (const turn of [[bash(`pytest -k ${SECRET}`)], [bash(`pytest -k ${SECRET}`)]]) {
			await (await fn(grok47, conv.next(turn), { reasoning: "xhigh" })).result();
			await new Promise((resolve) => setImmediate(resolve));
		}
		await (await fn(grok47, { systemPrompt: "Summarize", messages: [] }, { reasoning: "xhigh" })).result();
		await new Promise((resolve) => setImmediate(resolve));
		const text = readFileSync(join(dir, "llm-call.jsonl"), "utf8");
		expect(text).not.toContain(SECRET);
		const lines = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.map((l) => [l.phase, l.phaseSource, l.effortGroup, l.effort, l.effortSent])).toEqual([
			["verify", "tool", "low", "high", "high"],
			["verify", "tool", "high", "xhigh", "xhigh"],
			[null, null, undefined, "xhigh", "xhigh"],
		]);
		expect(lines[1].effortSwitch).toEqual({ from: "low", to: "high", n: 1 });
		expect(lines[0].effortSwitch).toBeNull();
		expect(lines[0].lowerClamped).toBe(false);
		expect(lines[2]).not.toHaveProperty("effortSwitch");
	});
});

// ---------------------------------------------------------------------------------------------
// R2.1: with the flag off, the bytes a real provider stream sends are those of main.

const ADAPTIVE_MODULE = "../src/core/adaptive-effort.ts";

function startMockServer(bodies: string[]): Promise<Server> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			bodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
			res.write(chunk({ role: "assistant", content: "" }));
			res.write(chunk({ content: "hi" }));
			res.write(chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("flag off is main (spec 037 R2.1)", () => {
	let server: Server;
	let bodies: string[];
	let loads: number;
	let mockModel: Model<"openai-completions">;

	beforeEach(async () => {
		vi.resetModules();
		loads = 0;
		vi.doMock(ADAPTIVE_MODULE, async (importOriginal) => {
			loads++;
			return await importOriginal();
		});
		bodies = [];
		server = await startMockServer(bodies);
		const { port } = server.address() as AddressInfo;
		mockModel = {
			id: "mock-1",
			name: "mock-1",
			api: "openai-completions",
			provider: "mock",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} as Model<"openai-completions">;
	});

	afterEach(async () => {
		vi.doUnmock(ADAPTIVE_MODULE);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	/** Send a three-turn tool-using conversation through `createSdkProviderStream` with `env`. */
	async function run(flag: string | undefined): Promise<string[]> {
		bodies.length = 0;
		vi.stubEnv("OMK_ADAPTIVE_EFFORT", flag);
		const { createSdkProviderStream } = await import("../src/core/sdk-provider-stream.ts");
		const { AuthStorage } = await import("../src/core/auth-storage.ts");
		const { ModelRegistry } = await import("../src/core/model-registry.ts");
		const { SettingsManager } = await import("../src/core/settings-manager.ts");
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("mock", "x");
		const stream = createSdkProviderStream({
			modelRegistry: ModelRegistry.inMemory(authStorage),
			settingsManager: SettingsManager.inMemory(),
		});
		callId = 0;
		const conv = conversation("Fix the parser");
		for (const context of [conv.context(), conv.next([bash("ls src")]), conv.next([bash("pytest -q", true)])]) {
			await (await stream(mockModel, context, { reasoning: "xhigh", sessionId: "s" })).result();
		}
		return [...bodies];
	}

	it("sends byte-identical requests with the flag unset, 0 or anything but 1, and never loads the module", async () => {
		const unset = await run(undefined);
		expect(unset).toHaveLength(3);
		expect(unset[0]).toContain('"reasoning_effort":"xhigh"');
		for (const value of ["0", "true", " 1"]) expect(await run(value)).toEqual(unset);
		expect(loads).toBe(0);
	});

	it("control: with OMK_ADAPTIVE_EFFORT=1 the module loads and the low group sends high", async () => {
		const unset = await run(undefined);
		const on = await run("1");
		expect(loads).toBe(1);
		expect(on[0]).toContain('"reasoning_effort":"high"');
		expect(on[0].replace('"reasoning_effort":"high"', '"reasoning_effort":"xhigh"')).toBe(unset[0]);
	});
});
