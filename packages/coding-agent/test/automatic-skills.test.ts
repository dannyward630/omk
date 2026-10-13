import { describe, expect, it } from "vitest";
import { createActiveSkillState } from "../src/core/active-skill-state.ts";
import { automaticSkills } from "../src/core/automatic-skills.ts";
import { PromptSkillFreeze } from "../src/core/prompt-skill-message.ts";
import type { Skill } from "../src/core/skills.ts";

function skill(name: string, description: string, disableModelInvocation = false): Skill {
	return {
		name,
		description,
		disableModelInvocation,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "test", scope: "user", origin: "top-level" },
	};
}
const catalog = [
	skill("debugging", "Debug failing parser bugs and errors"),
	skill("frontend", "React frontend UI components"),
	skill("private", "Debug failing parser bugs", true),
];
function input(query: string, provider: string) {
	return {
		base: { cwd: "/w", skills: catalog },
		provider,
		selection: createActiveSkillState([], [], undefined),
		defaults: [],
		skills: catalog,
		harnessQuery: query,
		budgetQuery: query,
		contextPressure: () => false,
		contextBudget: () => undefined,
		env: {},
		now: () => 1,
	};
}

describe("automatic prompt skill activation", () => {
	it.each(["openai", "anthropic", "google", "faux"])("selects skills without a launcher for %s", async (provider) => {
		const turn = await new PromptSkillFreeze().turn(input("Debug failing parser bugs", provider));
		expect(turn.options.activeSkillNames).toContain("debugging");
		expect(turn.options.activeSkillNames).not.toContain("private");
		expect(turn.options.activeSkillSource).toContain("automatic");
	});

	it("keeps the system prefix frozen while switching skills for a later task", async () => {
		const freeze = new PromptSkillFreeze();
		const firstInput = input("Debug failing parser bugs", "openai");
		const first = await freeze.turn(firstInput);
		const second = await freeze.turn({
			...firstInput,
			harnessQuery: "React UI components",
			budgetQuery: "React UI components",
		});
		expect(second.options).toEqual(first.options);
		expect(second.messages.some((message) => String(message.content).includes("<name>frontend</name>"))).toBe(true);
	});

	it("routes Korean task intent to English metadata and keeps at most three distinct skills", () => {
		const aliases = Array.from({ length: 70 }, (_, i) => ({
			...catalog[0],
			name: `alias-${i}`,
			contentHash: "same",
		}));
		const result = automaticSkills("파이썬 버그 고쳐줘", [...aliases, ...catalog], {});
		expect(result.selected.length).toBeGreaterThan(0);
		expect(result.selected.length).toBeLessThanOrEqual(3);
		expect(result.selected.filter((entry) => entry.name.startsWith("alias-")).length).toBe(1);
	});

	it("does not dilute the primary task when verification is added in another clause", () => {
		const result = automaticSkills(
			"Debug the parser bug and add a regression test",
			[
				skill("debugging-fixture", "Debug parser bugs and errors"),
				skill("testing", "Regression tests and verification"),
			],
			{},
		);
		expect(result.selected.map((entry) => entry.name)).toContain("debugging-fixture");
		expect(result.selected.map((entry) => entry.name)).toContain("testing");
	});

	it("selects a relevant skill beyond the initial large-catalog prefix", () => {
		const many = Array.from({ length: 1000 }, (_, index) =>
			skill(`filler-${index}`, "Frontend components and layout"),
		);
		const result = automaticSkills("Debug parser bugs", [...many, catalog[0]], {});
		expect(result.selected.map((entry) => entry.name)).toContain("debugging");
		expect(result.scores.length).toBeLessThanOrEqual(64);
	});

	it("does not fabricate selections for idle, unrelated or explicit commands", () => {
		for (const query of [
			"",
			"hello there",
			"/skill:frontend Debug parser bugs",
			"! ls",
			'<skill name="manual">Debug parser bugs</skill>',
		]) {
			expect(automaticSkills(query, catalog, {}).selected).toEqual([]);
		}
	});

	it("keeps explicit prompt selections instead of adding automatic guesses", async () => {
		const turn = await new PromptSkillFreeze().turn({
			...input("Debug parser bugs", "openai"),
			selection: createActiveSkillState([], ["frontend"], "sdk"),
		});
		expect(turn.options.activeSkillNames).toEqual(["frontend"]);
	});

	it("honors an explicit opt-out", async () => {
		const turn = await new PromptSkillFreeze().turn({
			...input("Debug parser bugs", "openai"),
			env: { OMK_AUTO_SKILLS: "0" },
		});
		expect(turn.options.activeSkillNames).toEqual([]);
	});
});
