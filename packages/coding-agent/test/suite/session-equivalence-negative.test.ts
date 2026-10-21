/**
 * Negative controls (spec agent-session-split §5): prove on every CI run that the
 * equivalence harness really compares requests, event payloads and event order.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareBytes, goldenPath } from "./session-equivalence.ts";
import { SCENARIOS } from "./session-equivalence-scenarios.ts";

type Golden = { requests: unknown[]; events: unknown[]; trace: unknown };

function flipOneByte(text: string, needle: string): string {
	const at = text.indexOf(needle);
	expect(at).toBeGreaterThanOrEqual(0);
	const i = at + needle.length - 1;
	const ch = text[i] === "a" ? "b" : "a";
	const out = text.slice(0, i) + ch + text.slice(i + 1);
	expect(Buffer.byteLength(out)).toBe(Buffer.byteLength(text));
	return out;
}

const pick = (value: unknown) =>
	JSON.stringify(value, null, "\t")
		.split("\n")
		.find((l) => /"[^"]+": "[^<"]+"/.test(l));

describe("equivalence harness negative controls", () => {
	for (const name of Object.keys(SCENARIOS)) {
		const golden = readFileSync(goldenPath(name), "utf8");
		const parsed = JSON.parse(golden) as Golden;

		it(`${name}: a 1-byte change in a recorded request fails the comparison`, () => {
			const line = pick(parsed.requests[parsed.requests.length - 1]);
			expect(line).toBeDefined();
			const mutated = flipOneByte(golden, (line as string).trim().slice(0, -2));
			expect(compareBytes(golden, mutated).equal).toBe(false);
		});

		it(`${name}: a 1-byte change in a session event fails the comparison`, () => {
			const eventsStart = golden.indexOf('"events"');
			const line = pick(parsed.events[0]) as string;
			const at = golden.indexOf(line.trim(), eventsStart);
			const mutated = flipOneByte(golden.slice(at), line.trim().slice(0, -2));
			const result = compareBytes(golden, golden.slice(0, at) + mutated);
			expect(result.equal).toBe(false);
			expect(result.firstDiffByte).toBeGreaterThanOrEqual(at);
		});

		it(`${name}: swapping the order of two session events fails the comparison`, () => {
			const i = parsed.events.findIndex(
				(e, k) => k > 0 && JSON.stringify(e) !== JSON.stringify(parsed.events[k - 1]),
			);
			expect(i).toBeGreaterThan(0);
			const events = [...parsed.events];
			[events[i - 1], events[i]] = [events[i], events[i - 1]];
			const swapped = `${JSON.stringify({ ...parsed, events }, null, "\t")}\n`;
			expect(compareBytes(golden, swapped).equal).toBe(false);
		});
	}
});
