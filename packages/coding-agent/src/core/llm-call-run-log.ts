/**
 * `llm-call.jsonl`: one run-log line per LLM provider call (spec 059, on top of spec 042).
 *
 * Bench runs use `--no-session --mode json`, so per-call usage never reaches a session file.
 * This wrapper sits directly around the provider stream in `createSdkProviderStream`, below
 * spec 033's reasoning cap, so every real request (main turns, compaction and summary calls,
 * and a cap retry as its own request) gets exactly one line with the effort it was sent with.
 *
 * OFF BY DEFAULT: with `OMK_RUN_LOG_DIR` unset when the stream is created, the inner stream
 * function is returned unchanged: no wrapper, no hashing, no clock reads, no file.
 *
 * REQUEST BYTES: the wrapper passes `model`, `context` and `options` through as the same
 * objects and only reads them. It observes the returned stream through `result()` and never
 * consumes or reorders its events.
 *
 * PRIVACY (spec 042): numbers, ids, sha256 hashes and enum names only. Never prompt text,
 * tool arguments, model output, paths, URLs, headers or error messages.
 *
 * `phase` and `phaseSource` are `null` unless spec 037 (`OMK_ADAPTIVE_EFFORT=1`) fills them through
 * `setLlmCallPhaseFields`, together with `effortGroup`, `effortSwitch` and `lowerClamped`. With the
 * flag off the setter is never called, so the line is the same as before 037.
 *
 * COST: `costTotal` is omk's own `usage.cost.total`, which leaves out xAI reasoning tokens, so
 * verdicts use xAI `cost_in_usd_ticks` only. omk's usage parsers drop that raw field (see spec
 * 059), so `costInUsdTicks` is `null` and `responseId`/`requestedAtMs` are the keys for joining
 * the adapter's `omk_usage_raw.jsonl`. When no usage arrived (a cap abort cuts the stream before
 * the final usage chunk), every usage and cost number is `null`, never 0, with `usageMissing: true`.
 */
import type { StreamFn } from "omk-agent-core";
import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	type Model,
	type StopReason,
	type ThinkingLevel,
	type Usage,
} from "omk-ai";
import { systemHash, toolsHash } from "omk-ai/prompt-hash";
import type { EffortGroup, Phase, PhaseSource } from "./phase-classifier.ts";
import { appendRunLog, RUN_LOG_DIR_ENV, type RunLogRecord } from "./run-log.ts";

export const LLM_CALL_RUN_LOG = "llm-call";

export interface LlmCallRunLogOptions {
	readonly env?: NodeJS.ProcessEnv;
	/** Monotonic-enough clock for `durationMs`/`gapMs`; defaults to `Date.now`. */
	readonly now?: () => number;
}

/**
 * End time of the most recent finished call in this process; `gapMs` is measured from it.
 * One value per process: when calls overlap (parallel requests in one process), `gapMs` is
 * measured from whichever call ended last and can be 0 or misleading (spec 059).
 */
let lastCallEndAt: number | undefined;

/** Test hook: forget the previous call so the next one logs `gapMs: null`. */
export function resetLlmCallRunLogClock(): void {
	lastCallEndAt = undefined;
}

/** Spec 037 fields for the provider requests of the current outer call (enums and numbers only). */
export interface LlmCallPhaseFields {
	readonly phase: Phase | null;
	readonly phaseSource: PhaseSource | null;
	readonly effortGroup: EffortGroup;
	readonly effortSwitch: { readonly from: EffortGroup; readonly to: EffortGroup; readonly n: number } | null;
	readonly lowerClamped: boolean;
}

/**
 * Set by spec 037 right before each outer call; `undefined` for calls it passes through.
 * One value per process, like `lastCallEndAt`: overlapping calls may read each other's fields.
 */
let phaseFields: LlmCallPhaseFields | undefined;

/** Spec 037 only, and only with `OMK_ADAPTIVE_EFFORT=1`: fields for the next provider request(s). */
export function setLlmCallPhaseFields(fields: LlmCallPhaseFields | undefined): void {
	phaseFields = fields;
}

/** A 033 retry inside the same outer call keeps the phase but does not repeat `effortSwitch`. */
function takePhaseFields(): LlmCallPhaseFields | undefined {
	const fields = phaseFields;
	if (fields?.effortSwitch) phaseFields = { ...fields, effortSwitch: null };
	return fields;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Provider wire value of `reasoning`, resolved the way the OpenAI-style providers do it
 * (`clampThinkingLevel`, then `model.thinkingLevelMap`), e.g. grok-4.7 `max` → `"xhigh"`.
 * Read-only: computed from the same model the provider gets, the request is not touched.
 */
export function effortSentFor(model: Model<Api>, reasoning: ThinkingLevel | undefined): string | null {
	if (reasoning === undefined) return null;
	const level = clampThinkingLevel(model, reasoning);
	if (level === "off") return null;
	return model.thinkingLevelMap?.[level] ?? level;
}

/**
 * Providers start every message with all-zero usage and fill it from the final usage chunk.
 * A real request always has prompt tokens, so all-zero token counts mean the usage never arrived.
 */
function usageArrived(usage: Usage | undefined): usage is Usage {
	if (!usage) return false;
	return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
		(value) => typeof value === "number" && Number.isFinite(value) && value > 0,
	);
}

function stopReasonOf(message: AssistantMessage | undefined, signal: AbortSignal | undefined): StopReason {
	if (message?.stopReason) return message.stopReason;
	return signal?.aborted ? "aborted" : "error";
}

/**
 * Wrap a provider stream so each call appends one `llm-call` line when it settles.
 * Returns `inner` itself when `OMK_RUN_LOG_DIR` is unset.
 */
export function createLlmCallRunLogStreamFn(inner: StreamFn, options: LlmCallRunLogOptions = {}): StreamFn {
	const env = options.env ?? process.env;
	if (!env[RUN_LOG_DIR_ENV]?.trim()) return inner;
	const now = options.now ?? Date.now;
	const wrapped: StreamFn = async (model, context, streamOptions) => {
		const startedAt = now();
		const gapMs = lastCallEndAt === undefined ? null : Math.max(0, startedAt - lastCallEndAt);
		const fields = takePhaseFields();
		let base: RunLogRecord;
		try {
			base = {
				provider: String(model.provider),
				model: String(model.id),
				effort: streamOptions?.reasoning ?? null,
				effortSent: effortSentFor(model, streamOptions?.reasoning),
				messageCount: context.messages.length,
				systemHash: systemHash(context),
				toolsHash: toolsHash(context),
				phase: null,
				phaseSource: null,
				requestedAtMs: startedAt,
				...fields,
			};
		} catch {
			base = {
				provider: String(model.provider),
				model: String(model.id),
				phase: null,
				phaseSource: null,
				requestedAtMs: startedAt,
				...fields,
			};
		}
		let logged = false;
		const log = (message: AssistantMessage | undefined) => {
			if (logged) return;
			logged = true;
			const endedAt = now();
			lastCallEndAt = endedAt;
			const arrived = message?.usage;
			const usage = usageArrived(arrived) ? arrived : undefined;
			try {
				appendRunLog(
					LLM_CALL_RUN_LOG,
					{
						...base,
						responseId: typeof message?.responseId === "string" ? message.responseId : null,
						input: count(usage?.input),
						output: count(usage?.output),
						cacheRead: count(usage?.cacheRead),
						cacheWrite: count(usage?.cacheWrite),
						costTotal: count(usage?.cost?.total),
						// omk's Usage has no raw xAI ticks (spec 059); join omk_usage_raw.jsonl instead.
						costInUsdTicks: null,
						usageMissing: usage === undefined,
						stopReason: stopReasonOf(message, streamOptions?.signal),
						durationMs: Math.max(0, endedAt - startedAt),
						gapMs,
					},
					{ env },
				);
			} catch {
				// best effort (spec 042): logging never changes the call
			}
		};
		let stream: Awaited<ReturnType<StreamFn>>;
		try {
			stream = await inner(model, context, streamOptions);
		} catch (error) {
			log(undefined);
			throw error;
		}
		void stream.result().then(log, () => log(undefined));
		return stream;
	};
	// Preserve source-owned identity brands, as wrapBudgetStream does.
	for (const key of Object.getOwnPropertySymbols(inner)) {
		const descriptor = Object.getOwnPropertyDescriptor(inner, key);
		if (descriptor) Object.defineProperty(wrapped, key, descriptor);
	}
	return wrapped;
}
