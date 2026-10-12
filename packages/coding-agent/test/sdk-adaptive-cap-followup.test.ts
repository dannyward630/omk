import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, getModel } from "omk-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createSdkProviderStream } from "../src/core/sdk-provider-stream.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { resetCurrentTodoState, setCurrentTodoState } from "../src/core/todo-runtime-state.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	resetCurrentTodoState();
});

describe("SDK adaptive effort and production cap follow-up", () => {
	it("retries at the actual lowered effort, keeps phase and request prefix, and records no todo text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omk-sdk-adaptive-cap-"));
		const bodies: Record<string, unknown>[] = [];
		const server = createServer((request, response) => {
			let text = "";
			request.on("data", (data) => {
				text += data;
			});
			request.on("end", () => {
				bodies.push(JSON.parse(text) as Record<string, unknown>);
				response.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (delta: object, finish: string | null = null) =>
					`data: ${JSON.stringify({ id: `local-${bodies.length}`, object: "chat.completion.chunk", created: 0, model: "grok-4.7", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				response.write(chunk({ role: "assistant" }));
				if (bodies.length === 2) response.write(chunk({ reasoning_content: "x".repeat(40) }));
				else response.write(chunk({ content: "ok" }, "stop"));
				response.end("data: [DONE]\n\n");
			});
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing local mock port");
			for (const [name, value] of Object.entries({
				OMK_ADAPTIVE_EFFORT: "1",
				OMK_RESPONSE_REASONING_CAP: "1",
				OMK_RESPONSE_REASONING_CAP_TOKENS: "2",
				OMK_RESPONSE_WALL_CAP_SEC: "10",
				OMK_RUN_LOG_DIR: dir,
			}))
				vi.stubEnv(name, value);
			setCurrentTodoState({
				items: [{ id: "p", status: "active", kind: "plan", label: "SYNTHETIC_TODO_LABEL" }],
				updatedAt: 0,
			});
			const auth = AuthStorage.inMemory();
			auth.setRuntimeApiKey("xai", "local-mock-only");
			const stream = createSdkProviderStream({
				modelRegistry: ModelRegistry.inMemory(auth),
				settingsManager: SettingsManager.inMemory(),
			});
			const model = { ...getModel("xai", "grok-4.7"), baseUrl: `http://127.0.0.1:${address.port}/v1` };
			const context: Context = {
				systemPrompt: "Synthetic fixed system",
				messages: [{ role: "user", content: "Synthetic fixed request", timestamp: 0 }],
				tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
			};
			await (await stream(model, context, { reasoning: "xhigh" })).result();
			const result = await (await stream(model, context, { reasoning: "xhigh" })).result();
			await new Promise((resolve) => setImmediate(resolve));
			expect(result.diagnostics?.some((d) => d.type === "response_reasoning_cap_retry")).toBe(true);
			expect(bodies.map((body) => body.reasoning_effort)).toEqual(["high", "xhigh", "high"]);
			expect(new Set(bodies.map((body) => JSON.stringify([body.model, body.messages, body.tools]))).size).toBe(1);
			const log = readFileSync(join(dir, "llm-call.jsonl"), "utf8");
			expect(log).not.toContain("SYNTHETIC_TODO_LABEL");
			expect(log).not.toContain("Synthetic fixed request");
			const lines = log
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines).toHaveLength(3);
			expect(lines.map((line) => line.phase)).toEqual(["plan", "plan", "plan"]);
			expect(lines[1].effortSwitch).toEqual({ from: "low", to: "high", n: 1 });
			expect(lines[2].effortSwitch).toBeNull();
			expect(new Set(lines.map((line) => line.systemHash)).size).toBe(1);
			expect(new Set(lines.map((line) => line.toolsHash)).size).toBe(1);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
