/**
 * Spec 095 measurement (Commit M tool). Usage:
 *   node scripts/goal-diagnostic-measure.ts <fixture-dir>
 * The directory holds `manifest.json` mapping file -> { groundTruthLine, groundTruthLastLine }
 * (1-based on sanitized text). Hard stops (exit 2) when any entry lacks either
 * field or any fixture fits the cap whole (<= 1,536 B and <= 40 lines after
 * sanitize): such fixtures are invalid under spec 095 and must be replaced.
 * Pass per fixture: first line in window 1 and, when the last line differs, last line in window 2.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { measureTwoWindowFixtures } from "../src/core/goal-acceptance-diagnostic-measure.ts";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: goal-diagnostic-measure <fixture-dir>");
	process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
try {
	const rows = measureTwoWindowFixtures(
		Object.entries(manifest).map(([file, truth]) => ({ file, raw: readFileSync(join(dir, file), "utf8"), truth })),
	);
	console.table(rows.map(({ excerpt: _excerpt, ...row }) => row));
	const passed = rows.filter((row) => row.pass).length;
	console.log(`pass ${passed}/${rows.length}`);
	process.exit(passed === rows.length ? 0 : 1);
} catch (error) {
	console.error(`HARD STOP: ${(error as Error).message}`);
	process.exit(2);
}
