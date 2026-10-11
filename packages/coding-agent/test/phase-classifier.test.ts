import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	classifyCommand,
	type DecideInput,
	decidePhase,
	effortGroupOf,
	INLINE_PYTHON_KEY,
	type Phase,
	resolvePhase,
	shlexSplit,
	toolPhase,
} from "../src/core/phase-classifier.ts";

// Spec 037 Requirement 1: parity with Bench Analyst's `phase_r8_v3.decide` on the masked R8 fixture.
interface Sample extends DecideInput {
	readonly expected: Phase | null;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/phase-classifier-r8.json", import.meta.url), "utf8")) as {
	version: string;
	classifier: string;
	samples: Sample[];
};

const decide = (command: string, failed = false, prevPhase?: Phase, recent: DecideInput["recent"] = []) =>
	decidePhase({ command, failed, prevPhase, recent });

describe("phase classifier parity (spec 037 R1.1)", () => {
	it("pins the v3 fixture: 310 samples, debug 60 and 50 of each other phase", () => {
		expect(fixture.version).toBe("phase-v3");
		expect(fixture.classifier).toBe("phase_r8_v3.decide");
		const counts: Record<string, number> = {};
		for (const sample of fixture.samples)
			counts[String(sample.expected)] = (counts[String(sample.expected)] ?? 0) + 1;
		expect(counts).toEqual({ debug: 60, verify: 50, explore: 50, build: 50, run: 50, edit: 50 });
	});

	it("agrees with phase_r8_v3.decide on every fixture sample", () => {
		const mismatches = fixture.samples.flatMap((sample, index) => {
			const got = decidePhase({ ...sample, prevPhase: sample.prevPhase ?? undefined }) ?? null;
			return got === sample.expected ? [] : [`#${index}: expected ${sample.expected}, got ${got}`];
		});
		expect(mismatches).toEqual([]);
	});
});

describe("phase classifier rules (spec 037 R1.2)", () => {
	it("never returns plan from tool signals", () => {
		const phases = new Set(fixture.samples.map((sample) => decidePhase(sample)));
		for (const name of ["read", "edit", "write", "diagnostics", "grep", "update_todo"]) phases.add(toolPhase(name));
		expect(phases.has("plan")).toBe(false);
	});

	it("maps non-bash tools and gives no signal for other tools", () => {
		expect(["read", "grep", "find", "ls"].map(toolPhase)).toEqual(["explore", "explore", "explore", "explore"]);
		expect(["edit", "write"].map(toolPhase)).toEqual(["edit", "edit"]);
		expect(toolPhase("diagnostics")).toBe("verify");
		expect(["update_todo", "subagent", "mcp", "toString", "__proto__"].map(toolPhase)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("keeps a first failure at its normal phase and makes a repeat failure within 5 calls debug", () => {
		expect(decide("pytest tests/test_a.py", true)).toBe("verify");
		expect(decide("./build/app --run", true, "run")).toBe("run");
		const failedBefore = { key: "./build/app", failed: true };
		expect(decide("./build/app --run", true, "run", [failedBefore])).toBe("debug");
		// with an edit in between
		expect(decide("./build/app --run", true, "edit", [failedBefore, { key: null, failed: false }])).toBe("debug");
		// more than 5 calls ago does not count
		const filler = Array.from({ length: 5 }, () => ({ key: null, failed: false }));
		expect(decide("./build/app --run", true, "run", [failedBefore, ...filler])).toBe("run");
		// a success never becomes debug
		expect(decide("./build/app --run", false, "run", [failedBefore])).toBe("run");
	});

	it("keys all inline python as py:inline and loosens the debug key", () => {
		expect(classifyCommand("python3 -c 'print(1)'").key).toBe(INLINE_PYTHON_KEY);
		expect(classifyCommand("python3 - <<'EOF'\nx = 2\nEOF").key).toBe(INLINE_PYTHON_KEY);
		const recent = [{ key: INLINE_PYTHON_KEY, failed: true }];
		expect(decide("python3 - <<'EOF'\nimport os\nEOF", true, "run", recent)).toBe("debug");
	});

	it("classifies inline python bodies in order write > check > read > keep previous", () => {
		expect(decide("python3 - <<'EOF'\nassert 1\nopen('o.txt', 'w')\nEOF", false, "run")).toBe("edit");
		expect(decide("python3 - <<'EOF'\nassert x == 1\nprint(x)\nEOF", false, "run")).toBe("verify");
		expect(decide("python3 - <<'EOF'\nsubprocess.run(['./test.sh'])\nEOF", false, "run")).toBe("verify");
		expect(decide("python3 - <<'EOF'\nprint(open('a').read())\nEOF", false, "run")).toBe("explore");
		expect(decide("python3 - <<'EOF'\nimport os\nos.system('make')\nEOF", false, "build")).toBe("build");
		expect(decide("python3 - <<'EOF'\nx = 1\nEOF", false, undefined)).toBeUndefined();
		// a verify/build/edit segment before the python call wins
		expect(decide("make && python3 - <<'EOF'\nprint(1)\nEOF", false, "run")).toBe("build");
	});

	it("orders segments verify > build > edit > run > explore", () => {
		expect(decide("ls && make && pytest -q && ./a.out")).toBe("verify");
		expect(decide("ls && cat x > y && make")).toBe("build");
		expect(decide("ls && ./a.out && sed -i s/a/b/ f")).toBe("edit");
		expect(decide("ls && ./a.out")).toBe("run");
		expect(decide("ls -la | wc -l")).toBe("explore");
		expect(decide("cd /tmp && echo hi")).toBe("explore");
		expect(decide("echo hi > /dev/null && ls")).toBe("explore");
		expect(decide("sudo timeout -s KILL 30s pytest")).toBe("verify");
	});

	it("matches Python shlex.split in posix mode", () => {
		expect(shlexSplit(`a 'b c' "d \\" e" f\\ g ''`)).toEqual(["a", "b c", 'd " e', "f g", ""]);
		expect(shlexSplit(`"a\\b"`)).toEqual(["a\\b"]);
		expect(() => shlexSplit("echo 'oops")).toThrow("No closing quotation");
		expect(() => shlexSplit("echo \\")).toThrow("No escaped character");
	});
});

describe("phase resolution (spec 037 section 2)", () => {
	const previous = { phase: "edit", source: "tool" } as const;
	it("todo plan wins, then the tool signal, then the todo kind, then the previous phase", () => {
		expect(resolvePhase("plan", "edit", previous)).toEqual({ phase: "plan", source: "todo" });
		expect(resolvePhase("edit", "verify", previous)).toEqual({ phase: "verify", source: "tool" });
		expect(resolvePhase(undefined, "explore", previous)).toEqual({ phase: "explore", source: "tool" });
		expect(resolvePhase("debug", undefined, previous)).toEqual({ phase: "debug", source: "todo" });
		expect(resolvePhase(undefined, undefined, previous)).toBe(previous);
		expect(resolvePhase(undefined, undefined, undefined)).toBeUndefined();
	});

	it("groups plan/debug/verify high and everything else low", () => {
		expect((["plan", "debug", "verify"] as const).map(effortGroupOf)).toEqual(["high", "high", "high"]);
		expect((["explore", "edit", "build", "run", undefined] as const).map(effortGroupOf)).toEqual([
			"low",
			"low",
			"low",
			"low",
			"low",
		]);
	});
});
