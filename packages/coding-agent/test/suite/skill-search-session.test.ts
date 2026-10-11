/**
 * Spec 050 AC 2 / AC 5 / AC 7 in-process: a skill-search session keeps the system prompt and the tool list
 * byte-identical for the whole conversation (task start, `skill_search`, `/reload`, a second task), and with
 * the flag on but too few skills (the bundled set) the outgoing requests equal the flag-off requests.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, StreamFn } from "omk-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, type Message } from "omk-ai";
import { serializePromptMessage, systemHash, toolsHash } from "omk-ai/prompt-hash";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { SKILL_INDEX_FILE } from "../../src/core/skill-search.ts";
import { SKILL_SEARCH_PROMPT_LINE, SKILL_SEARCH_TOOL_NAME } from "../../src/core/skill-search-mode.ts";
import { loadSkillsFromDir, type Skill } from "../../src/core/skills.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

interface Call {
	readonly system: string;
	readonly tools: string;
	readonly toolNames: readonly string[];
	readonly systemText: string;
	readonly messages: readonly string[];
	readonly userTexts: readonly string[];
}

const TASK_A = "Fill the PDF forms in forms/ and save the result to a.txt.";
const TASK_B = "Now tune the slow SQL query in report.sql.";
const MARKER = "zqxsecretmarker";

const harnesses: Harness[] = [];
const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omk-skill-search-session-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function readTool(): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "contents" }], details: {} }),
	};
}

/** A synthetic copy set above the 24-skill threshold, written to a temp dir (AC 8: never a real skill dir). */
function syntheticSkills(root: string): Skill[] {
	const entries: [string, string][] = [
		["pdf-forms", `Fill and extract PDF forms with pypdf ${MARKER}.`],
		["sql-tuning", "Tune slow SQL queries with explain plans and indexes."],
		["kubernetes-deploy", "Deploy services to a kubernetes cluster with helm charts."],
		...Array.from({ length: 30 }, (_, i): [string, string] => [`filler-${i}`, `General helper ${i} for chores.`]),
	];
	return entries.map(([name, description]) => {
		const dir = join(root, "skills", name);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "SKILL.md");
		writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
		return {
			name,
			description,
			filePath,
			baseDir: dir,
			sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
			disableModelInvocation: false,
		};
	});
}

function bundledSkills(): Skill[] {
	const dir = fileURLToPath(new URL("../../resources/neo/skills", import.meta.url));
	return loadSkillsFromDir({ dir, source: "builtin" }).skills;
}

function userTexts(context: Context): string[] {
	return context.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		const content = message.content;
		return [
			typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join(""),
		];
	});
}

interface RunOptions {
	readonly env: Record<string, string>;
	readonly skills: Skill[];
	readonly search?: boolean;
	readonly reload?: boolean;
	readonly extensions?: ExtensionFactory[];
	/** `setActiveToolsByName` before the first prompt (an allowlist or extension narrowing the tools). */
	readonly activeTools?: string[];
}

async function run(
	options: RunOptions,
): Promise<{ calls: Call[]; harness: Harness; agentDir: string; logDir: string }> {
	const agentDir = tempDir();
	const logDir = tempDir();
	vi.stubEnv("OMK_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OMK_RUN_LOG_DIR", logDir);
	vi.stubEnv("OMK_SKILL_SEARCH", undefined);
	vi.stubEnv("OMK_SKILL_SEARCH_SUGGEST", undefined);
	vi.stubEnv("OMK_SKILL_SELECT", undefined);
	for (const [key, value] of Object.entries(options.env)) vi.stubEnv(key, value);
	const resourceLoader = createTestResourceLoader({
		extensionsResult: await createTestExtensionsResult(options.extensions ?? []),
	});
	resourceLoader.getSkills = () => ({ skills: options.skills, diagnostics: [] });
	const harness = await createHarness({ tools: [readTool()], resourceLoader });
	harnesses.push(harness);
	const calls: Call[] = [];
	const inner = harness.session.agent.streamFn;
	harness.session.agent.streamFn = ((model, context, streamOptions) => {
		calls.push({
			system: systemHash(context),
			tools: toolsHash(context),
			toolNames: (context.tools ?? []).map((tool) => tool.name),
			systemText: context.systemPrompt ?? "",
			messages: context.messages.map((message: Message) => serializePromptMessage(message)),
			userTexts: userTexts(context),
		});
		return inner(model, context, streamOptions);
	}) as StreamFn;
	harness.setResponses([
		...(options.search
			? [
					fauxAssistantMessage([fauxToolCall(SKILL_SEARCH_TOOL_NAME, { query: `pdf forms ${MARKER}` })], {
						stopReason: "toolUse",
					}),
				]
			: []),
		fauxAssistantMessage("done with a"),
	]);
	if (options.activeTools) harness.session.setActiveToolsByName(options.activeTools);
	await harness.session.prompt(TASK_A);
	if (options.reload) await harness.session.reload();
	harness.appendResponses([fauxAssistantMessage("done with b")]);
	await harness.session.prompt(TASK_B);
	return { calls, harness, agentDir, logDir };
}

function prefixBreaks(calls: readonly Call[]): string[] {
	const breaks: string[] = [];
	calls.forEach((call, i) => {
		if (call.system !== calls[0].system) breaks.push(`call ${i}: system changed`);
		if (call.tools !== calls[0].tools) breaks.push(`call ${i}: tools changed`);
		const previous = calls[i - 1];
		const changed = previous?.messages.findIndex((message, j) => call.messages[j] !== message) ?? -1;
		if (changed !== -1) breaks.push(`call ${i}: message ${changed} of call ${i - 1} changed`);
	});
	return breaks;
}

function readAll(dir: string): string {
	return readdirSync(dir)
		.map((name) => readFileSync(join(dir, name), "utf8"))
		.join("\n");
}

describe("skill-search session (spec 050)", () => {
	it("keeps system and tools byte-identical across tasks, skill_search and /reload (AC 2)", async () => {
		const skills = syntheticSkills(tempDir());
		const { calls, agentDir } = await run({ env: { OMK_SKILL_SEARCH: "1" }, skills, search: true, reload: true });
		expect(calls.length).toBeGreaterThanOrEqual(3);
		expect(prefixBreaks(calls)).toEqual([]);
		expect(calls[0].toolNames).toContain(SKILL_SEARCH_TOOL_NAME);
		expect(calls[0].systemText).toContain(SKILL_SEARCH_PROMPT_LINE.trim());
		expect(calls[0].systemText).not.toContain("<available_skills>");
		expect(calls[0].systemText).not.toContain("pdf-forms");
		// R3: task A gets the PDF candidate as an end message; the tool result lists it too.
		expect(calls[0].userTexts.join("\n")).toContain("pdf-forms");
		expect(calls[0].userTexts.join("\n")).not.toContain("kubernetes-deploy");
		const toolResult = calls[1].messages.find((message) => message.includes('"toolName":"skill_search"'));
		expect(toolResult).toContain("pdf-forms");
		// AC 6: task B does not re-offer pdf-forms; it offers the SQL skill.
		const last = calls.at(-1)?.userTexts.at(-1) ?? "";
		expect(last).toContain("sql-tuning");
		expect(last).not.toContain("pdf-forms");
		expect(existsSync(join(agentDir, "cache", SKILL_INDEX_FILE))).toBe(true);
	});

	it("writes no query, skill name or path to the run log (AC 7)", async () => {
		const root = tempDir();
		const { logDir } = await run({ env: { OMK_SKILL_SEARCH: "1" }, skills: syntheticSkills(root), search: true });
		const log = readAll(logDir);
		expect(log).toContain('"type":"session"');
		expect(log).toContain('"type":"search"');
		expect(log).not.toContain(MARKER);
		expect(log).not.toContain("pdf-forms");
		expect(log).not.toContain(root);
	});

	it("gives workers the tool but no automatic candidates (R7)", async () => {
		const { calls } = await run({
			env: { OMK_SKILL_SEARCH: "1", OMK_SKILL_SEARCH_SUGGEST: "0" },
			skills: syntheticSkills(tempDir()),
		});
		expect(calls[0].toolNames).toContain(SKILL_SEARCH_TOOL_NAME);
		expect(calls.flatMap((call) => call.userTexts).join("\n")).not.toContain("<skill_candidates>");
	});

	it("sends the same requests with the flag on as off for the bundled skills (AC 5)", async () => {
		const skills = bundledSkills();
		expect(skills.length).toBeLessThanOrEqual(24);
		const off = await run({ env: {}, skills });
		const on = await run({ env: { OMK_SKILL_SEARCH: "1" }, skills });
		// Only the per-run temp cwd differs; it is replaced before the byte comparison.
		const view = (result: { calls: Call[]; harness: Harness }) =>
			result.calls.map(({ systemText, toolNames, messages }) => ({
				systemText: systemText.split(result.harness.tempDir).join("<cwd>"),
				toolNames,
				messages,
			}));
		expect(view(on)).toEqual(view(off));
		expect(existsSync(join(on.agentDir, "cache", SKILL_INDEX_FILE))).toBe(false);
	});
});

describe("skill-select modes (spec 058)", () => {
	const view = (result: { calls: Call[]; harness: Harness }) =>
		result.calls.map(({ systemText, toolNames, messages }) => ({
			systemText: systemText.split(result.harness.tempDir).join("<cwd>"),
			toolNames,
			messages,
		}));
	const sessionRecord = (logDir: string) =>
		readAll(logDir)
			.split("\n")
			.filter((line) => line.includes('"type":"session"'))
			.map((line) => JSON.parse(line) as Record<string, unknown>)[0];

	for (const mode of ["bm25", "metacon"] as const) {
		it(`${mode}: system and tools stay byte-identical across tasks, skill_search and /reload (AC 3)`, async () => {
			const skills = syntheticSkills(tempDir());
			const { calls, logDir } = await run({ env: { OMK_SKILL_SELECT: mode }, skills, search: true, reload: true });
			expect(calls.length).toBeGreaterThanOrEqual(3);
			expect(prefixBreaks(calls)).toEqual([]);
			expect(calls[0].toolNames).toContain(SKILL_SEARCH_TOOL_NAME);
			expect(calls[0].systemText).toContain(SKILL_SEARCH_PROMPT_LINE.trim());
			const toolResult = calls[1].messages.find((message) => message.includes('"toolName":"skill_search"'));
			expect(toolResult).toContain("pdf-forms");
			expect(sessionRecord(logDir)).toMatchObject({ active: true, mode });
		});

		it(`${mode}: the run log has no query, skill name or path (AC 5)`, async () => {
			const root = tempDir();
			const { logDir } = await run({ env: { OMK_SKILL_SELECT: mode }, skills: syntheticSkills(root), search: true });
			const log = readAll(logDir);
			expect(log).toContain(`"mode":"${mode}"`);
			expect(log).not.toContain(MARKER);
			expect(log).not.toContain("pdf-forms");
			expect(log).not.toContain(root);
		});

		it(`${mode}: 24 skills or fewer sends the same requests as off (AC 1)`, async () => {
			const skills = bundledSkills();
			const off = await run({ env: {}, skills });
			const on = await run({ env: { OMK_SKILL_SELECT: mode }, skills });
			expect(view(on)).toEqual(view(off));
			expect(existsSync(join(on.agentDir, "cache", SKILL_INDEX_FILE))).toBe(false);
		});
	}

	it("OMK_SKILL_SELECT=wpl is off: same requests as off, invalidMode in the session record (AC 1)", async () => {
		const skills = syntheticSkills(tempDir());
		const off = await run({ env: {}, skills });
		const wpl = await run({ env: { OMK_SKILL_SELECT: "wpl", OMK_SKILL_SEARCH: "1" }, skills });
		expect(view(wpl)).toEqual(view(off));
		expect(sessionRecord(wpl.logDir)).toMatchObject({ active: false, mode: "off", invalidMode: true });
	});
});

/** An extension tool that happens to be called `skill_search` (no prompt snippet, so no prompt line of its own). */
const foreignSkillSearch: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: SKILL_SEARCH_TOOL_NAME,
		label: "Foreign skill search",
		description: "Someone else's skill_search.",
		parameters: Type.Object({ q: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "foreign" }], details: {} }),
	});
};

describe("a foreign tool named skill_search (#122 review)", () => {
	const view = (result: { calls: Call[]; harness: Harness }) =>
		result.calls.map(({ systemText, toolNames, messages }) => ({
			systemText: systemText.split(result.harness.tempDir).join("<cwd>"),
			toolNames,
			messages,
		}));

	it("flag off: keeps <available_skills> and the same system prompt as without the tool", async () => {
		const skills = syntheticSkills(tempDir());
		const without = await run({ env: {}, skills });
		const foreign = await run({ env: {}, skills, extensions: [foreignSkillSearch] });
		expect(foreign.calls[0].systemText).toContain("<available_skills>");
		expect(foreign.calls[0].systemText).not.toContain(SKILL_SEARCH_PROMPT_LINE.trim());
		expect(view(foreign).map((call) => call.systemText)).toEqual(view(without).map((call) => call.systemText));
	});

	it("flag on: skips our tool, warns once and behaves exactly like flag off", async () => {
		const skills = syntheticSkills(tempDir());
		const off = await run({ env: {}, skills, extensions: [foreignSkillSearch] });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const on = await run({ env: { OMK_SKILL_SEARCH: "1" }, skills, extensions: [foreignSkillSearch] });
		const warnings = stderr.mock.calls.filter(([chunk]) => String(chunk).includes("already named skill_search"));
		stderr.mockRestore();
		expect(warnings).toHaveLength(1);
		expect(on.calls[0].toolNames.filter((name) => name === SKILL_SEARCH_TOOL_NAME)).toHaveLength(1);
		expect(on.calls[0].systemText).toContain("<available_skills>");
		expect(on.calls.flatMap((call) => call.userTexts).join("\n")).not.toContain("<skill_candidates>");
		expect(view(on)).toEqual(view(off));
		expect(readAll(on.logDir)).toContain('"inactiveReason":"name_conflict"');
	});
});

describe("skill_search left out of the active tools (058 follow-up)", () => {
	it("turns the session off: <available_skills> stays, no candidate message, tool_inactive in the log", async () => {
		const skills = syntheticSkills(tempDir());
		const on = await run({ env: { OMK_SKILL_SELECT: "metacon" }, skills, activeTools: ["read"] });
		for (const call of on.calls) {
			expect(call.toolNames).not.toContain(SKILL_SEARCH_TOOL_NAME);
			expect(call.systemText).toContain("<available_skills>");
			expect(call.systemText).not.toContain(SKILL_SEARCH_PROMPT_LINE.trim());
		}
		expect(on.calls.flatMap((call) => call.userTexts).join("\n")).not.toContain("<skill_candidates>");
		expect(readAll(on.logDir)).toContain('"inactiveReason":"tool_inactive"');
	});
});
