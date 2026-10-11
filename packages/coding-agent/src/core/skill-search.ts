/**
 * Spec 050 R3–R5, R8 and spec 058 R2–R7: lazy skill index, ranking (`bm25` or `metacon`, see
 * `skill-select-rankers.ts`), candidate messages and `skill-select` run-log records.
 *
 * Imported only on the first `skill_search` call or the first candidate computation of a skill-search
 * session (never on the startup path, AC 3). The index is the list of model-invocable skills
 * (name, short description, location) and is cached at `<agentDir>/cache/skill-index-v1.json`, keyed by a
 * fingerprint of the index algorithm version and each SKILL.md's path, size, mtime and inode
 * (`skill-index-store.ts`). The `contentHash` used to merge identical
 * skills (058 R2) comes from the current `loadSkills()` result, not from the index file.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { retrievalTokens } from "../metacognition/retrieval.ts";
import { escapeXml } from "./context-budget-system-prompt-items.ts";
import type { CustomMessage } from "./messages.ts";
import { appendRunLog, type RunLogRecord } from "./run-log.ts";
import {
	fingerprintSkills,
	type IndexDoc,
	readIndexFile,
	SKILL_INDEX_FILE,
	writeIndexFile,
} from "./skill-index-store.ts";
import {
	contentTokens,
	type MetaconStats,
	type RankDoc,
	type RankResult,
	rankSkills,
	type SkillRankSource,
	type SkillSelectRankMode,
} from "./skill-select-rankers.ts";
import type { Skill } from "./skills.ts";
import { compactSkillDescription } from "./skills-prompt.ts";
import type { SkillSearchToolDetails } from "./tools/skill-search-tool.ts";

export { SKILL_INDEX_ALGORITHM_VERSION, SKILL_INDEX_FILE } from "./skill-index-store.ts";

export const SKILL_CANDIDATES_CUSTOM_TYPE = "skill-candidates";
/** `searchCorpus` corpus cap. */
export const SKILL_INDEX_MAX_DOCS = 5000;
/** Candidates per user prompt (R3: default 3, at most 5). */
export const SKILL_CANDIDATE_K = 3;
/**
 * BM25 score floor for a candidate message (R3). A single query word that only a handful of skills
 * contain scores about 3–7 on a 1,000-skill index; words most skills share score below 1.
 */
export const SKILL_CANDIDATE_MIN_SCORE = 2;
const MAX_QUERY_CHARS = 4096;

export interface SkillHit extends IndexDoc {
	readonly score: number;
	readonly source: SkillRankSource;
}

export interface SkillSearchSessionOptions {
	readonly skills: () => readonly Skill[];
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** 058 R1: the ranker chosen at session start (default `bm25`). */
	readonly mode?: SkillSelectRankMode;
	/**
	 * 058 R4 `phase`: 049's `activeTodoKind()` once it exists. Unset (049 not on main) means `"task"`.
	 * TODO(049): pass `() => activeTodoKind()` from the session when `todo-runtime-state.ts` exports it.
	 */
	readonly phase?: () => string | undefined;
}

/** Per-session state: the loaded index, and which skills were already offered (R3, AC 6). */
export class SkillSearchSession {
	private index:
		| { skills: readonly Skill[]; fingerprint: string; docs: readonly IndexDoc[]; ranked: readonly RankDoc[] }
		| undefined;
	private readonly suggested = new Set<string>();
	private readonly searched = new Set<string>();

	private readonly options: SkillSearchSessionOptions;

	constructor(options: SkillSearchSessionOptions) {
		this.options = options;
	}

	/** `skill_search` tool body. */
	search(query: string, limit: number): { text: string; details: SkillSearchToolDetails } {
		const started = performance.now();
		const result = this.rank(query, { limit });
		const hits = result.hits;
		for (const hit of hits) this.searched.add(hit.name);
		this.log({
			type: "search",
			queryTokens: queryTokenCount(query),
			limit,
			returned: hits.length,
			skillHashes: hits.map((hit) => shortHash(hit.name)),
			...this.rankRecord(result, started),
		});
		const text =
			hits.length === 0
				? "No matching skills."
				: hits.map((hit) => `${hit.name} — ${hit.description} — ${hit.location}`).join("\n");
		return {
			text,
			details: {
				query,
				queryHash: shortHash(query),
				limit,
				mode: this.mode,
				matchCount: result.matchCount,
				candidates: hits.map((hit) => ({
					name: hit.name,
					score: round3(hit.score),
					location: hit.location,
					source: hit.source,
				})),
			},
		};
	}

	/** R3 task start: one message with the top new candidates, or none below the floor. */
	suggest(query: string, explicit: readonly string[] = []): CustomMessage | undefined {
		const started = performance.now();
		const result = this.rank(taskQuery(query.slice(0, MAX_QUERY_CHARS)), {
			limit: SKILL_CANDIDATE_K,
			exclude: this.suggested,
			explicit,
		});
		const top = Math.max(0, ...result.hits.map((hit) => hit.score));
		const fresh = result.hits.filter((hit) => hit.score >= SKILL_CANDIDATE_MIN_SCORE);
		for (const hit of fresh) this.suggested.add(hit.name);
		this.log({
			type: "suggest",
			trigger: "task",
			todoKind: "none",
			k: fresh.length,
			skillHashes: fresh.map((hit) => shortHash(hit.name)),
			topScore: round3(top),
			belowFloor: top < SKILL_CANDIDATE_MIN_SCORE,
			...this.rankRecord({ ...result, hits: fresh }, started),
		});
		if (fresh.length === 0) return undefined;
		return {
			role: "custom",
			customType: SKILL_CANDIDATES_CUSTOM_TYPE,
			content: renderCandidates(fresh),
			display: false,
			timestamp: Date.now(),
		};
	}

	/** Whether this session offered the skill, and how (R8 `read`). */
	offeredVia(name: string): "suggest" | "search" | "none" {
		if (this.suggested.has(name)) return "suggest";
		if (this.searched.has(name)) return "search";
		return "none";
	}

	private get mode(): SkillSelectRankMode {
		return this.options.mode ?? "bm25";
	}

	private rank(
		query: string,
		options: { limit: number; exclude?: ReadonlySet<string>; explicit?: readonly string[] },
	): RankResult & { hits: readonly SkillHit[] } {
		this.docs();
		const ranked = this.index?.ranked ?? [];
		return rankSkills(this.mode, query, ranked, { ...options, phase: this.options.phase?.() });
	}

	/** 058 R7 fields shared by `search` and `suggest`: hashes, scores and numbers only. */
	private rankRecord(result: RankResult, started: number): RunLogRecord {
		return {
			mode: this.mode,
			candidateCount: result.matchCount,
			top: result.hits.map((hit) => ({
				nameHash: shortHash(hit.name),
				score: round3(hit.score),
				source: hit.source,
			})),
			latencyMs: elapsed(started),
			...metaconRecord(result.metacon),
		};
	}

	/** Builds or loads the index on first use; `/reload` with different skills rebuilds it (new fingerprint). */
	private docs(): readonly IndexDoc[] {
		const loaded = this.options.skills();
		// Same loaded list (no /reload since the last build): no need to stat every SKILL.md again.
		if (this.index?.skills === loaded) return this.index.docs;
		const skills = loaded.filter((skill) => !skill.disableModelInvocation);
		const fingerprint = fingerprintSkills(skills);
		if (this.index?.fingerprint === fingerprint) {
			this.index = { ...this.index, skills: loaded, ranked: withContentHashes(this.index.docs, skills) };
			return this.index.docs;
		}
		const started = performance.now();
		const path = join(this.options.agentDir, "cache", SKILL_INDEX_FILE);
		const cached = readIndexFile(path);
		let docs: readonly IndexDoc[];
		let truncated: boolean;
		let cacheBytes = 0;
		const cacheHit = cached?.fingerprint === fingerprint;
		if (cached && cacheHit) {
			docs = cached.docs;
			truncated = cached.truncated;
		} else {
			truncated = skills.length > SKILL_INDEX_MAX_DOCS;
			docs = skills.slice(0, SKILL_INDEX_MAX_DOCS).map((skill) => ({
				name: skill.name,
				description: compactSkillDescription(skill.description),
				location: skill.filePath,
			}));
			cacheBytes = writeIndexFile(path, { version: 1, fingerprint, truncated, docs });
		}
		this.index = { skills: loaded, fingerprint, docs, ranked: withContentHashes(docs, skills) };
		this.log({
			type: "index",
			skills: skills.length,
			docsUsed: docs.length,
			buildMs: elapsed(started),
			cacheHit,
			cacheBytes,
			fingerprintHash: fingerprint.slice(0, 12),
			truncated,
		});
		return docs;
	}

	private log(record: RunLogRecord): void {
		appendRunLog("skill-select", record, { env: this.options.env });
	}
}

/** 058 R7 `metacon` fields; absent optional fields are left out (the run log takes no `undefined`). */
function metaconRecord(stats: MetaconStats | undefined): RunLogRecord {
	if (!stats) return {};
	return {
		prefilter: stats.prefilter,
		needs: stats.needs,
		coveredNeeds: stats.coveredNeeds,
		rejected: { ...stats.rejected },
		phase: stats.phase,
		phaseSource: stats.phaseSource,
		planMs: stats.planMs,
		...(stats.algorithm ? { algorithm: stats.algorithm } : {}),
		...(stats.state ? { state: stats.state } : {}),
		...(stats.overBudget ? { overBudget: true } : {}),
		...(stats.fallback ? { fallback: stats.fallback } : {}),
	};
}

/** 058 R2: the `contentHash` of each indexed skill, looked up by location in the current `loadSkills()` result. */
function withContentHashes(docs: readonly IndexDoc[], skills: readonly Skill[]): RankDoc[] {
	const hashes = new Map(skills.map((skill) => [skill.filePath, skill.contentHash]));
	return docs.map((doc) => {
		const contentHash = hashes.get(doc.location);
		return contentHash ? { ...doc, contentHash } : doc;
	});
}

export function renderCandidates(hits: readonly IndexDoc[]): string {
	return [
		"<skill_candidates>",
		"Skills that may help with this task. Read a skill's location with the read tool before applying it; use skill_search to find others.",
		...hits.flatMap((hit) => [
			"  <skill>",
			`    <name>${escapeXml(hit.name)}</name>`,
			`    <description>${escapeXml(hit.description)}</description>`,
			`    <location>${escapeXml(hit.location)}</location>`,
			"  </skill>",
		]),
		"</skill_candidates>",
	].join("\n");
}

export function shortHash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function queryTokenCount(query: string): number {
	return retrievalTokens(query).length;
}

/**
 * Task-start query: content words only (stop words and one-letter tokens removed, `contentTokens`). In a small
 * catalog the few descriptions that contain "and" or "to" give them a high IDF.
 */
function taskQuery(query: string): string {
	return contentTokens(query).join(" ");
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function elapsed(started: number): number {
	return round3(performance.now() - started);
}
