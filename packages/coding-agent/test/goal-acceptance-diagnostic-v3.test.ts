import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AnchorScanner,
	buildDiagnosticExcerpt,
	classifyV3Line,
	d4Skips,
	diagnosticOutputFromText,
	GOAL_DIAGNOSTIC_MAX_BYTES,
	GOAL_DIAGNOSTIC_MAX_LINES,
	goalDiagnosticsV3Enabled,
	knownFormatLevel,
	utf8Bytes,
} from "../src/core/goal-acceptance-diagnostic.ts";
import { lineShown, manifestFixtures } from "../src/core/goal-acceptance-diagnostic-measure.ts";

/** Spec 097 D1–D5 and A4–A6 on synthetic text only (holdout1–4 are not used here). */

afterEach(() => vi.unstubAllEnvs());

function v3(raw: string) {
	vi.stubEnv("OMK_GOAL_DIAGNOSTICS_V3", "1");
	return buildDiagnosticExcerpt(diagnosticOutputFromText(raw));
}

function anchorOf(raw: string, v3On = true) {
	const scanner = new AnchorScanner({ v3: v3On });
	scanner.push(raw);
	return scanner.finish();
}

function noise(n: number, tag = "build"): string[] {
	return Array.from({ length: n }, (_, i) => `${tag} step ${i} compiling module number ${i} of the project`);
}

/** Text from lines; returns the 1-based line number of each `mark`ed line. */
function doc(lines: string[], ...marks: string[]) {
	const text = lines.join("\n");
	return { text, at: marks.map((mark) => lines.indexOf(mark) + 1) };
}

function expectCaps(text: string): void {
	expect(utf8Bytes(text)).toBeLessThanOrEqual(GOAL_DIAGNOSTIC_MAX_BYTES);
	expect(text.split("\n").length).toBeLessThanOrEqual(GOAL_DIAGNOSTIC_MAX_LINES);
}

describe("spec 097 flag", () => {
	it("OMK_GOAL_DIAGNOSTICS_V3 is default off; 1/on/true turn it on", () => {
		expect(goalDiagnosticsV3Enabled({})).toBe(false);
		for (const value of ["", "0", "off", "false", "yes"]) {
			expect(goalDiagnosticsV3Enabled({ OMK_GOAL_DIAGNOSTICS_V3: value })).toBe(false);
		}
		for (const value of ["1", "on", "TRUE", " true "]) {
			expect(goalDiagnosticsV3Enabled({ OMK_GOAL_DIAGNOSTICS_V3: value })).toBe(true);
		}
	});

	it("the scanner reads the flag from the environment when no option is given", () => {
		const { text } = doc([...noise(30), "pkg/a_test.go:5: things went sideways", ...noise(30)]);
		const scan = () => {
			const scanner = new AnchorScanner();
			scanner.push(text);
			return scanner.finish();
		};
		vi.stubEnv("OMK_GOAL_DIAGNOSTICS_V3", "0");
		expect(scan()).toBeUndefined();
		vi.stubEnv("OMK_GOAL_DIAGNOSTICS_V3", "1");
		expect(scan()?.pattern).toBe("d2-shape");
	});
});

describe("spec 097 D1 failure markers", () => {
	for (const line of [
		"test parses config ... FAILED (12ms)",
		"tests/test_cli.py::test_parse FAILED                    [ 44%]",
		"***Failed    0.02 sec",
		"  3 failing",
		"✗ renders the header",
	]) {
		it(`anchors window 1 on: ${line}`, () => {
			const { text, at } = doc([...noise(40), line, ...noise(40, "later")], line);
			const anchor = anchorOf(text);
			expect(anchor?.first?.line).toBe(at[0]);
			const excerpt = v3(text);
			expect(lineShown(excerpt, at[0], text)).toBe(true);
			expectCaps(excerpt.text);
		});
	}

	it("is whole-word: FAILURES/failingly/unfailing do not anchor", () => {
		for (const line of ["FAILURES summary below", "unfailing optimism", "PREFAILED stage"]) {
			expect(classifyV3Line(line).kind).not.toBe("error");
		}
	});
});

describe("spec 097 D2 diagnostic shape", () => {
	it("anchors a keyword-less file:line[:col]: diagnostic", () => {
		const line = "internal/app/server.go:120:7: ineffectual assignment to x (ineffassign)";
		const bare = "src/lib.py:33: E501 line too long";
		const { text, at } = doc([...noise(40), line, ...noise(10), bare, ...noise(40)], line, bare);
		const anchor = anchorOf(text);
		expect(anchor?.first?.line).toBe(at[0]);
		expect(anchor?.last.line).toBe(at[1]);
		const excerpt = v3(text);
		expect(lineShown(excerpt, at[0], text)).toBe(true);
		expect(lineShown(excerpt, at[1], text)).toBe(true);
	});

	it("needs whitespace after the colon and a numeric line", () => {
		expect(classifyV3Line("http://host:8080/path").kind).toBe("none");
		expect(classifyV3Line("a.ts:x: nope").kind).toBe("none");
		expect(classifyV3Line("a.ts:12:3: something").kind).toBe("shape");
	});

	it("ranks below explicit errors on the same line", () => {
		expect(classifyV3Line("a.ts:1:2: error TS2304: Cannot find name").pattern).toBe("error-ts");
	});
});

describe("spec 097 A5 / D3 decoys never anchor", () => {
	const decoys = [
		"test error_handling::retries_on_error ... ok (3ms)",
		"✓ surfaces Error: boom to the caller",
		"PASSED tests/test_errors.py::test_error_message",
		"tests/test_errors.py::test_raises_error passed",
		"test result: ok. 12 passed; 0 failed",
		"✔ TypeError: is reported as a warning",
	];

	for (const decoy of decoys) {
		it(`never anchors: ${decoy}`, () => {
			expect(classifyV3Line(decoy).kind).toBe("none");
			const real = "src/core.ts:9:1: error: unexpected token";
			const { text, at } = doc([...noise(30), decoy, decoy, ...noise(20), real, ...noise(30)], real);
			const anchor = anchorOf(text);
			expect(anchor?.first?.line).toBe(at[0]);
			expect(anchor?.pattern).toBe("error-colon");
			expect(anchor?.last.pattern).toBe("tail");
		});
	}

	it("decoys alone produce no error anchor (D4 fallback instead)", () => {
		const { text } = doc([...noise(30), ...decoys, ...noise(30)]);
		expect(anchorOf(text)?.pattern).toBe("d4-fallback");
	});
});

describe("spec 097 A6 / D4 known-format skips", () => {
	it("(a) logfmt and JSON info/debug/trace/warn/warning lines are skipped", () => {
		for (const line of [
			"ts=2026-10-21T00:00:00Z level=info msg=starting",
			'time="2026-10-21 00:00" level=warn msg="disk 80% full"',
			"level=warning component=db",
			"level=DEBUG msg=x",
			"level=trace",
			'{"level":"info","msg":"starting"}',
			'{"ts":1,"level":"WARN","msg":"slow"}',
			'  {"level":"debug"}',
			'{"level":"trace","error":"not really"}',
		]) {
			expect(d4Skips(line), line).toBe(true);
			expect(classifyV3Line(line).kind, line).toBe("skip");
		}
	});

	it("(b) logfmt and JSON error/fatal lines are never skipped and do anchor", () => {
		for (const line of [
			"ts=2026-10-21T00:00:00Z level=error msg=boom",
			'level=fatal msg="cannot bind"',
			"level=ERROR",
			'{"level":"error","msg":"boom"}',
			'{"level":"FATAL"}',
		]) {
			expect(d4Skips(line), line).toBe(false);
			expect(classifyV3Line(line).kind, line).toBe("error");
		}
	});

	it("(c) an unlisted format containing level=info is not skipped", () => {
		for (const line of [
			"2026-10-21 12:00:01 [app] level=info started",
			"INFO level=info",
			"note: level=info was requested",
			'{"meta":{"level":"info"}}',
			'{"lvl":"info"}',
			'["level","info"]',
			'{"level":"info"',
		]) {
			expect(d4Skips(line), line).toBe(false);
			expect(classifyV3Line(line).kind, line).not.toBe("skip");
		}
		expect(knownFormatLevel('{"level":"info"')).toBeUndefined();
	});

	it("fallback window 1 = first line that is not a known-format info/warning line", () => {
		const info = Array.from({ length: 40 }, (_, i) => `ts=${i} level=info msg="step ${i}"`);
		const real = "deploy halted: database migration 0042 could not apply";
		const { text, at } = doc([...info, real, ...noise(5), ...info], real);
		const anchor = anchorOf(text);
		expect(anchor?.pattern).toBe("d4-fallback");
		expect(anchor?.first?.startLine).toBe(at[0]);
		const excerpt = v3(text);
		expect(lineShown(excerpt, at[0], text)).toBe(true);
		expectCaps(excerpt.text);
	});

	it("flag off keeps the 095 head/tail fallback for the same text", () => {
		const info = Array.from({ length: 40 }, (_, i) => `ts=${i} level=info msg="step ${i}"`);
		const { text } = doc([...info, "deploy halted: migration could not apply", ...info]);
		expect(anchorOf(text, false)).toBeUndefined();
	});
});

describe("spec 097 D5 warnings", () => {
	it("warnings never anchor window 1 when a D1/D2 line exists later", () => {
		const warnings = Array.from({ length: 30 }, (_, i) => `src/w${i}.ts:${i + 1}:1: warning: unused variable`);
		const real = "src/main.ts:4:2: undefined name 'cfg' (lint)";
		const { text, at } = doc([...noise(5), ...warnings, ...noise(5), real, ...noise(30)], real);
		const anchor = anchorOf(text);
		expect(anchor?.first?.line).toBe(at[0]);
		expect(anchor?.first?.pattern).toBe("d2-shape");
	});

	it("warnings anchor only when nothing else does", () => {
		const warning = "src/w.ts:3:1: warning: deprecated API";
		const { text, at } = doc([...noise(40), warning, ...noise(40)], warning);
		const anchor = anchorOf(text);
		expect(anchor?.pattern).toBe("d5-warning");
		expect(anchor?.first?.line).toBe(at[0]);
	});
});

describe("spec 097 windows", () => {
	it("close first and last anchors may merge into one window (allowed)", () => {
		const a = "lib/a.rb:10: undefined method";
		const b = "lib/b.rb:12: undefined method";
		const { text, at } = doc([...noise(40), a, "  context", b, ...noise(40)], a, b);
		const excerpt = v3(text);
		expect(lineShown(excerpt, at[0], text)).toBe(true);
		expect(lineShown(excerpt, at[1], text)).toBe(true);
	});

	it("first error far from last error: both shown in separate windows", () => {
		const a = "FAIL src/a.test.ts > parses";
		const b = "src/z.ts:900:1: unreachable code";
		const { text, at } = doc([...noise(10), a, ...noise(300), b, ...noise(10)], a, b);
		const excerpt = v3(text);
		expect(excerpt.windows).toHaveLength(2);
		expect(lineShown(excerpt, at[0], text)).toBe(true);
		expect(lineShown(excerpt, at[1], text)).toBe(true);
	});
});

describe("spec 097 A4 caps", () => {
	function rng(seed: number) {
		let x = seed >>> 0;
		return () => {
			x = (x * 1664525 + 1013904223) >>> 0;
			return x / 2 ** 32;
		};
	}
	const pool = [
		"src/a.ts:1:2: error TS2322: nope",
		"x.go:9: undefined: y",
		"test thing ... FAILED (1ms)",
		"test ok_error ... ok",
		"level=info msg=hi",
		'{"level":"error","msg":"bad"}',
		"warning: unused",
		"한국어 오류 메시지 👩‍👩‍👧‍👦 줄",
		"plain line of build output",
		"x".repeat(5000),
		"",
		"  3 failing",
	];

	it("every excerpt is ≤ 1,536 B and ≤ 40 lines over 300 generated outputs (incl. 1 MiB)", () => {
		const next = rng(97);
		for (let n = 0; n < 300; n++) {
			const count = n === 0 ? 40_000 : 20 + Math.floor(next() * 400);
			const lines = Array.from({ length: count }, () => pool[Math.floor(next() * pool.length)]);
			const excerpt = v3(lines.join("\n"));
			expectCaps(excerpt.text);
			expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(excerpt.text))).toBe(
				excerpt.text,
			);
		}
	});
});

describe("spec 097 holdout manifest loader", () => {
	it("skips a top-level authorDeclaration string and keeps every fixture entry", () => {
		const manifest = {
			authorDeclaration: "I did not read spec 097.",
			"a.txt": { groundTruthLine: 1, groundTruthLastLine: 2 },
			"b.txt": { groundTruthLine: 3, groundTruthLastLine: 3 },
		};
		const read = vi.fn((file: string) => `content of ${file}`);
		const fixtures = manifestFixtures(manifest, read);
		expect(fixtures.map((f) => f.file)).toEqual(["a.txt", "b.txt"]);
		expect(read).not.toHaveBeenCalledWith("authorDeclaration");
	});

	it("does not hide a non-string authorDeclaration entry", () => {
		const fixtures = manifestFixtures({ authorDeclaration: { groundTruthLine: 1 } }, () => "x");
		expect(fixtures.map((f) => f.file)).toEqual(["authorDeclaration"]);
	});

	it("ground-truth lines are 1-based on content.split('\\n')", () => {
		const real = "pkg/x.go:7: broken";
		const lines = [...noise(60), real, ...noise(60)];
		const text = `${lines.join("\n")}\n\n`;
		const line = text.split("\n").indexOf(real) + 1;
		expect(line).toBe(61);
		const excerpt = v3(text);
		expect(lineShown(excerpt, line, text)).toBe(true);
		expect(lineShown(excerpt, line - 1, text) && lineShown(excerpt, line + 1, text)).toBe(true);
	});
});
