import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkerProvider, workerExtensionArgs } from "../examples/extensions/subagent/worker-extensions.ts";
import { listLoadedExtensions } from "../src/core/extensions/internal-loaded-extensions.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";

// Spec 057 integration: the parent's real loaded-extension list feeds workerExtensionArgs,
// and the worker side runs main() in-process with that argv against a local
// OpenAI-compatible mock (same harness as print-mode-worker-cold-path.test.ts).
// Global fixture extensions write a marker file when they load.

type MockMode = "answer" | "bash-blocked";

interface MockServer {
	server: Server;
	bodies: string[];
	setMode(mode: MockMode): void;
}

function startMockServer(): Promise<MockServer> {
	const bodies: string[] = [];
	let mode: MockMode = "answer";
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (!req.url?.includes("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const body = Buffer.concat(chunks).toString("utf8");
			bodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
			const usage = { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
			const hasToolResult = body.includes('"role":"tool"');
			if (mode === "bash-blocked" && !hasToolResult) {
				res.write(chunk({ role: "assistant", content: "" }));
				res.write(
					chunk({
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "bash", arguments: JSON.stringify({ command: "git clean -fd" }) },
							},
						],
					}),
				);
				res.write(chunk({}, "tool_calls", usage));
				res.end("data: [DONE]\n\n");
				return;
			}
			res.write(chunk({ role: "assistant", content: "" }));
			res.write(chunk({ content: "hi" }));
			res.write(chunk({}, "stop", usage));
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({
				server,
				bodies,
				setMode: (next) => {
					mode = next;
				},
			}),
		),
	);
}

const MARKER_EXTENSION = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default function () {
	writeFileSync(join(process.env.OMK_057_MARKER_DIR ?? "/nonexistent", "marker-a"), "loaded");
}
`;

const PROVIDER_EXTENSION = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default function (omk) {
	writeFileSync(join(process.env.OMK_057_MARKER_DIR ?? "/nonexistent", "fixture-provider"), "loaded");
	omk.registerProvider("fixture-mock", {
		baseUrl: process.env.OMK_057_MOCK_BASE_URL,
		apiKey: "x",
		api: "openai-completions",
		models: [
			{
				id: "m1",
				name: "Fixture M1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
}
`;

const ENV_KEYS = [
	"OMK_CODING_AGENT_DIR",
	"OMK_FINISH_CHECK",
	"OMK_OFFLINE",
	"OMK_TRUST_PROJECT",
	"OMK_WORKER_EXTENSIONS",
	"OMK_057_MARKER_DIR",
	"OMK_057_MOCK_BASE_URL",
] as const;

describe("subagent worker extensions (spec 057 integration)", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let markerDir: string;
	let mock: MockServer;
	let originalCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let originalExitCode: typeof process.exitCode;
	let stdinTtyDescriptor: PropertyDescriptor | undefined;

	beforeEach(async () => {
		vi.resetModules();
		tempDir = join(tmpdir(), `omk-057-worker-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		markerDir = join(tempDir, "markers");
		for (const dir of [join(agentDir, "extensions"), projectDir, markerDir]) mkdirSync(dir, { recursive: true });
		mock = await startMockServer();
		const { port } = mock.server.address() as AddressInfo;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					mock: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "x",
						models: [{ id: "mock-1", contextWindow: 128000, maxTokens: 4096 }],
					},
				},
			}),
		);
		writeFileSync(join(agentDir, "auth.json"), "{}");
		writeFileSync(join(agentDir, "extensions", "marker-a.ts"), MARKER_EXTENSION);
		writeFileSync(join(agentDir, "extensions", "fixture-provider.ts"), PROVIDER_EXTENSION);

		originalCwd = process.cwd();
		savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env.OMK_CODING_AGENT_DIR = agentDir;
		process.env.OMK_FINISH_CHECK = "0";
		process.env.OMK_OFFLINE = "1";
		process.env.OMK_TRUST_PROJECT = "0";
		process.env.OMK_057_MARKER_DIR = markerDir;
		process.env.OMK_057_MOCK_BASE_URL = `http://127.0.0.1:${port}/v1`;
		delete process.env.OMK_WORKER_EXTENSIONS;
		process.chdir(projectDir);
		stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (stdinTtyDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
		else delete (process.stdin as { isTTY?: boolean }).isTTY;
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await new Promise<void>((resolve) => mock.server.close(() => resolve()));
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Parent side: load the global extensions as the parent would, then build the worker's extension argv. */
	async function workerArgsFromParent(model: string): Promise<string[]> {
		const parent = await discoverAndLoadExtensions([], projectDir, agentDir);
		expect(parent.errors).toEqual([]);
		const { args } = workerExtensionArgs({
			env: process.env,
			loaded: listLoadedExtensions(parent.runtime),
			workerProvider: resolveWorkerProvider(model, undefined),
			firstSpawn: false,
		});
		for (const marker of readdirSync(markerDir)) rmSync(join(markerDir, marker));
		return args;
	}

	async function runWorker(extensionArgs: string[], model: string, extra: string[] = []): Promise<string> {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: unknown,
			encodingOrCallback?: unknown,
			callback?: unknown,
		) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			if (typeof done === "function") queueMicrotask(() => done());
			return true;
		}) as typeof process.stdout.write);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit);
		const { main } = await import("../src/main.ts");
		await main([
			"--mode",
			"json",
			"-p",
			"--no-session",
			...extensionArgs,
			"--model",
			model,
			...extra,
			"Task: reply with hi",
		]);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		stdout.mockRestore();
		return output;
	}

	const marker = (name: string) => existsSync(join(markerDir, name));

	it("default spawn: the worker answers and loads no user extension", async () => {
		const args = await workerArgsFromParent("mock/mock-1");
		expect(args).toEqual(["--no-extensions"]);
		const output = await runWorker(args, "mock/mock-1");
		expect(output).toContain('"hi"');
		expect(process.exitCode ?? 0).toBe(0);
		expect(marker("marker-a")).toBe(false);
		expect(marker("fixture-provider")).toBe(false);
	});

	it("OMK_WORKER_EXTENSIONS=<name> loads that extension in the worker", async () => {
		process.env.OMK_WORKER_EXTENSIONS = "marker-a";
		const args = await workerArgsFromParent("mock/mock-1");
		expect(args).toEqual(["--no-extensions", "-e", join(agentDir, "extensions", "marker-a.ts")]);
		const output = await runWorker(args, "mock/mock-1");
		expect(output).toContain('"hi"');
		expect(marker("marker-a")).toBe(true);
		expect(marker("fixture-provider")).toBe(false);
	});

	it("forwards the extension that registered the worker's provider, and nothing else", async () => {
		const args = await workerArgsFromParent("fixture-mock/m1");
		expect(args).toEqual(["--no-extensions", "-e", join(agentDir, "extensions", "fixture-provider.ts")]);
		const output = await runWorker(args, "fixture-mock/m1");
		expect(output).toContain('"hi"');
		expect(process.exitCode ?? 0).toBe(0);
		expect(marker("fixture-provider")).toBe(true);
		expect(marker("marker-a")).toBe(false);
	});

	it("keeps the command-safety gate on in a --no-extensions worker", async () => {
		mock.setMode("bash-blocked");
		const args = await workerArgsFromParent("mock/mock-1");
		expect(args).toEqual(["--no-extensions"]);
		await runWorker(args, "mock/mock-1", ["--tools", "bash"]);
		expect(mock.bodies.length).toBeGreaterThanOrEqual(2);
		expect(mock.bodies[1]).toContain("git.clean_force");
		expect(marker("marker-a")).toBe(false);
	});
});
