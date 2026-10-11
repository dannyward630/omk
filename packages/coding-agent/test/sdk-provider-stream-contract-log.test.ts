import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelContract, StreamFn } from "omk-agent-core";
import { type AssistantMessage, getModel, type SimpleStreamOptions } from "omk-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

// #128 review: the llm-call line must describe the request the provider really got, so the
// model contract is applied above the log and `effort`/`effortSent` are read after it.
const sent = vi.hoisted(() => [] as { model: { id: string }; options: SimpleStreamOptions }[]);
const logged = vi.hoisted(() => [] as (SimpleStreamOptions | undefined)[]);

vi.mock("omk-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("omk-ai")>();
	return {
		...actual,
		streamSimple: ((model, _context, options) => {
			sent.push({ model, options: options ?? {} });
			const stream = actual.createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 5,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 6,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			};
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		}) satisfies typeof actual.streamSimple,
	};
});

vi.mock("../src/core/llm-call-run-log.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/llm-call-run-log.ts")>();
	return {
		...actual,
		createLlmCallRunLogStreamFn: (
			inner: StreamFn,
			options?: Parameters<typeof actual.createLlmCallRunLogStreamFn>[1],
		) => {
			const log = actual.createLlmCallRunLogStreamFn(inner, options);
			return ((model, context, streamOptions) => {
				logged.push(streamOptions);
				return log(model, context, streamOptions);
			}) satisfies StreamFn;
		},
	};
});

const { createSdkProviderStream } = await import("../src/core/sdk-provider-stream.ts");
const { AuthStorage } = await import("../src/core/auth-storage.ts");
const { ModelRegistry } = await import("../src/core/model-registry.ts");
const { SettingsManager } = await import("../src/core/settings-manager.ts");
const { effortSentFor } = await import("../src/core/llm-call-run-log.ts");

const model = getModel("xai", "grok-4.7");
const contract: ModelContract = {
	allowedModels: [{ provider: "xai", id: "grok-4.7" }],
	allowedProviders: ["xai"],
	allowedAuthOrigins: ["xai"],
	thinking: true,
	maxOutputTokens: 1234,
};

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	sent.length = 0;
	logged.length = 0;
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("llm-call effort is read after the model contract (#128 review)", () => {
	it("logs the effort and wire value of the options the provider was called with", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omk-contract-log-"));
		dirs.push(dir);
		vi.stubEnv("OMK_RUN_LOG_DIR", dir);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("xai", "test-key");
		const stream = createSdkProviderStream({
			modelRegistry: ModelRegistry.inMemory(authStorage),
			settingsManager: SettingsManager.inMemory(),
			modelContract: contract,
		});
		const context = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
		await (await stream(model, context, { reasoning: "max" })).result();
		await new Promise((resolve) => setImmediate(resolve));

		expect(sent).toHaveLength(1);
		expect(logged).toHaveLength(1);
		// The log saw the contract's options (maxTokens filled in by the contract), not the caller's.
		expect(logged[0]?.maxTokens).toBe(1234);
		expect(sent[0].options.maxTokens).toBe(1234);
		const line = JSON.parse(readFileSync(join(dir, "llm-call.jsonl"), "utf8").trim()) as Record<string, unknown>;
		expect(line.effort).toBe(sent[0].options.reasoning);
		expect(line.effortSent).toBe(effortSentFor(model, sent[0].options.reasoning));
		expect(line.effortSent).toBe("xhigh");
	});
});
