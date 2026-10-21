/**
 * Equivalence harness for the behavior-neutral agent-session split
 * (specs/agent-session-split/spec.md §5). Records, per scenario, every provider
 * request (context + options), every session event in order with its payload, and
 * the run summary/trace the session leaves behind (run budget snapshot, session
 * entries). The normalized record is compared byte for byte against a golden file
 * generated from the unchanged code.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FauxResponseStep } from "omk-ai";
import type { Harness } from "./harness.ts";

export const GOLDEN_DIR = join(import.meta.dirname, "fixtures", "session-equivalence");

/** Machine-dependent roots, so a golden made on one machine compares on CI. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

export interface EquivalenceRecord {
	requests: unknown[];
	events: unknown[];
	trace: unknown;
}

/** Wraps each queued step so the request it answers is recorded before it is served. */
export function recordingSteps(requests: unknown[], steps: FauxResponseStep[]): FauxResponseStep[] {
	return steps.map((step) => async (context, options, state, model) => {
		requests.push({ model: model.id, context, options: pickOptions(options) });
		return typeof step === "function" ? step(context, options, state, model) : step;
	});
}

function pickOptions(options: unknown): unknown {
	if (!options || typeof options !== "object") return options;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		if (typeof value === "function" || key === "signal") continue;
		out[key] = value;
	}
	return out;
}

const VOLATILE_KEY = /(timestamp|time|At|Ms|duration|elapsed|startedAt|endedAt|^ts)$/i;
const ID_LIKE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{8,}\b/gi;
/**
 * Faux usage and byte sizes are computed from text that embeds the checkout path, so they move with its length.
 * The request text itself is compared byte for byte, so these counts carry no extra signal.
 */
const PATH_DEPENDENT_COUNT = /^(input|output|totalTokens|cacheRead|cacheWrite)$|tokens?$|bytes$/i;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

function normalizeText(value: string, tempDir: string): string {
	return value
		.split(tempDir)
		.join("<TMP>")
		.split(REPO_ROOT)
		.join("<REPO>")
		.split(homedir())
		.join("<HOME>")
		.replace(ISO, "<ISO>")
		.replace(DATE, "<DATE>");
}

/** A cache boundary is a char offset into the prompt: re-express it as an offset into the normalized prompt. */
function normalizeBoundary(owner: Record<string, unknown>, key: string, tempDir: string): unknown {
	const value = owner[key];
	const prompt = owner.systemPrompt;
	if (key !== "systemPromptCacheBoundary" || typeof value !== "number" || typeof prompt !== "string") return value;
	return normalizeText(prompt.slice(0, value), tempDir).length;
}

/** Stable JSON with volatile values (clock, temp dir, random ids) replaced by order-preserving tokens. */
export function serializeRecord(record: EquivalenceRecord, tempDir: string): string {
	const ids = new Map<string, string>();
	const token = (raw: string) => {
		let id = ids.get(raw);
		if (!id) {
			id = `<id${ids.size}>`;
			ids.set(raw, id);
		}
		return id;
	};
	const seen = new WeakSet<object>();
	const norm = (value: unknown, key: string): unknown => {
		if (typeof value === "string") {
			const s = normalizeText(value, tempDir).replace(ID_LIKE, token);
			return VOLATILE_KEY.test(key) && s !== value ? "<T>" : s;
		}
		if (typeof value === "number") {
			if (VOLATILE_KEY.test(key)) return "<T>";
			return PATH_DEPENDENT_COUNT.test(key) ? "<n>" : value;
		}
		if (typeof value === "function") return "<fn>";
		if (typeof value === "bigint") return String(value);
		if (value instanceof Error) return { error: value.name, message: norm(value.message, "message") };
		if (value instanceof Map) return norm(Object.fromEntries(value), key);
		if (value instanceof Set) return norm([...value], key);
		if (value && typeof value === "object") {
			if (seen.has(value)) return "<cycle>";
			seen.add(value);
			const result = Array.isArray(value)
				? value.map((item) => norm(item, key))
				: Object.fromEntries(
						Object.keys(value)
							.sort()
							.map((k) => [k, norm(normalizeBoundary(value as Record<string, unknown>, k, tempDir), k)]),
					);
			seen.delete(value);
			return result;
		}
		return value;
	};
	return `${JSON.stringify(norm(record, ""), null, "\t")}\n`;
}

export function captureRecord(harness: Harness, requests: unknown[]): string {
	const trace = {
		runBudget: harness.session.getRunBudgetSnapshot(),
		lastTermination: harness.session.lastTermination,
		entries: harness.sessionManager.getEntries(),
	};
	return serializeRecord({ requests, events: harness.events, trace }, harness.tempDir);
}

export interface Comparison {
	equal: boolean;
	firstDiffByte?: number;
}

/** Byte-for-byte comparison; reports the first differing byte offset. */
export function compareBytes(expected: string, actual: string): Comparison {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(actual, "utf8");
	if (a.equals(b)) return { equal: true };
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return { equal: false, firstDiffByte: i };
}

export function goldenPath(scenario: string): string {
	return join(GOLDEN_DIR, `${scenario}.json`);
}

/** With UPDATE_SESSION_EQUIVALENCE=1 the golden is (re)written; only run that on unchanged code. */
export function readOrWriteGolden(scenario: string, actual: string): string {
	const path = goldenPath(scenario);
	if (process.env.UPDATE_SESSION_EQUIVALENCE === "1") writeFileSync(path, actual);
	if (!existsSync(path)) throw new Error(`missing golden ${path}; generate it on unchanged code`);
	const golden = readFileSync(path, "utf8");
	if (golden !== actual) writeFileSync(join(tmpdir(), `omk-equivalence-${scenario}.actual.json`), actual);
	return golden;
}
