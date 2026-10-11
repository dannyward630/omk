/**
 * Spec 055: skill startup path work.
 *
 * 1. Each skill path is realpath'd once per reload. The memo only replaces a
 *    `canonicalizePath(x)` call with an earlier result for the same `x`, so every
 *    dedupe comparison must see the same strings as without the memo (main).
 * 2. `collectSkillEntries` finds ignore files in its `readdir` listing instead of
 *    probing each name with `existsSync`, with the same ignore outcome.
 *
 * `node:fs` is wrapped (delegating) so the tests can count realpath/existsSync calls.
 */
import {
	type Dirent,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addIgnoreRules } from "../../src/core/ignore-rules.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { type CanonicalPathMemo, canonicalizeOnce, canonicalizePath } from "../../src/utils/paths.ts";

const fsCalls = vi.hoisted(() => ({ realpath: [] as string[], exists: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const realpathSync = Object.assign(
		(path: string): string => {
			fsCalls.realpath.push(String(path));
			return actual.realpathSync(path);
		},
		{ native: actual.realpathSync.native },
	) as unknown as typeof actual.realpathSync;
	const existsSync = (path: string): boolean => {
		fsCalls.exists.push(String(path));
		return actual.existsSync(path);
	};
	return { ...actual, realpathSync, existsSync: existsSync as typeof actual.existsSync };
});

const IGNORE_NAMES = new Set([".gitignore", ".ignore", ".fdignore"]);

function writeSkill(dir: string, name: string, body = "Content"): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} skill for spec 055 tests\n---\n${body}\n`);
	return filePath;
}

function countCalls(calls: string[], path: string): number {
	return calls.filter((call) => call === path).length;
}

describe("spec 055: skill startup path work", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let skillsDir: string;
	let previousHome: string | undefined;

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "omk-055-")));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		skillsDir = join(agentDir, "skills");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(tempDir, "home"), { recursive: true });
		previousHome = process.env.HOME;
		process.env.HOME = join(tempDir, "home");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Six skills, a name collision with different content, and the same skill
	 * reached three more ways: a symlinked skill dir, a symlinked SKILL.md, and
	 * a symlink to a skill dir outside the skills root.
	 */
	function buildSymlinkFixture(): { files: string[]; aliases: Record<string, string> } {
		const files = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((name) =>
			writeSkill(join(skillsDir, name), name),
		);
		files.push(writeSkill(join(skillsDir, "dup-a"), "dup", "first body"));
		files.push(writeSkill(join(skillsDir, "dup-b"), "dup", "second body"));

		symlinkSync(join(skillsDir, "alpha"), join(skillsDir, "alpha-link"), "dir");
		mkdirSync(join(skillsDir, "beta-file"), { recursive: true });
		symlinkSync(join(skillsDir, "beta", "SKILL.md"), join(skillsDir, "beta-file", "SKILL.md"), "file");
		const outside = writeSkill(join(tempDir, "shared", "omega"), "omega");
		symlinkSync(join(tempDir, "shared", "omega"), join(skillsDir, "omega-link"), "dir");

		return {
			files: [...files, outside],
			aliases: {
				alphaViaDir: join(skillsDir, "alpha-link", "SKILL.md"),
				betaViaFile: join(skillsDir, "beta-file", "SKILL.md"),
				omegaViaDir: join(skillsDir, "omega-link", "SKILL.md"),
			},
		};
	}

	describe("realpath once", () => {
		it("canonicalizeOnce without a memo is canonicalizePath, and with a memo resolves each input once", () => {
			const { files, aliases } = buildSymlinkFixture();
			const inputs = [...files, ...Object.values(aliases), join(tempDir, "missing", "SKILL.md")];
			const memo: CanonicalPathMemo = new Map();
			for (const input of inputs) {
				expect(canonicalizeOnce(input, undefined)).toBe(canonicalizePath(input));
			}
			fsCalls.realpath.length = 0;
			for (const input of [...inputs, ...inputs]) {
				expect(canonicalizeOnce(input, memo)).toBe(canonicalizePath(input));
			}
			for (const input of inputs) {
				// one call from the memo fill, one per direct canonicalizePath comparison (2 rounds)
				expect(countCalls(fsCalls.realpath, input)).toBe(3);
			}
			expect(memo.get(aliases.alphaViaDir)).toBe(join(skillsDir, "alpha", "SKILL.md"));
			expect(memo.get(join(tempDir, "missing", "SKILL.md"))).toBe(join(tempDir, "missing", "SKILL.md"));
		});

		it("loadSkills gives the same skills and diagnostics with a filled memo as without one", () => {
			const { files, aliases } = buildSymlinkFixture();
			// Aliases both before and after their targets, so order-based dedupe is exercised both ways.
			const skillPaths = [
				aliases.alphaViaDir,
				...files,
				aliases.betaViaFile,
				aliases.omegaViaDir,
				join(tempDir, "missing", "SKILL.md"),
			];
			const options = { cwd, agentDir, skillPaths, includeDefaults: false, catalogCache: false };

			const withoutMemo = loadSkills(options);
			const memo: CanonicalPathMemo = new Map();
			for (const path of skillPaths) canonicalizeOnce(resolve(path), memo);
			fsCalls.realpath.length = 0;
			const withMemo = loadSkills({ ...options, canonicalPaths: memo });

			expect(withMemo).toEqual(withoutMemo);
			for (const path of skillPaths) expect(countCalls(fsCalls.realpath, path)).toBe(0);

			const names = withMemo.skills.map((skill) => skill.name).sort();
			expect(names).toEqual(["alpha", "beta", "delta", "dup", "epsilon", "gamma", "omega", "zeta"]);
			expect(withMemo.skills.find((skill) => skill.name === "alpha")?.filePath).toBe(aliases.alphaViaDir);
			expect(withMemo.diagnostics.filter((d) => d.type === "collision")).toHaveLength(1);
			expect(withMemo.diagnostics.some((d) => d.message === "skill path does not exist")).toBe(true);
		});

		it("reload realpaths each discovered SKILL.md once and every reused value equals a fresh realpath", async () => {
			const { aliases } = buildSymlinkFixture();
			const resolveSpy = vi.spyOn(DefaultPackageManager.prototype, "resolve");
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			fsCalls.realpath.length = 0;
			await loader.reload();
			const reloadCalls = [...fsCalls.realpath];

			expect(resolveSpy).toHaveBeenCalledTimes(1);
			const memo = resolveSpy.mock.calls[0]?.[1];
			expect(memo).toBeInstanceOf(Map);
			const discovered = [...(memo ?? new Map<string, string>()).keys()].filter((path) =>
				path.startsWith(`${skillsDir}/`),
			);
			expect(discovered.length).toBeGreaterThanOrEqual(11);
			for (const path of discovered) {
				expect(countCalls(reloadCalls, path), path).toBe(1);
			}
			// Equal strings in, equal dedupe decisions out: each memo value is what canonicalizePath gives now.
			for (const [input, canonical] of memo ?? []) {
				expect(canonical, input).toBe(canonicalizePath(input));
			}

			const { skills, diagnostics } = loader.getSkills();
			const fixtureSkills = skills.filter((skill) => skill.filePath.startsWith(`${skillsDir}/`));
			const fixtureNames = fixtureSkills.map((skill) => skill.name).sort();
			expect(fixtureNames).toEqual(["alpha", "beta", "delta", "dup", "epsilon", "gamma", "omega", "zeta"]);
			const realFiles = new Set(fixtureSkills.map((skill) => canonicalizePath(skill.filePath)));
			expect(realFiles.size).toBe(fixtureSkills.length);
			expect(diagnostics.filter((d) => d.type === "collision" && d.path?.startsWith(skillsDir))).toHaveLength(1);
			expect(fixtureSkills.find((skill) => skill.name === "omega")?.filePath).toBe(aliases.omegaViaDir);
		});

		it("a second reload builds a fresh memo", async () => {
			buildSymlinkFixture();
			const resolveSpy = vi.spyOn(DefaultPackageManager.prototype, "resolve");
			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();
			await loader.reload();
			expect(resolveSpy).toHaveBeenCalledTimes(2);
			expect(resolveSpy.mock.calls[0]?.[1]).not.toBe(resolveSpy.mock.calls[1]?.[1]);
		});
	});

	describe("ignore files from the readdir listing", () => {
		function ignoreProbes(dir: string, root: string): string[] {
			const rel = relative(root, dir);
			const prefix = rel ? `${rel.split("\\").join("/")}/` : "";
			return ["venv/", "venv/SKILL.md", "scratch/", "scratch/a.md", "keep.tmp", "a.tmp", "SKILL.md", "ok/"].map(
				(probe) => `${prefix}${probe}`,
			);
		}

		function compareListingWithProbe(dir: string, root: string): { exists: string[] } {
			const listing: Dirent[] = readdirSync(dir, { withFileTypes: true });
			const probed = ignore();
			addIgnoreRules(probed, dir, root);
			fsCalls.exists.length = 0;
			const listed = ignore();
			addIgnoreRules(listed, dir, root, listing);
			const exists = [...fsCalls.exists];
			for (const probe of ignoreProbes(dir, root)) {
				expect(listed.ignores(probe), `${dir}: ${probe}`).toBe(probed.ignores(probe));
			}
			return { exists };
		}

		it("adds the same rules as the existsSync probe for every ignore-file shape", () => {
			const root = join(tempDir, "ignore-root");
			const plain = join(root, "plain");
			mkdirSync(plain, { recursive: true });
			writeFileSync(join(plain, ".gitignore"), "venv\n# comment\n");
			writeFileSync(join(plain, ".ignore"), "scratch/\n");
			writeFileSync(join(plain, ".fdignore"), "*.tmp\n!keep.tmp\n");

			const dirNamed = join(root, "dir-named");
			mkdirSync(join(dirNamed, ".gitignore"), { recursive: true });
			writeFileSync(join(dirNamed, ".ignore"), "venv\n");

			const dangling = join(root, "dangling");
			mkdirSync(dangling, { recursive: true });
			symlinkSync(join(root, "no-such-file"), join(dangling, ".ignore"));

			const linked = join(root, "linked");
			mkdirSync(linked, { recursive: true });
			symlinkSync(join(plain, ".gitignore"), join(linked, ".gitignore"));

			const caseVariant = join(root, "case-variant");
			mkdirSync(caseVariant, { recursive: true });
			writeFileSync(join(caseVariant, ".GitIgnore"), "venv\n");

			const none = join(root, "none");
			mkdirSync(none, { recursive: true });
			writeFileSync(join(none, "SKILL.md"), "x");

			for (const dir of [plain, dirNamed, dangling, linked, none]) {
				const { exists } = compareListingWithProbe(dir, root);
				expect(exists, dir).toEqual([]);
			}
			// Root-level rules (no prefix) behave the same too.
			expect(compareListingWithProbe(plain, plain).exists).toEqual([]);

			// A case-only variant is still probed, so a case-insensitive filesystem reads it as before.
			const { exists } = compareListingWithProbe(caseVariant, root);
			expect(exists).toEqual([join(caseVariant, ".gitignore")]);
		});

		it("skill discovery excludes ignored skill dirs as before, without probing ignore files per skill dir", async () => {
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, ".gitignore"), "venv\n");
			writeSkill(join(skillsDir, "good"), "good");
			writeSkill(join(skillsDir, "venv", "bad"), "bad");
			const group = join(skillsDir, "group");
			mkdirSync(group, { recursive: true });
			writeFileSync(join(group, ".ignore"), "drafts/\n");
			writeFileSync(join(group, ".fdignore"), "old-*\n");
			writeSkill(join(group, "kept"), "kept");
			writeSkill(join(group, "drafts", "draft"), "draft");
			writeSkill(join(group, "old-thing"), "old-thing");
			for (let i = 0; i < 20; i++) writeSkill(join(skillsDir, `bulk-${i}`), `bulk-${i}`);

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
			});
			fsCalls.exists.length = 0;
			const result = await packageManager.resolve();
			const enabled = result.skills.filter((r) => r.enabled).map((r) => relative(skillsDir, r.path));

			expect(enabled).toContain(join("good", "SKILL.md"));
			expect(enabled).toContain(join("group", "kept", "SKILL.md"));
			expect(enabled).toContain(join("bulk-7", "SKILL.md"));
			expect(enabled.some((p) => p.startsWith("venv"))).toBe(false);
			expect(enabled.some((p) => p.includes("drafts"))).toBe(false);
			expect(enabled.some((p) => p.includes("old-thing"))).toBe(false);

			const ignoreProbesUnderSkills = fsCalls.exists.filter(
				(path) => path.startsWith(`${skillsDir}/`) && IGNORE_NAMES.has(path.slice(path.lastIndexOf("/") + 1)),
			);
			expect(ignoreProbesUnderSkills).toEqual([]);
		});
	});
});
