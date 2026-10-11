/**
 * #122 merge follow-up (Tech Lead, required): the `session` run-log record is diagnostics only. With a log
 * dir set and hashing failing, the prompt still runs, flag on and off.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "omk-agent-core";
import { fauxAssistantMessage } from "omk-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../src/core/skills.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

vi.mock("omk-ai/prompt-hash", async (importOriginal) => ({
	...(await importOriginal<typeof import("omk-ai/prompt-hash")>()),
	systemHash: () => {
		throw new Error("hash failed");
	},
}));

const harnesses: Harness[] = [];
const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omk-skill-search-log-failure-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const readTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "contents" }], details: {} }),
};

function skills(count: number): Skill[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `s${i}`,
		description: `Skill number ${i}.`,
		filePath: `/skills/s${i}/SKILL.md`,
		baseDir: `/skills/s${i}`,
		sourceInfo: { path: `/skills/s${i}/SKILL.md`, source: "test", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	}));
}

describe("skill-select session record failure", () => {
	for (const [label, env] of [
		["flag off", {}],
		["flag on (bm25)", { OMK_SKILL_SELECT: "bm25", OMK_SKILL_SEARCH_SUGGEST: "0" }],
	] as const) {
		it(`${label}: the prompt succeeds when the record cannot be hashed`, async () => {
			vi.stubEnv("OMK_CODING_AGENT_DIR", tempDir());
			vi.stubEnv("OMK_RUN_LOG_DIR", tempDir());
			vi.stubEnv("OMK_SKILL_SEARCH", undefined);
			vi.stubEnv("OMK_SKILL_SELECT", undefined);
			vi.stubEnv("OMK_SKILL_SEARCH_SUGGEST", undefined);
			for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
			const resourceLoader = createTestResourceLoader();
			resourceLoader.getSkills = () => ({ skills: skills(30), diagnostics: [] });
			const harness = await createHarness({ tools: [readTool], resourceLoader });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done")]);
			await expect(harness.session.prompt("Fill the PDF forms.")).resolves.toBeUndefined();
			expect(getAssistantTexts(harness)).toContain("done");
		});
	}
});
