import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCorpusHashes, readEvalQueries, skillSelectEvalCli } from "../scripts/skill-select-eval.ts";

// Spec 058 AC 7: the export runs the product path and writes score058.py TSVs: `# commit <sha>`, then
// qid<TAB>rank<TAB>skill_dir (bm25) or qid<TAB>rank<TAB>skill_dir<TAB>source (metacon), folder names only.
const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omk-skill-select-export-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function writeSkill(root: string, dir: string, name: string, description: string): void {
	mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
}

describe("skill-select eval export (spec 058 AC 7)", () => {
	it("reads qid and query by header name", () => {
		const tsv = "qid\tquery\tgold_ids\nQ01\tfill a pdf form\tS1\nQ02\tdeploy to kubernetes\t\n";
		expect(readEvalQueries(tsv)).toEqual([
			{ qid: "Q01", query: "fill a pdf form" },
			{ qid: "Q02", query: "deploy to kubernetes" },
		]);
		expect(() => readEvalQueries("id\ttext\n")).toThrow(/qid and query/);
	});

	it("writes the commit header, folder names only, distinct bodies, and leaves the skill dir alone", () => {
		const skills = tempDir();
		writeSkill(skills, "pdf-forms", "pdf-forms", "Fill and extract PDF forms.");
		writeSkill(skills, "pdf-forms-2", "pdf-forms-2", "Fill and extract PDF forms.");
		writeSkill(skills, "kube", "kubernetes-deploy", "Deploy services to a kubernetes cluster.");
		const corpus: { hash: string; dirs: string[] }[] = [
			{ hash: "aaaaaaaaaaaa", dirs: ["pdf-forms", "pdf-forms-2"] },
			{ hash: "bbbbbbbbbbbb", dirs: ["kube"] },
		];
		for (let i = 0; i < 30; i++) {
			writeSkill(skills, `filler-${i}`, `filler-${i}`, `General helper ${i}.`);
			corpus.push({ hash: `f${String(i).padStart(11, "0")}`, dirs: [`filler-${i}`] });
		}
		const corpusPath = join(tempDir(), "corpus.json");
		writeFileSync(corpusPath, JSON.stringify(corpus));
		const labels = join(tempDir(), "labels.tsv");
		writeFileSync(labels, "qid\tquery\nQ01\tfill pdf forms on kubernetes\nQ02\tnothing matches zzz\n");
		const out = tempDir();
		const before = readFileSync(join(skills, "kube", "SKILL.md"), "utf8");
		const args = ["--labels", labels, "--corpus", corpusPath, "--skills", skills, "--out", out, "--limit", "10"];
		skillSelectEvalCli([...args, "--commit", "d780562"]);
		const bm25 = readFileSync(join(out, "bm25.tsv"), "utf8").trim().split("\n");
		const metacon = readFileSync(join(out, "metacon.tsv"), "utf8").trim().split("\n");
		for (const file of [bm25, metacon]) expect(file[0]).toBe("# commit d780562");
		const bm25Rows = bm25.slice(1).map((line) => line.split("\t"));
		const metaconRows = metacon.slice(1).map((line) => line.split("\t"));
		// The two PDF copies share a body hash, so one of them appears, then the kubernetes skill.
		expect(bm25Rows.map((row) => row.slice(0, 2).join(" "))).toEqual(["Q01 1", "Q01 2"]);
		expect(bm25Rows.every((row) => row.length === 3)).toBe(true);
		const pdf = bm25Rows.filter((row) => row[2].startsWith("pdf-forms"));
		expect(pdf).toHaveLength(1);
		expect(bm25Rows.map((row) => row[2])).toContain("kube");
		expect(metaconRows.length).toBeGreaterThan(0);
		for (const row of [...bm25Rows, ...metaconRows]) {
			expect(row[2]).toMatch(/^[\w.-]+$/);
			expect(row[2]).not.toContain("SKILL.md");
		}
		for (const [qid, , , source, extra] of metaconRows) {
			expect(qid).toBe("Q01");
			expect(["metacon", "bm25-fill"]).toContain(source);
			expect(extra).toBeUndefined();
		}
		expect(readFileSync(join(skills, "kube", "SKILL.md"), "utf8")).toBe(before);
	});

	it("stops on a skill folder the corpus does not know", () => {
		const skills = tempDir();
		writeSkill(skills, "unknown-dir", "unknown-dir", "Not in the corpus.");
		const corpusPath = join(tempDir(), "corpus.json");
		writeFileSync(corpusPath, JSON.stringify([{ hash: "aaaaaaaaaaaa", dirs: ["other"] }]));
		const labels = join(tempDir(), "labels.tsv");
		writeFileSync(labels, "qid\tquery\nQ01\tanything\n");
		const args = [
			"--labels",
			labels,
			"--corpus",
			corpusPath,
			"--skills",
			skills,
			"--out",
			tempDir(),
			"--commit",
			"x",
		];
		expect(() => skillSelectEvalCli(args)).toThrow(/not in corpus: unknown-dir/);
		expect(readCorpusHashes(JSON.stringify([{ hash: "h", dirs: ["a", "a-2"] }]))).toEqual(
			new Map([
				["a", "h"],
				["a-2", "h"],
			]),
		);
	});
});
