import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "./harness.ts";
import { compareBytes, readOrWriteGolden } from "./session-equivalence.ts";
import { SCENARIOS } from "./session-equivalence-scenarios.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.restoreAllMocks();
});

/** Seeded Math.random: faux provider ids and stream chunk sizes become deterministic. */
function seedRandom(seed = 0x5eed): void {
	let state = seed >>> 0;
	vi.spyOn(Math, "random").mockImplementation(() => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	});
}

describe("agent-session split equivalence (spec agent-session-split §5)", () => {
	for (const [name, run] of Object.entries(SCENARIOS)) {
		it(`${name}: every request, every event and the trace match the golden byte for byte`, async () => {
			seedRandom();
			const result = await run();
			harness = result.harness;
			const golden = readOrWriteGolden(name, result.record);
			const parsed = JSON.parse(result.record) as { requests: unknown[]; events: unknown[] };
			expect(parsed.requests.length).toBeGreaterThan(0);
			expect(parsed.events.length).toBeGreaterThan(0);
			expect(compareBytes(golden, result.record)).toEqual({ equal: true });
		});
	}
});
