import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { ImageContent, TextContent } from "omk-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { McpClient, McpContentBlock } from "../src/core/mcp/client.ts";
import { capMcpContent } from "../src/core/mcp/output-cap.ts";
import { createMcpToolDefinition, mapMcpContent } from "../src/core/mcp/tools.ts";
import { deleteSessionFile, sessionArtifactDir, type TrashSpawn } from "../src/core/session-artifacts.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES, truncateHead, truncateHeadTail } from "../src/core/tools/truncate.ts";

const MARKER =
	/^\[MCP output truncated: kept the start and the end; cut \d+ of \d+ lines \([\d.]+K?B of [\d.]+KB\) from the middle \(2000 lines \/ 50\.0KB limit\)\. /;

function session(): { dir: string; file: string; ctx: ExtensionContext } {
	const dir = mkdtempSync(join(tmpdir(), "omk-spec066-"));
	const file = join(dir, "sessions", "2026_abc.jsonl");
	return {
		dir,
		file,
		ctx: { cwd: dir, sessionManager: { getSessionFile: () => file } } as unknown as ExtensionContext,
	};
}

function tool(blocks: readonly McpContentBlock[], isError = false) {
	const client = { callTool: async () => ({ content: blocks, isError }) } as unknown as McpClient;
	return createMcpToolDefinition("srv", client, { name: "big", inputSchema: { type: "object" } });
}

const texts = (content: (TextContent | ImageContent)[]) =>
	content.filter((b): b is TextContent => b.type === "text").map((b) => b.text);

// Temp spills (no-session mode) are never cleaned up by omk, like bash's; remove the ones these tests made.
const tempSpillsBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("omk-mcp-")));
afterAll(() => {
	for (const f of readdirSync(tmpdir()))
		if (f.startsWith("omk-mcp-") && !tempSpillsBefore.has(f)) rmSync(join(tmpdir(), f), { force: true });
});

afterEach(() => {
	delete process.env.OMK_MCP_OUTPUT_CAP;
});

describe("spec 066 MCP output cap", () => {
	it("an oversized multi-line output reaches the model as head + one marker + tail <= 50KB, full text spilled 0600", async () => {
		const s = session();
		const full = Array.from({ length: 8000 }, (_, i) => `row ${i} ${"x".repeat(40)}`).join("\n");
		const result = await tool([{ type: "text", text: full }]).execute("call/1", {}, undefined, undefined, s.ctx);
		const [head, marker, tail, ...rest] = texts(result.content as (TextContent | ImageContent)[]);
		expect(rest).toEqual([]);
		expect(Buffer.byteLength(head + tail, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(full.startsWith(`${head}\n`)).toBe(true);
		expect(full.endsWith(`\n${tail}`)).toBe(true);
		expect(tail.endsWith("row 7999 " + "x".repeat(40))).toBe(true);
		expect(marker).toMatch(MARKER);
		expect(marker).toContain(`of 8000 lines`);
		const keptLines = head.split("\n").length + tail.split("\n").length;
		expect(marker).toContain(`cut ${8000 - keptLines} of 8000 lines`);
		const rel = /Full output: (\S+) \(use read/.exec(marker)?.[1] ?? "";
		expect(rel.startsWith("/")).toBe(false);
		const spill = join(s.dir, rel);
		expect(readFileSync(spill, "utf-8")).toBe(full);
		expect(statSync(spill).mode & 0o777).toBe(0o600);
		expect(statSync(sessionArtifactDir(s.file)).mode & 0o777).toBe(0o700);
		expect(spill.startsWith(sessionArtifactDir(s.file))).toBe(true);
	});

	it("large MCP output with error at the end: head+tail keeps it, head-only loses it", async () => {
		const s = session();
		const error = "ERROR: step 42 failed: connection refused (exit 1)";
		const full = `${Array.from({ length: 8000 }, (_, i) => `log ${i} ${"x".repeat(40)}`).join("\n")}\n${error}`;
		const result = await tool([{ type: "text", text: full }]).execute("c-err", {}, undefined, undefined, s.ctx);
		const seen = texts(result.content as (TextContent | ImageContent)[]).join("\n");
		expect(seen).toContain(error);
		// Recorded contrast (spec 066 criterion 6): the head-only strategy drops it.
		expect(truncateHead(full).content).not.toContain(error);
	});

	it("a single 400KB line keeps a byte prefix and suffix (no empty preview)", async () => {
		const s = session();
		const full = `{${'"k":"vé",'.repeat(40_000)}"error":"boom"}`;
		const result = await tool([{ type: "text", text: full }]).execute("c2", {}, undefined, undefined, s.ctx);
		const [head, marker, tail] = texts(result.content as (TextContent | ImageContent)[]);
		expect(head.length).toBeGreaterThan(20_000);
		expect(Buffer.byteLength(head + tail, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(full.startsWith(head)).toBe(true);
		expect(full.endsWith(tail)).toBe(true);
		expect(tail).toContain('"error":"boom"}');
		expect(marker).toMatch(MARKER);
		expect(marker).toContain("cut 0 of 1 lines");
	});

	it("isError results and multi-block results are capped combined; images kept", async () => {
		const s = session();
		const img: McpContentBlock = { type: "image", data: "AAAA", mimeType: "image/png" };
		const big = "e".repeat(30_000);
		const result = await tool([{ type: "text", text: big }, img, { type: "text", text: big }], true).execute(
			"c3",
			{},
			undefined,
			undefined,
			s.ctx,
		);
		const content = result.content as (TextContent | ImageContent)[];
		expect(content.map((b) => b.type)).toEqual(["text", "text", "text", "image"]);
		expect(texts(content)[1]).toMatch(MARKER);
		expect(result.details.isError).toBe(true);
	});

	describe("truncateHeadTail", () => {
		it("line-limited: keeps 1000 + 1000 lines and counts the cut", () => {
			const full = Array.from({ length: 5000 }, (_, i) => `${i}`).join("\n");
			const cut = truncateHeadTail(full);
			expect(cut.head.split("\n")).toHaveLength(1000);
			expect(cut.tail.split("\n")).toHaveLength(1000);
			expect(cut.head.split("\n")[0]).toBe("0");
			expect(cut.tail.split("\n").at(-1)).toBe("4999");
			expect(cut.omittedLines).toBe(3000);
			expect(cut.omittedBytes).toBe(
				Buffer.byteLength(full) - Buffer.byteLength(cut.head) - Buffer.byteLength(cut.tail),
			);
		});
		it("at the limits it is not truncated", () => {
			const at = "b".repeat(DEFAULT_MAX_BYTES);
			expect(truncateHeadTail(at)).toMatchObject({ truncated: false, head: at, tail: "", omittedLines: 0 });
		});
		it("multibyte text stays valid UTF-8 at both cuts", () => {
			const cut = truncateHeadTail("가".repeat(100_000));
			expect(cut.head.includes("\uFFFD") || cut.tail.includes("\uFFFD")).toBe(false);
			expect(Buffer.byteLength(cut.head + cut.tail)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		});
	});

	it("a context without a session manager (or none) still caps, and leaves small outputs untouched", async () => {
		const small = await tool([{ type: "text", text: "ok" }]).execute(
			"n1",
			{},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(small.content).toEqual([{ type: "text", text: "ok" }]);
		const none = await tool([{ type: "text", text: "ok" }]).execute(
			"n2",
			{},
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		expect(none.content).toEqual([{ type: "text", text: "ok" }]);
		const big = await tool([{ type: "text", text: "z\n".repeat(5000) }]).execute(
			"n3",
			{},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(texts(big.content as (TextContent | ImageContent)[])[1]).toMatch(
			/Full output: \/\S+omk-mcp-[0-9a-f]{16}\.log /,
		);
	});

	it("--no-session: full output goes to a bash-style 0600 temp file whose absolute path is in the marker", () => {
		const full = Array.from({ length: 5000 }, (_, i) => `z ${i}`).join("\n");
		const out = capMcpContent([{ type: "text", text: full }], {
			sessionFile: undefined,
			cwd: tmpdir(),
			toolCallId: "c4",
		});
		const path = /Full output: (\S+) \(use read/.exec(texts(out)[1])?.[1] ?? "";
		expect(path).toMatch(
			new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/omk-mcp-[0-9a-f]{16}\\.log$`),
		);
		expect(isAbsolute(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe(full);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("--no-session regression: a mid-output fact is recoverable by reading the saved file", async () => {
		// Bench Analyst 066 A/B: 200KB output with one fact in the middle; the model only had the marker.
		const fact = "THE-ANSWER-IS 7f3c-mid-output";
		const rows = Array.from({ length: 4000 }, (_, i) => `row ${i} ${"x".repeat(40)}`);
		rows.splice(2000, 0, fact);
		const full = rows.join("\n");
		const noSession = {
			cwd: tmpdir(),
			sessionManager: { getSessionFile: () => undefined },
		} as unknown as ExtensionContext;
		const result = await tool([{ type: "text", text: full }]).execute("mid", {}, undefined, undefined, noSession);
		const seen = texts(result.content as (TextContent | ImageContent)[]);
		expect(seen.join("\n")).not.toContain(fact);
		const path = /Full output: (\S+) \(use read/.exec(seen[1])?.[1] ?? "";
		expect(path).not.toBe("");
		const read = await createReadTool(tmpdir()).execute("r1", { path, offset: 1990, limit: 30 });
		const readText = (read.content as TextContent[]).map((b) => b.text).join("\n");
		expect(readText).toContain(fact);
	});

	it("session mode is unchanged: spill under <session>.artifacts/, relative path, no temp file", async () => {
		const s = session();
		const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("omk-mcp-")));
		const result = await tool([{ type: "text", text: "s\n".repeat(5000) }]).execute(
			"sm",
			{},
			undefined,
			undefined,
			s.ctx,
		);
		const marker = texts(result.content as (TextContent | ImageContent)[])[1];
		const rel = /Full output: (\S+) \(use read/.exec(marker)?.[1] ?? "";
		expect(isAbsolute(rel)).toBe(false);
		expect(join(s.dir, rel)).toBe(join(sessionArtifactDir(s.file), "mcp-sm.txt"));
		const after = readdirSync(tmpdir()).filter((f) => f.startsWith("omk-mcp-") && !before.has(f));
		expect(after).toEqual([]);
	});

	it("OMK_MCP_OUTPUT_CAP=0 restores the uncapped output", async () => {
		const s = session();
		const full = "q".repeat(400_000);
		process.env.OMK_MCP_OUTPUT_CAP = "0";
		const result = await tool([{ type: "text", text: full }]).execute("c5", {}, undefined, undefined, s.ctx);
		expect(result.content).toEqual([{ type: "text", text: full }]);
		expect(existsSync(sessionArtifactDir(s.file))).toBe(false);
	});

	describe("deleting the session takes <session>.artifacts/ with it", () => {
		async function sessionWithSpill() {
			const s = session();
			await tool([{ type: "text", text: "w".repeat(60_000) }]).execute("c6", {}, undefined, undefined, s.ctx);
			writeFileSync(s.file, "{}\n");
			expect(existsSync(sessionArtifactDir(s.file))).toBe(true);
			return s;
		}

		it("trash path: the artifacts directory is trashed together with the session", async () => {
			const s = await sessionWithSpill();
			const trashDir = join(s.dir, "Trash");
			mkdirSync(trashDir);
			const trashed: string[] = [];
			const spawn: TrashSpawn = (_command, args) => {
				const target = args.at(-1) ?? "";
				renameSync(target, join(trashDir, basename(target)));
				trashed.push(basename(target));
				return { status: 0, stderr: "" };
			};
			const deleted = await deleteSessionFile(s.file, spawn);
			expect(deleted).toEqual({ ok: true, method: "trash" });
			expect(trashed).toEqual([basename(s.file), basename(sessionArtifactDir(s.file))]);
			expect(existsSync(s.file)).toBe(false);
			expect(existsSync(sessionArtifactDir(s.file))).toBe(false);
			const spillName = readdirSync(join(trashDir, basename(sessionArtifactDir(s.file))));
			expect(spillName).toEqual(["mcp-c6.txt"]);
		});

		it("unlink fallback path: trash is unavailable, the session is unlinked and the artifacts deleted", async () => {
			const s = await sessionWithSpill();
			const calls: string[] = [];
			const spawn: TrashSpawn = (_command, args) => {
				calls.push(args.at(-1) ?? "");
				return { status: null, error: new Error("spawnSync trash ENOENT"), stderr: null };
			};
			const deleted = await deleteSessionFile(s.file, spawn);
			expect(deleted).toEqual({ ok: true, method: "unlink" });
			expect(calls).toEqual([s.file]);
			expect(existsSync(s.file)).toBe(false);
			expect(existsSync(sessionArtifactDir(s.file))).toBe(false);
		});
	});

	describe("small outputs are byte-identical to the uncapped path (golden)", () => {
		const exactLines = Array.from({ length: 2000 }, () => "l").join("\n");
		const cases: [string, McpContentBlock[]][] = [
			["empty", []],
			["empty text", [{ type: "text", text: "" }]],
			["one char", [{ type: "text", text: "a" }]],
			["short json", [{ type: "text", text: '{"ok":true,"n":1}' }]],
			["korean", [{ type: "text", text: "안녕하세요 결과입니다" }]],
			["emoji", [{ type: "text", text: "done ✅🎉" }]],
			["crlf", [{ type: "text", text: "a\r\nb\r\n" }]],
			["trailing newline", [{ type: "text", text: "line\n" }]],
			["tabs", [{ type: "text", text: "a\tb\tc" }]],
			["exactly 50KB", [{ type: "text", text: "b".repeat(DEFAULT_MAX_BYTES) }]],
			["exactly 2000 lines", [{ type: "text", text: exactLines }]],
			[
				"two blocks",
				[
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			],
			[
				"two blocks at limit",
				[
					{ type: "text", text: "c".repeat(25_000) },
					{ type: "text", text: "d".repeat(25_000) },
				],
			],
			["image only", [{ type: "image", data: "AAAA", mimeType: "image/png" }]],
			[
				"text + image",
				[
					{ type: "text", text: "see" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
			],
			["resource text", [{ type: "resource", resource: { uri: "file:///x", text: "body" } }]],
			["resource blob", [{ type: "resource", resource: { uri: "file:///x", blob: "AAAA" } }]],
			["unknown block", [{ type: "audio", data: "AAAA" } as unknown as McpContentBlock]],
			["markdown table", [{ type: "text", text: "| a | b |\n|---|---|\n| 1 | 2 |" }]],
			["error text", [{ type: "text", text: "Error: not found" }]],
			["nul and control", [{ type: "text", text: "a\u0000b\u0007c" }]],
			["49KB multibyte", [{ type: "text", text: "가".repeat(16_000) }]],
		];
		it.each(cases)("%s", async (_name, blocks) => {
			const s = session();
			const capped = await tool(blocks).execute("g", {}, undefined, undefined, s.ctx);
			process.env.OMK_MCP_OUTPUT_CAP = "0";
			const uncapped = await tool(blocks).execute("g", {}, undefined, undefined, s.ctx);
			expect(JSON.stringify(capped)).toBe(JSON.stringify(uncapped));
			const mapped = mapMcpContent(blocks);
			expect(capMcpContent(mapped, { sessionFile: s.file, cwd: s.dir, toolCallId: "g" })).toBe(mapped);
			expect(existsSync(sessionArtifactDir(s.file))).toBe(false);
		});
		it("has >= 20 cases", () => expect(cases.length).toBeGreaterThanOrEqual(20));
	});
});
