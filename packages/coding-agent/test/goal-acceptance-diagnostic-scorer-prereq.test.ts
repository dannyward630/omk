/**
 * 1.5.1 measurement prerequisites (Tech Lead, after 097 FAIL):
 * - the scorer honors manifest `a1Excluded: true` (reference only, not counted toward A1);
 * - holdout1/holdout2 manifests carry groundTruthLine/groundTruthLastLine that match the fixture text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticText } from "../src/core/goal-acceptance-diagnostic.ts";
import {
	a1Tally,
	isA1Excluded,
	type MeasureRow,
	manifestFixtures,
	measureTwoWindowFixtures,
} from "../src/core/goal-acceptance-diagnostic-measure.ts";

const row = (pass: boolean, a1Excluded: boolean, fullDisplay = false) =>
	({ pass, a1Excluded, fullDisplay }) as unknown as MeasureRow;

describe("a1Excluded", () => {
	it("only the literal true excludes", () => {
		expect(isA1Excluded({ a1Excluded: true })).toBe(true);
		for (const value of [false, "true", 1, null, undefined]) expect(isA1Excluded({ a1Excluded: value })).toBe(false);
		expect(isA1Excluded({})).toBe(false);
		expect(isA1Excluded(null)).toBe(false);
	});

	it("excluded rows are not counted toward A1, and are reported separately", () => {
		const tally = a1Tally([row(true, false), row(true, false), row(false, true), row(true, true)]);
		expect(tally).toEqual({ passed: 2, counted: 2, excludedPassed: 1, excluded: 2, fullDisplay: 0 });
	});

	it("a failing counted row still fails A1 even when excluded rows pass", () => {
		const tally = a1Tally([row(false, false), row(true, true)]);
		expect(tally.passed).toBeLessThan(tally.counted);
	});

	it("holdout5 manifest: excluded entries are exactly the README's 6", () => {
		const dir = join(import.meta.dirname, "fixtures", "goal-diagnostics-holdout5");
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
		const entries = Object.entries(manifest).filter(([key]) => key !== "authorDeclaration");
		expect(entries.filter(([, truth]) => isA1Excluded(truth)).length).toBe(6);
		expect(entries.filter(([, truth]) => !isA1Excluded(truth)).length).toBe(10);
	});
});

describe.each(["goal-diagnostics-holdout", "goal-diagnostics-holdout2"])("%s ground truth", (name) => {
	const dir = join(import.meta.dirname, "fixtures", name);
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
	const fixtures = manifestFixtures(manifest, (file) => readFileSync(join(dir, file), "utf8"));

	it("has 10 fixtures", () => {
		expect(fixtures).toHaveLength(10);
	});

	it.each(fixtures.map((f) => [f.file, f] as const))(
		"%s: GT lines are valid and match their text",
		(_file, fixture) => {
			const truth = fixture.truth as Record<string, unknown>;
			const first = truth.groundTruthLine as number;
			const last = truth.groundTruthLastLine as number;
			expect(Number.isInteger(first) && first >= 1).toBe(true);
			expect(Number.isInteger(last) && last >= first).toBe(true);
			const lines = sanitizeDiagnosticText(fixture.raw).split("\n");
			expect(lines[first - 1]).toBe(truth.groundTruthText);
			expect(lines[last - 1]).toBe(truth.groundTruthLastText);
		},
	);
});

describe("full-display rule (fit-whole fixture, excerpt identical to the fixture)", () => {
	const truth = { groundTruthLine: 2, groundTruthLastLine: 2 };

	it.each(["095", "097"] as const)(
		"identical -> full-display, not PASS, excluded from denominator (rule %s)",
		(rule) => {
			const [result] = measureTwoWindowFixtures([{ file: "tiny", raw: "start\nError: boom\nend\n", truth }], {
				rule,
			});
			expect(result.fullDisplay).toBe(true);
			expect(result.pass).toBe(false);
			expect(result.excerpt.truncated).toBe(false);
			const tally = a1Tally([result]);
			expect(tally).toMatchObject({ passed: 0, counted: 0, fullDisplay: 1 });
		},
	);

	it("excerpt differing only by a single trailing newline is full-display, excluded from denominator", () => {
		const raw = "start\nError: boom\nend\n";
		const [result] = measureTwoWindowFixtures([{ file: "nl", raw, truth }], { rule: "097" });
		expect(result.excerpt.text).not.toBe(raw);
		expect(`${result.excerpt.text}\n`).toBe(raw);
		expect(result.fullDisplay).toBe(true);
		expect(result.pass).toBe(false);
		expect(a1Tally([result])).toMatchObject({ counted: 0, fullDisplay: 1 });
	});

	it("non-identical small fixture (sanitize changes it) -> existing hard stop", () => {
		expect(() =>
			measureTwoWindowFixtures([{ file: "ansi", raw: "start\n\u001b[31mError: boom\u001b[0m\nend\n", truth }], {
				rule: "097",
			}),
		).toThrow(/ansi: fits the cap whole/);
	});

	it("over-cap fixtures are never full-display", () => {
		const long = Array.from({ length: 80 }, (_, i) => (i === 50 ? "Error: boom" : `ok ${i + 1}`)).join("\n");
		const [result] = measureTwoWindowFixtures(
			[{ file: "long", raw: long, truth: { groundTruthLine: 51, groundTruthLastLine: 51 } }],
			{ rule: "097" },
		);
		expect(result.fullDisplay).toBe(false);
	});

	it("tally removes full-display rows from every denominator and counts them separately", () => {
		expect(a1Tally([row(false, false, true), row(false, true, true), row(true, false), row(false, true)])).toEqual({
			passed: 1,
			counted: 1,
			excludedPassed: 0,
			excluded: 1,
			fullDisplay: 2,
		});
	});
});
