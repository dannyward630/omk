/**
 * Phase classifier for adaptive reasoning effort (spec 037).
 *
 * Pure functions, no I/O. The bash rules mirror Bench Analyst's `phase_r8_v3.decide`
 * (lib `phase_r8_v2.py`, segment rules from `phase_r8.py`; sha256 in spec 037 Decisions 2),
 * so the runtime and the bench analysis classify the same command the same way.
 * `test/fixtures/phase-classifier-r8.json` pins that parity; a rule change updates the
 * TypeScript rules, the fixture and the script sha256 values in the same PR.
 */

// TODO(049): import `TodoKind` from `./todo-state.ts` once spec 049 (typed todos) is on main.
export type TodoKind = "plan" | "explore" | "edit" | "debug" | "verify";
export type Phase = TodoKind | "build" | "run";
export type PhaseSource = "todo" | "tool";

export interface RecentCall {
	readonly key: string | null;
	readonly failed: boolean;
}

export interface DecideInput {
	readonly command: string;
	readonly failed: boolean;
	readonly prevPhase: Phase | undefined;
	/** The last tool calls, oldest first; only the last five are read. Non-bash tools have `key: null`. */
	readonly recent: ReadonlyArray<RecentCall>;
}

export interface CommandClass {
	readonly phase: Phase | undefined;
	/** Debug key: script/binary path or first two tokens; `py:inline` for all inline python. */
	readonly key: string | null;
}

type SegmentPhase = "verify" | "build" | "edit" | "run" | "explore";
const ORDER: Record<SegmentPhase, number> = { verify: 5, build: 4, edit: 3, run: 2, explore: 1 };
const rank = (phase: SegmentPhase | undefined): number => (phase === undefined ? 0 : ORDER[phase]);

const EXPL = new Set(
	"ls cat head tail grep rg find tree file wc which pwd stat less more du df env printenv type whereis od xxd hexdump strings readelf objdump nm diff cmp sort uniq cut awk jq realpath dirname basename id whoami uname ps nproc free date".split(
		" ",
	),
);
const NEUTRAL = new Set(
	"for while if then do done fi else elif case esac def import from print return { } ( ) cd export echo printf true false set source . sleep clear exit mkdir chmod touch rm cp mv ln unset wait kill pkill".split(
		" ",
	),
);
const PREFIX = new Set(["sudo", "nice", "time", "nohup", "stdbuf", "command", "exec"]);
const BUILD_TOK = new Set(
	"make cmake gcc g++ clang clang++ cc c++ tsc apt-get apt ninja javac rustc go cargo npm pip pip3 uv conda yarn pnpm mvn gradle dpkg configure ./configure meson".split(
		" ",
	),
);
const GIT_READ = new Set(
	"log diff show status branch ls-files blame rev-parse reflog remote config grep stash".split(" "),
);
const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;
const PY_INLINE = /(?:^|[;&|\n])[ \t]*(?:[\w./-]*\/)?python3?(?:\.\d+)?(?:[ \t]+-u)?[ \t]+(?:-[ \t]*<<|<<|-c[ \t])/;
const PY_WRITE =
	/open\([^)]*,\s*['"][wa]b?\+?['"]|write_text|write_bytes|json\.dump\([^)]*,|shutil\.(copy|move)|os\.(rename|replace)|\.to_csv\(|\.save\(|np\.save/;
const PY_CHECK = /\bassert\b|==\s*expected|expected\s*==|\bPASS\b|\bFAIL\b/;
const PY_HEAVY = /subprocess|os\.system|\bdef |\bclass |\bwhile /;
export const INLINE_PYTHON_KEY = "py:inline";
/** Python's `$` (no MULTILINE) also matches before one trailing newline. */
const END = "(?=\\n?$)";
const DURATION = new RegExp(`^[\\d.]+[smh]?${END}`);
const SCRIPT_FILE = new RegExp(`\\.(py|sh|js|pl|R)${END}`);

const WS = " \t\r\n";

/** Python `shlex.split(s, posix=True)` (whitespace_split, no comments); throws where shlex raises. */
export function shlexSplit(input: string): string[] {
	const out: string[] = [];
	let i = 0;
	for (;;) {
		let token = "";
		let quoted = false;
		let state: string | undefined = " ";
		let escaped = "a";
		for (;;) {
			const ch = i < input.length ? input[i++] : "";
			if (state === " ") {
				if (!ch) {
					state = undefined;
					break;
				}
				if (WS.includes(ch)) {
					if (token || quoted) break;
				} else if (ch === "\\") {
					escaped = "a";
					state = ch;
				} else if (ch === "'" || ch === '"') state = ch;
				else {
					token = ch;
					state = "a";
				}
			} else if (state === "'" || state === '"') {
				quoted = true;
				if (!ch) throw new Error("No closing quotation");
				if (ch === state) state = "a";
				else if (ch === "\\" && state === '"') {
					escaped = state;
					state = ch;
				} else token += ch;
			} else if (state === "\\") {
				if (!ch) throw new Error("No escaped character");
				if ((escaped === "'" || escaped === '"') && ch !== state && ch !== escaped) token += state;
				token += ch;
				state = escaped;
			} else {
				if (!ch) {
					state = undefined;
					break;
				}
				if (WS.includes(ch)) {
					state = " ";
					if (token || quoted) break;
				} else if (ch === "'" || ch === '"') state = ch;
				else if (ch === "\\") {
					escaped = "a";
					state = ch;
				} else token += ch;
			}
		}
		if (token === "" && !quoted) return out;
		out.push(token);
		if (state === undefined) return out;
	}
}

/** Tokens of one segment with `sudo`/`nice`/`VAR=…`/`timeout <opts> <dur>` prefixes stripped. */
function tokens(segment: string): string[] {
	let t: string[];
	try {
		t = shlexSplit(segment);
	} catch {
		t = segment.split(/\s+/).filter((part) => part !== "");
	}
	let start = 0;
	while (start < t.length && (PREFIX.has(t[start]) || /^\w+=/.test(t[start]))) start++;
	if (t[start] === "timeout") {
		start++;
		while (start < t.length && (t[start].startsWith("-") || DURATION.test(t[start]))) start++;
	}
	return t.slice(start);
}

function classifyNpmLike(c: string, t: readonly string[]): SegmentPhase {
	if (c === "npm" || c === "yarn" || c === "pnpm") {
		const sub = t[1];
		const build =
			["install", "i", "ci", "add"].includes(sub) || (sub === "run" && t.length > 2 && t[2].includes("build"));
		return build ? "build" : "run";
	}
	if (c === "cargo") return ["build", "install", "check"].includes(t[1]) ? "build" : "run";
	if (c === "go") return ["build", "install", "get", "mod"].includes(t[1]) ? "build" : "run";
	if (c === "pip" || c === "pip3" || c === "uv" || c === "conda") {
		return ["show", "list", "freeze"].includes(t[1]) ? "explore" : "build";
	}
	return "build";
}

function isVerify(c: string, t: readonly string[]): boolean {
	if (c === "pytest" || c === "ctest" || t.slice(0, 3).includes("pytest") || t.slice(0, 4).includes("unittest"))
		return true;
	if ((c === "npm" || c === "yarn" || c === "pnpm") && t.slice(1, 3).includes("test")) return true;
	if ((c === "cargo" || c === "go") && t[1] === "test") return true;
	if (c === "make" && t.slice(1).some((x) => x === "test" || x === "check")) return true;
	if (/(test|check)/.test(c)) return true;
	const runner = c === "bash" || c === "sh" || c === "python" || c === "python3" || c === "node";
	return runner && t.length > 1 && /(^|\/)(tests?\/|test_|run_tests|check)/.test(t[1]);
}

/** One shell segment (`classify_seg` in `phase_r8.py`); `undefined` = neutral, no vote. */
function classifySegment(segment: string): SegmentPhase | undefined {
	const s = segment.trim();
	if (!s) return undefined;
	const t = tokens(s);
	if (t.length === 0 || s.startsWith("#")) return undefined;
	const c = t[0].startsWith("./") ? t[0] : (t[0].split("/").pop() ?? t[0]);
	const sedInPlace = c === "sed" && t.slice(1).some((x) => x.startsWith("-i"));
	if (c === "sed" && !sedInPlace) return "explore";
	if (sedInPlace || c === "tee" || c === "patch" || (c === "git" && t[1] === "apply")) return "edit";
	if (/(?<![0-9&])>>?\s*(?!\/dev\/null|&)[^\s>&]/.test(s)) return "edit";
	if (isVerify(c, t)) return "verify";
	if (BUILD_TOK.has(c)) return classifyNpmLike(c, t);
	if ((c === "python" || c === "python3") && t.length > 2 && t[1] === "-m" && t[2] === "pip") {
		return ["show", "list", "freeze"].includes(t[3]) ? "explore" : "build";
	}
	if (c === "git") return GIT_READ.has(t[1]) ? "explore" : "run";
	if (t.includes("--help") || t[t.length - 1] === "-h" || c === "man") return "explore";
	if (EXPL.has(c)) return "explore";
	if (NEUTRAL.has(c)) return undefined;
	return "run";
}

function bestSegment(text: string): { phase: SegmentPhase | undefined; segment: string } {
	let phase: SegmentPhase | undefined;
	let segment = "";
	for (const part of text.split(SEGMENT_SPLIT)) {
		const p = classifySegment(part);
		if (rank(p) > rank(phase)) {
			phase = p;
			segment = part.trim();
		}
	}
	return { phase, segment };
}

function commandKey(segment: string): string {
	const t = tokens(segment);
	if (t.length === 0) return segment.slice(0, 40);
	for (const x of t) if (x.includes("/") || SCRIPT_FILE.test(x)) return x;
	return t.slice(0, 2).join(" ");
}

function classifyInlinePython(command: string, match: RegExpExecArray): CommandClass {
	const pre = bestSegment(command.slice(0, match.index)).phase;
	if (pre === "verify" || pre === "build" || pre === "edit") return { phase: pre, key: null };
	const body = command.slice(match.index + match[0].length);
	const key = INLINE_PYTHON_KEY;
	if (PY_WRITE.test(body)) return { phase: "edit", key };
	if (PY_CHECK.test(body) || (/subprocess/.test(body) && /test/.test(body))) return { phase: "verify", key };
	const lines = body.split("\n").length - 1;
	if (!PY_HEAVY.test(body) && lines < 40 && /print|listdir|glob|read/.test(body)) return { phase: "explore", key };
	return { phase: undefined, key };
}

/** Phase and debug key of one bash command; `phase: undefined` means keep the previous phase. */
export function classifyCommand(command: string): CommandClass {
	const match = PY_INLINE.exec(command.slice(0, 3000));
	if (match) return classifyInlinePython(command, match);
	const { phase, segment } = bestSegment(command.split("<<")[0]);
	return { phase: phase ?? "explore", key: segment ? commandKey(segment) : null };
}

/** `phase_r8_v3.decide` plus the call's debug key: a failure whose key also failed in the last five calls is `debug`. */
export function decideCall(input: DecideInput): CommandClass {
	const { phase, key } = classifyCommand(input.command);
	const repeated = input.failed && !!key && input.recent.slice(-5).some((call) => call.failed && call.key === key);
	return { phase: repeated ? "debug" : (phase ?? input.prevPhase), key };
}

/** `phase_r8_v3.decide` (signature of the fixture). */
export function decidePhase(input: DecideInput): Phase | undefined {
	return decideCall(input).phase;
}

const TOOL_PHASE: Readonly<Record<string, Phase>> = {
	read: "explore",
	grep: "explore",
	find: "explore",
	ls: "explore",
	edit: "edit",
	write: "edit",
	diagnostics: "verify",
};

/** Non-bash tools; `undefined` for tools that give no signal (`update_todo`, subagents, MCP, …). */
export function toolPhase(toolName: string): Phase | undefined {
	return Object.hasOwn(TOOL_PHASE, toolName) ? TOOL_PHASE[toolName] : undefined;
}

export interface ResolvedPhase {
	readonly phase: Phase;
	readonly source: PhaseSource;
}

/** Spec 037 section 2: todo `plan` > tool signal > todo kind > previous phase. */
export function resolvePhase(
	todoKind: TodoKind | undefined,
	toolSignal: Phase | undefined,
	previous: ResolvedPhase | undefined,
): ResolvedPhase | undefined {
	if (todoKind === "plan") return { phase: "plan", source: "todo" };
	if (toolSignal !== undefined) return { phase: toolSignal, source: "tool" };
	if (todoKind !== undefined) return { phase: todoKind, source: "todo" };
	return previous;
}

const HIGH_PHASES: ReadonlySet<Phase> = new Set<Phase>(["plan", "debug", "verify"]);
export type EffortGroup = "low" | "high";

/** High = plan/debug/verify; everything else, and no phase, is low. */
export function effortGroupOf(phase: Phase | undefined): EffortGroup {
	return phase !== undefined && HIGH_PHASES.has(phase) ? "high" : "low";
}
