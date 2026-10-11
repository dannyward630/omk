/**
 * Spec 058 AC 7: offline export for Bench Analyst's paired bm25-vs-metacon evaluation. No model call, no network.
 *
 * Runs the product path (`loadSkillsFromDir` -> `SkillSearchSession.search`, the `skill_search` tool body) with
 * the raw query (no stop-word removal, unlike task-start candidates) and the same limit for both modes over the
 * frozen query file, and writes one TSV per mode in Bench Analyst's `score058.py` format:
 *
 *   # commit <short sha>
 *   qid<TAB>rank<TAB>skill_dir            (bm25.tsv)
 *   qid<TAB>rank<TAB>skill_dir<TAB>source (metacon.tsv; `metacon` or `bm25-fill`, R4.4)
 *
 * `skill_dir` is the corpus folder name only (`a11y-debugging-2`), never a path. Copies are merged by content
 * hash: each loaded skill gets the body hash of its folder from `corpus247.json` as its `contentHash`, so the
 * product's own R2 merge returns `limit` distinct bodies. A folder missing from the corpus stops the export.
 *
 *   npx tsx packages/coding-agent/scripts/skill-select-eval.ts \
 *     --labels /workspace/omk-bench-analyst/skill058/labels_final.tsv \
 *     --corpus /workspace/omk-bench-analyst/skill058/corpus247.json \
 *     --skills /workspace/omk-skill-baseline/env/s1191/agent/skills --out <dir> [--limit 10]
 *
 * The header SHA is `git rev-parse --short=7 HEAD`; the export refuses a dirty `packages/coding-agent/src` so
 * the SHA names the code that ran (`--commit` overrides both, for tests). The index cache goes to a fresh temp
 * agent dir (removed afterwards), so the skill dir is never written.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SkillSearchSession } from "../src/core/skill-search.ts";
import type { SkillSelectRankMode } from "../src/core/skill-select-rankers.ts";
import { loadSkillsFromDir, type Skill } from "../src/core/skills.ts";

export const EVAL_MODES: readonly SkillSelectRankMode[] = ["bm25", "metacon"];

export interface EvalQuery {
	readonly qid: string;
	readonly query: string;
}

/** Short SHA of the checkout this script runs from; refuses uncommitted product code. */
function headCommit(): string {
	const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	if (git(["status", "--porcelain", "--", "src"]) !== "") {
		throw new Error("packages/coding-agent/src has uncommitted changes; commit first or pass --commit");
	}
	return git(["rev-parse", "--short=7", "HEAD"]);
}

/** `qid` and `query` columns of a TSV with a header row (labels_final.tsv). */
export function readEvalQueries(tsv: string): EvalQuery[] {
	const [header, ...rows] = tsv.split(/\r?\n/).filter((line) => line.trim() !== "");
	const columns = (header ?? "").split("\t");
	const qid = columns.indexOf("qid");
	const query = columns.indexOf("query");
	if (qid === -1 || query === -1) throw new Error("query file needs qid and query columns");
	return rows.map((row) => {
		const cells = row.split("\t");
		return { qid: cells[qid] ?? "", query: cells[query] ?? "" };
	});
}

/** Folder name -> body hash from `corpus247.json` (`[{ hash, dirs: [...] }]`). */
export function readCorpusHashes(json: string): Map<string, string> {
	const entries = JSON.parse(json) as { hash?: unknown; dirs?: unknown }[];
	const byDir = new Map<string, string>();
	for (const entry of entries) {
		if (typeof entry.hash !== "string" || !Array.isArray(entry.dirs)) throw new Error("corpus entries need hash and dirs");
		for (const dir of entry.dirs) byDir.set(String(dir), entry.hash);
	}
	return byDir;
}

/** The corpus folder name of a skill: the directory that holds its SKILL.md. */
export function skillDirName(skill: Pick<Skill, "filePath">): string {
	return basename(dirname(skill.filePath));
}

/** Gives every skill its corpus body hash as `contentHash`; a folder the corpus does not know is an error. */
export function withCorpusHashes(skills: readonly Skill[], hashes: ReadonlyMap<string, string>): Skill[] {
	return skills.map((skill) => {
		const hash = hashes.get(skillDirName(skill));
		if (!hash) throw new Error(`skill folder not in corpus: ${skillDirName(skill)}`);
		return { ...skill, contentHash: hash };
	});
}

/** One TSV for one mode: `# commit <sha>`, then `qid rank skill_dir` (+ `source` for metacon). */
export function exportRanks(
	mode: SkillSelectRankMode,
	queries: readonly EvalQuery[],
	skills: readonly Skill[],
	limit: number,
	commit: string,
): string {
	const agentDir = mkdtempSync(join(tmpdir(), "omk-skill-select-eval-"));
	try {
		const session = new SkillSearchSession({ skills: () => skills, agentDir, env: {}, mode });
		const dirByName = new Map(skills.map((skill) => [skill.name, skillDirName(skill)]));
		const lines = [`# commit ${commit}`];
		for (const { qid, query } of queries) {
			const { candidates } = session.search(query, limit).details;
			candidates.forEach((candidate, i) => {
				const dir = dirByName.get(candidate.name) ?? basename(dirname(candidate.location));
				const cells = [qid, String(i + 1), dir];
				lines.push((mode === "metacon" ? [...cells, candidate.source] : cells).join("\t"));
			});
		}
		return `${lines.join("\n")}\n`;
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

export function skillSelectEvalCli(args: string[]): string {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: {
			labels: { type: "string" },
			corpus: { type: "string" },
			skills: { type: "string" },
			commit: { type: "string" },
			out: { type: "string" },
			limit: { type: "string", default: "10" },
		},
	});
	if (!values.labels || !values.corpus || !values.skills || !values.out) {
		throw new Error("--labels, --corpus, --skills and --out are required");
	}
	if (!/^\d+$/.test(values.limit) || Number(values.limit) < 1 || Number(values.limit) > 64) {
		throw new Error("--limit must be 1..64");
	}
	const limit = Number(values.limit);
	const queries = readEvalQueries(readFileSync(resolve(values.labels), "utf8"));
	const hashes = readCorpusHashes(readFileSync(resolve(values.corpus), "utf8"));
	const skills = withCorpusHashes(loadSkillsFromDir({ dir: resolve(values.skills), source: "eval" }).skills, hashes);
	const commit = values.commit ?? headCommit();
	const invocable = skills.filter((skill) => !skill.disableModelInvocation);
	mkdirSync(resolve(values.out), { recursive: true });
	const summary = [`commit=${commit} queries=${queries.length} skills=${invocable.length} limit=${limit}`];
	for (const mode of EVAL_MODES) {
		const body = exportRanks(mode, queries, skills, limit, commit);
		const path = join(resolve(values.out), `${mode}.tsv`);
		writeFileSync(path, body);
		summary.push(`${mode}: ${body.split("\n").filter((line) => line !== "" && !line.startsWith("#")).length} rows -> ${path}`);
	}
	return summary.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(skillSelectEvalCli(process.argv.slice(2)));
}
