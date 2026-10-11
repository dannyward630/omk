import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintSkills } from "../src/core/skill-index-store.ts";
import {
	SKILL_CANDIDATE_K,
	SKILL_CANDIDATES_CUSTOM_TYPE,
	SKILL_INDEX_ALGORITHM_VERSION,
	SKILL_INDEX_FILE,
	SkillSearchSession,
	shortHash,
} from "../src/core/skill-search.ts";
import {
	SKILL_SEARCH_PROMPT_LINE,
	skillSearchActivation,
	skillSearchFlagOn,
	skillSearchSuggestOn,
	skillSelectMode,
} from "../src/core/skill-search-mode.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSkillSearchToolDefinition } from "../src/core/tools/skill-search-tool.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omk-skill-search-"));
	dirs.push(dir);
	return dir;
}

/** Real SKILL.md files so the fingerprint sees size, mtime and inode. */
function writeSkills(root: string, entries: readonly [string, string][], hidden: readonly string[] = []): Skill[] {
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
			disableModelInvocation: hidden.includes(name),
		};
	});
}

function filler(count: number): [string, string][] {
	return Array.from({ length: count }, (_, i) => [`filler-${i}`, `General helper number ${i} for everyday chores.`]);
}

const NAMED: [string, string][] = [
	["pdf-forms", "Fill and extract PDF forms with pypdf."],
	["kubernetes-deploy", "Deploy services to a kubernetes cluster with helm charts."],
	["sql-tuning", "Tune slow SQL queries with explain plans and indexes."],
	["secret-pdf", "PDF redaction that only runs when asked explicitly."],
];

function session(
	root: string,
	skills: Skill[],
	logDir?: string,
	extra: { mode?: "bm25" | "metacon"; phase?: () => string | undefined } = {},
) {
	const env: NodeJS.ProcessEnv = logDir ? { OMK_RUN_LOG_DIR: logDir } : {};
	return new SkillSearchSession({ skills: () => skills, agentDir: join(root, "agent"), env, ...extra });
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("skill-search mode (spec 050 R1)", () => {
	const skills = (count: number) =>
		Array.from({ length: count }, (_, i) => ({ name: `s${i}`, disableModelInvocation: false }) as Skill);

	it("reads the flag values on/1/true/enable/enabled", () => {
		for (const value of ["on", "1", "true", "enable", "enabled", " ON "]) {
			expect(skillSearchFlagOn({ OMK_SKILL_SEARCH: value })).toBe(true);
		}
		for (const value of [undefined, "", "0", "off", "yes"]) {
			expect(skillSearchFlagOn({ OMK_SKILL_SEARCH: value })).toBe(false);
		}
		expect(skillSearchSuggestOn({})).toBe(true);
		expect(skillSearchSuggestOn({ OMK_SKILL_SEARCH_SUGGEST: "0" })).toBe(false);
	});

	it("is active only above 24 model-invocable skills with a read tool", () => {
		const on = { OMK_SKILL_SEARCH: "on" };
		expect(skillSearchActivation({}, skills(30), true)).toEqual({
			active: false,
			inactiveReason: "flag_off",
			mode: "off",
		});
		expect(skillSearchActivation(on, skills(24), true)).toEqual({
			active: false,
			inactiveReason: "few_skills",
			mode: "bm25",
		});
		const hidden = [...skills(24), { name: "x", disableModelInvocation: true } as Skill];
		expect(skillSearchActivation(on, hidden, true).inactiveReason).toBe("few_skills");
		expect(skillSearchActivation(on, skills(25), false)).toEqual({
			active: false,
			inactiveReason: "no_read_tool",
			mode: "bm25",
		});
		expect(skillSearchActivation(on, skills(25), true)).toEqual({
			active: true,
			inactiveReason: "none",
			mode: "bm25",
		});
	});

	it("reads OMK_SKILL_SELECT=bm25|metacon, which wins over the OMK_SKILL_SEARCH alias (spec 058 R1)", () => {
		expect(skillSelectMode({})).toEqual({ mode: "off", invalid: false });
		expect(skillSelectMode({ OMK_SKILL_SEARCH: "1" })).toEqual({ mode: "bm25", invalid: false });
		expect(skillSelectMode({ OMK_SKILL_SELECT: " MetaCon " })).toEqual({ mode: "metacon", invalid: false });
		expect(skillSelectMode({ OMK_SKILL_SELECT: "bm25", OMK_SKILL_SEARCH: "0" })).toEqual({
			mode: "bm25",
			invalid: false,
		});
		expect(skillSelectMode({ OMK_SKILL_SELECT: "metacon", OMK_SKILL_SEARCH: "1" }).mode).toBe("metacon");
		expect(skillSelectMode({ OMK_SKILL_SELECT: "", OMK_SKILL_SEARCH: "1" }).mode).toBe("bm25");
		for (const value of ["wpl", "on", "1", "bm25,metacon"]) {
			expect(skillSelectMode({ OMK_SKILL_SELECT: value, OMK_SKILL_SEARCH: "1" })).toEqual({
				mode: "off",
				invalid: true,
			});
		}
	});

	it("treats an unknown OMK_SKILL_SELECT value (wpl too) as off and warns, never as another mode", () => {
		const warnings: string[] = [];
		const warn = (env: NodeJS.ProcessEnv) => warnings.push(String(env.OMK_SKILL_SELECT));
		expect(skillSearchActivation({ OMK_SKILL_SELECT: "wpl" }, skills(30), true, warn)).toEqual({
			active: false,
			inactiveReason: "flag_off",
			mode: "off",
			invalidMode: true,
		});
		expect(warnings).toEqual(["wpl"]);
		expect(skillSearchActivation({ OMK_SKILL_SELECT: "metacon" }, skills(25), true, warn)).toEqual({
			active: true,
			inactiveReason: "none",
			mode: "metacon",
		});
		expect(warnings).toHaveLength(1);
	});

	it("has a fixed tool schema: query (<=512 chars) and limit 1..8", () => {
		const tool = createSkillSearchToolDefinition(async () => ({ text: "", details: {} as never }));
		expect(tool.name).toBe("skill_search");
		expect(JSON.stringify(tool.parameters)).toContain('"maxLength":512');
		expect(JSON.stringify(tool.parameters)).toContain('"maximum":8');
		expect(SKILL_SEARCH_PROMPT_LINE).toContain("skill_search");
	});
});

describe("SkillSearchSession (spec 050 R2–R5)", () => {
	it("returns name — short description — location lines, best first, without hidden skills", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)], ["secret-pdf"]);
		const result = session(root, skills).search("fill a pdf form", 5);
		expect(result.text.split("\n")[0]).toBe(
			`pdf-forms — Fill and extract PDF forms with pypdf. — ${join(root, "skills", "pdf-forms", "SKILL.md")}`,
		);
		expect(result.text).not.toContain("secret-pdf");
		expect(result.details).toMatchObject({
			query: "fill a pdf form",
			queryHash: shortHash("fill a pdf form"),
			limit: 5,
		});
		expect(result.details.matchCount).toBeGreaterThanOrEqual(1);
		expect(result.details.candidates[0]).toMatchObject({ name: "pdf-forms", location: skills[0].filePath });
		expect(result.details.candidates[0].score).toBeGreaterThan(0);
		expect(session(root, skills).search("zzzz", 5).text).toBe("No matching skills.");
	});

	it("builds the index on first use, caches it on disk, and rebuilds when a SKILL.md changes", () => {
		const root = tempDir();
		const logDir = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const indexPath = join(root, "agent", "cache", SKILL_INDEX_FILE);
		const first = session(root, skills, logDir);
		expect(existsSync(indexPath)).toBe(false);
		first.search("sql", 3);
		expect(existsSync(indexPath)).toBe(true);
		first.search("pdf", 3);
		session(root, skills, logDir).search("sql", 3);
		writeFileSync(skills[2].filePath, "---\nname: sql-tuning\ndescription: changed\n---\n");
		session(root, skills, logDir).search("sql", 3);
		writeFileSync(indexPath, "{not json");
		session(root, skills, logDir).search("sql", 3);
		const index = readLog(logDir).filter((record) => record.type === "index");
		expect(index.map((record) => record.cacheHit)).toEqual([false, true, false, false]);
		expect(index[0]).toMatchObject({ skills: 34, docsUsed: 34, truncated: false });
	});

	it("rebuilds a cache written by another index algorithm version", () => {
		const root = tempDir();
		const logDir = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const indexPath = join(root, "agent", "cache", SKILL_INDEX_FILE);
		session(root, skills, logDir).search("sql", 3);
		const written = JSON.parse(readFileSync(indexPath, "utf8"));
		expect(written.fingerprint).toBe(fingerprintSkills(skills, SKILL_INDEX_ALGORITHM_VERSION));
		expect(fingerprintSkills(skills, SKILL_INDEX_ALGORITHM_VERSION + 1)).not.toBe(written.fingerprint);
		// Same SKILL.md files, an older algorithm: the entry text may differ, so it is a miss.
		const old = { ...written, fingerprint: fingerprintSkills(skills, SKILL_INDEX_ALGORITHM_VERSION - 1) };
		writeFileSync(indexPath, JSON.stringify(old));
		session(root, skills, logDir).search("sql", 3);
		const index = readLog(logDir).filter((record) => record.type === "index");
		expect(index.map((record) => record.cacheHit)).toEqual([false, false]);
	});

	it("removes stale .tmp files next to the index and keeps fresh ones", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const cacheDir = join(root, "agent", "cache");
		mkdirSync(cacheDir, { recursive: true });
		const stale = join(cacheDir, `${SKILL_INDEX_FILE}.111.tmp`);
		const fresh = join(cacheDir, `${SKILL_INDEX_FILE}.222.tmp`);
		const unrelated = join(cacheDir, "other.111.tmp");
		for (const file of [stale, fresh, unrelated]) writeFileSync(file, "{}");
		const old = new Date(Date.now() - 10 * 60_000);
		utimesSync(stale, old, old);
		utimesSync(unrelated, old, old);
		session(root, skills).search("sql", 3);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
		expect(existsSync(join(cacheDir, SKILL_INDEX_FILE))).toBe(true);
	});

	it("offers each skill once per session and nothing below the score floor (AC 6)", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const search = session(root, skills);
		const first = search.suggest("Tune this slow SQL query and fill the PDF form");
		expect(first?.customType).toBe(SKILL_CANDIDATES_CUSTOM_TYPE);
		expect(first?.display).toBe(false);
		const content = String(first?.content);
		expect(content).toContain("<name>sql-tuning</name>");
		expect(content).toContain("<name>pdf-forms</name>");
		expect(content.match(/<skill>/g)?.length).toBeLessThanOrEqual(SKILL_CANDIDATE_K);
		expect(search.suggest("Tune this slow SQL query and fill the PDF form")).toBeUndefined();
		expect(search.suggest("say hello")).toBeUndefined();
		expect(search.offeredVia("sql-tuning")).toBe("suggest");
	});

	it("ranks task candidates on content words, not on words like 'and' or 'to'", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const content = String(session(root, skills).suggest("Fill the PDF forms and save the result to a.txt")?.content);
		expect(content).toContain("<name>pdf-forms</name>");
		expect(content).not.toContain("kubernetes-deploy");
		expect(content).not.toContain("sql-tuning");
	});

	it("logs hashes and numbers only (AC 7)", () => {
		const root = tempDir();
		const logDir = tempDir();
		const marker = "zebracornmarker";
		const skills = writeSkills(root, [[`${marker}-skill`, `Handles ${marker} tasks.`], ...filler(30)]);
		const search = session(root, skills, logDir);
		search.search(`find ${marker} please`, 3);
		search.suggest(`do the ${marker} task`);
		const text = readFileSync(join(logDir, "skill-select.jsonl"), "utf8");
		expect(text).not.toContain(marker);
		expect(text).not.toContain(root);
		const records = readLog(logDir);
		expect(records.map((record) => record.type)).toEqual(["index", "search", "suggest"]);
		expect(records[1]).toMatchObject({
			queryTokens: 3,
			limit: 3,
			returned: 1,
			skillHashes: [shortHash(`${marker}-skill`)],
		});
		expect(records[2]).toMatchObject({ trigger: "task", todoKind: "none", k: 1, belowFloor: false });
	});
});

describe("SkillSearchSession modes (spec 058 R2–R7)", () => {
	it("tags the tool details with the mode and each candidate's source", () => {
		const root = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		const bm25 = session(root, skills).search("pdf forms", 3).details;
		expect(bm25.mode).toBe("bm25");
		expect(bm25.candidates.every((candidate) => candidate.source === "bm25")).toBe(true);
		const metacon = session(root, skills, undefined, { mode: "metacon" }).search("pdf forms kubernetes", 3).details;
		expect(metacon.mode).toBe("metacon");
		expect(metacon.candidates.map((candidate) => candidate.name)).toContain("kubernetes-deploy");
		for (const candidate of metacon.candidates) expect(["metacon", "bm25-fill"]).toContain(candidate.source);
	});

	it("merges skills with the same loadSkills contentHash (R2)", () => {
		const root = tempDir();
		const skills = writeSkills(root, [
			["pdf-forms", "Fill PDF forms."],
			["pdf-forms-copy", "Fill PDF forms."],
			...filler(30),
		]).map((skill) => (skill.name.startsWith("pdf-forms") ? { ...skill, contentHash: "same" } : skill));
		const names = session(root, skills)
			.search("pdf forms", 5)
			.details.candidates.map((candidate) => candidate.name);
		expect(names).toEqual(["pdf-forms"]);
	});

	it("logs mode, candidate count, hashed top-k with scores and sources, latency and plan stats (R7)", () => {
		const root = tempDir();
		const logDir = tempDir();
		const marker = "zebracornmarker";
		const skills = writeSkills(root, [
			[`${marker}-skill`, `Handles ${marker} tasks.`],
			[`${marker}-helper`, `More ${marker} help.`],
			...filler(30),
		]);
		const search = session(root, skills, logDir, { mode: "metacon", phase: () => "debug" });
		search.search(`find ${marker} please`, 2);
		search.suggest(`do the ${marker} task`);
		const text = readFileSync(join(logDir, "skill-select.jsonl"), "utf8");
		expect(text).not.toContain(marker);
		expect(text).not.toContain(root);
		const [, searched, suggested] = readLog(logDir);
		for (const record of [searched, suggested]) {
			expect(record).toMatchObject({ mode: "metacon", phase: "debug", phaseSource: "todo" });
			expect(typeof record.candidateCount).toBe("number");
			expect(typeof record.latencyMs).toBe("number");
			expect(typeof record.planMs).toBe("number");
			expect(typeof record.prefilter).toBe("number");
		}
		const top = searched.top as { nameHash: string; score: number; source: string }[];
		expect(top).toHaveLength(2);
		expect(top[0].source).toBe("metacon");
		expect(top[1].source).toBe("bm25-fill");
		expect(top.map((entry) => entry.nameHash)).toEqual(
			expect.arrayContaining([shortHash(`${marker}-skill`), shortHash(`${marker}-helper`)]),
		);
	});

	it("uses the task phase when no todo kind is wired (049 not on main)", () => {
		const root = tempDir();
		const logDir = tempDir();
		const skills = writeSkills(root, [...NAMED, ...filler(30)]);
		session(root, skills, logDir, { mode: "metacon" }).search("pdf", 3);
		expect(readLog(logDir)[1]).toMatchObject({ phase: "task", phaseSource: "default" });
	});
});

function readLog(dir: string): Record<string, unknown>[] {
	return readFileSync(join(dir, "skill-select.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}
