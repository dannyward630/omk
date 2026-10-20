/**
 * Spec 095 measurement core: which window holds each fixture's real first and
 * last error line. Test/measurement use only; never imported by runtime code.
 */
import {
	buildDiagnosticExcerpt,
	type DiagnosticExcerpt,
	diagnosticOutputFromText,
	GOAL_DIAGNOSTIC_MAX_BYTES,
	GOAL_DIAGNOSTIC_MAX_LINES,
	sanitizeDiagnosticText,
	utf8Bytes,
} from "./goal-acceptance-diagnostic.ts";

export interface MeasureFixture {
	readonly file: string;
	readonly raw: string;
	readonly truth: unknown;
}

export type WindowHit = 1 | 2 | "none";

export interface MeasureRow {
	readonly file: string;
	readonly first: WindowHit;
	readonly last: WindowHit;
	readonly pattern: string;
	readonly fallback: boolean;
	readonly passthrough: boolean;
	readonly pass: boolean;
	readonly excerpt: DiagnosticExcerpt;
}

export function exceedsCap(sanitized: string): boolean {
	const text = sanitized.replace(/\s+$/, "");
	return utf8Bytes(text) > GOAL_DIAGNOSTIC_MAX_BYTES || text.split("\n").length > GOAL_DIAGNOSTIC_MAX_LINES;
}

function lineField(truth: unknown, key: string, file: string): number {
	const value = (truth as Record<string, unknown> | null)?.[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${file}: missing or invalid ${key}`);
	}
	return value;
}

/** Line ranges of the 094 head/tail fallback: head = window 1, tail = window 2. */
function fallbackWindows(excerpt: DiagnosticExcerpt, text: string): (readonly [number, number])[] {
	const total = text.replace(/\s+$/, "").split("\n").length;
	const parts = excerpt.text.split(/\n\[… \d+ bytes elided …\]\n/);
	if (parts.length !== 2) return [];
	const head = parts[0].split("\n").length;
	const tail = parts[1].split("\n").length;
	return [
		[1, head],
		[total - tail + 1, total],
	];
}

export function windowOf(excerpt: DiagnosticExcerpt, line: number, text = ""): WindowHit {
	const windows =
		excerpt.windows ?? (excerpt.mode === "fallback" && excerpt.truncated ? fallbackWindows(excerpt, text) : []);
	const index = windows.findIndex(([start, end]) => line >= start && line <= end) ?? -1;
	return index === 0 ? 1 : index === 1 ? 2 : "none";
}

/** Throws (hard stop) on missing ground truth or any fixture that does not exceed the cap. */
export function measureTwoWindowFixtures(fixtures: readonly MeasureFixture[]): MeasureRow[] {
	const prepared = fixtures.map((fixture) => {
		const first = lineField(fixture.truth, "groundTruthLine", fixture.file);
		const last = lineField(fixture.truth, "groundTruthLastLine", fixture.file);
		const text = sanitizeDiagnosticText(fixture.raw);
		if (!exceedsCap(text)) {
			throw new Error(
				`${fixture.file}: fits the cap whole (<= ${GOAL_DIAGNOSTIC_MAX_BYTES} B and <= ${GOAL_DIAGNOSTIC_MAX_LINES} lines after sanitize)`,
			);
		}
		return { ...fixture, first, last, text };
	});
	return prepared.map(({ file, first, last, text }) => {
		const excerpt = buildDiagnosticExcerpt(diagnosticOutputFromText(text));
		const firstHit = windowOf(excerpt, first, text);
		const lastHit = windowOf(excerpt, last, text);
		const pass = firstHit === 1 && (last === first || lastHit === 2);
		return {
			file,
			first: firstHit,
			last: lastHit,
			pattern: excerpt.mode,
			fallback: excerpt.mode === "fallback",
			passthrough: !excerpt.truncated,
			pass,
			excerpt,
		};
	});
}
