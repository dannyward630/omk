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
} from "../src/core/goal-acceptance-diagnostic-measure.ts";

const row = (pass: boolean, a1Excluded: boolean) => ({ pass, a1Excluded }) as unknown as MeasureRow;

describe("a1Excluded", () => {
	it("only the literal true excludes", () => {
		expect(isA1Excluded({ a1Excluded: true })).toBe(true);
		for (const value of [false, "true", 1, null, undefined]) expect(isA1Excluded({ a1Excluded: value })).toBe(false);
		expect(isA1Excluded({})).toBe(false);
		expect(isA1Excluded(null)).toBe(false);
	});

	it("excluded rows are not counted toward A1, and are reported separately", () => {
		const tally = a1Tally([row(true, false), row(true, false), row(false, true), row(true, true)]);
		expect(tally).toEqual({ passed: 2, counted: 2, excludedPassed: 1, excluded: 2 });
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
