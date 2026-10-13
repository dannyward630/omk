import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { getModel, streamSimple } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { requestPromptCompletion } from "../src/modes/interactive/prompt-completion-request.ts";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});

describe("prompt completion real HTTP adapter", () => {
	it("sends only the draft to the configured model endpoint and receives a safe suffix", async () => {
		let body: unknown;
		let testHeader: string | string[] | undefined;
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			testHeader = request.headers["x-fixture"];
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-text", choices: [{ index: 0, delta: { role: "assistant", content: " and verify it" }, finish_reason: null }] })}\n\n`,
			);
			response.end(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-text", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		});
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture endpoint");
		const model = {
			...getModel("openai", "gpt-4o"),
			id: "fixture-text",
			api: "openai-completions" as const,
			provider: "fixture",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
		};
		const runtime = {
			model,
			agent: { streamFn: streamSimple },
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({
					ok: true as const,
					apiKey: "fixture-key",
					headers: { "X-Fixture": "verified" },
				}),
			},
		};
		const suffix = await requestPromptCompletion(runtime, "Debug the parser bug", new AbortController().signal);
		expect(suffix).toBe(" and verify it");
		expect(body).toMatchObject({
			model: "fixture-text",
			stream: true,
			messages: [
				{ role: "system", content: expect.any(String) },
				{ role: "user", content: "Debug the parser bug" },
			],
		});
		expect(body).not.toHaveProperty("tools");
		expect(testHeader).toBe("verified");
	});
});
