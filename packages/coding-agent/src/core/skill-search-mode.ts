/**
 * Spec 050 R1/R2 and spec 058 R1: whether a session runs in skill-search mode, which ranker it uses, and the
 * fixed `skill_search` tool.
 *
 * This module is on the startup path, so it stays small: the index, BM25 ranking and run-log records live
 * in `skill-search.ts`, which is imported only on the first search or candidate computation (R5, AC 3).
 */
import type { Skill } from "./skills.ts";
import { SKILL_PROMPT_COMPACT_THRESHOLD } from "./skills-prompt.ts";

export const SKILL_SEARCH_ENV = "OMK_SKILL_SEARCH";
/** Spec 058 R1: `bm25` or `metacon`. Wins over `OMK_SKILL_SEARCH`, which stays as an alias of `bm25`. */
export const SKILL_SELECT_ENV = "OMK_SKILL_SELECT";
/** Workers set this to 0 (R7): no automatic candidate messages, `skill_search` still works. */
export const SKILL_SEARCH_SUGGEST_ENV = "OMK_SKILL_SEARCH_SUGGEST";
export const SKILL_SEARCH_TOOL_NAME = "skill_search";
export const SKILL_SEARCH_DEFAULT_LIMIT = 5;
export const SKILL_SEARCH_MAX_LIMIT = 8;
export const SKILL_SEARCH_MAX_QUERY = 512;

/** The one system-prompt line that replaces `<available_skills>` in skill-search mode. Constant by design. */
export const SKILL_SEARCH_PROMPT_LINE =
	"\n\nSkills (specialized instructions for specific tasks) are not listed here. Find them with the skill_search tool, then use the read tool on a skill's location before applying it. Relevant skill candidates may also arrive as messages during the conversation.";

/**
 * `name_conflict`: another tool (extension, MCP or SDK) already has the name `skill_search`.
 * `tool_inactive`: an allowlist, loadout or `setActiveTools` left `skill_search` out of the active tools.
 */
export type SkillSearchInactiveReason =
	| "flag_off"
	| "few_skills"
	| "no_read_tool"
	| "name_conflict"
	| "tool_inactive"
	| "none";
export type SkillSelectMode = "off" | "bm25" | "metacon";

export interface SkillSearchActivation {
	readonly active: boolean;
	readonly inactiveReason: SkillSearchInactiveReason;
	/** The ranker chosen at session start (058 R1); `off` when the flag is off or the value is unknown. */
	readonly mode: SkillSelectMode;
	/** `OMK_SKILL_SELECT` had a value other than `bm25`/`metacon` (`wpl` included); the session is off. */
	readonly invalidMode?: true;
}

const ON_VALUES = new Set(["on", "1", "true", "enable", "enabled"]);

export function skillSearchFlagOn(env: NodeJS.ProcessEnv): boolean {
	return ON_VALUES.has(env[SKILL_SEARCH_ENV]?.trim().toLowerCase() ?? "");
}

export function skillSearchSuggestOn(env: NodeJS.ProcessEnv): boolean {
	const raw = env[SKILL_SEARCH_SUGGEST_ENV]?.trim().toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/**
 * 058 R1: `OMK_SKILL_SELECT=bm25|metacon` (any case). Unset or empty falls back to the `OMK_SKILL_SEARCH`
 * alias (`bm25`). Any other value is off and `invalid`; it is never aliased to another mode.
 */
export function skillSelectMode(env: NodeJS.ProcessEnv): { mode: SkillSelectMode; invalid: boolean } {
	const raw = env[SKILL_SELECT_ENV]?.trim().toLowerCase() ?? "";
	if (raw === "bm25" || raw === "metacon") return { mode: raw, invalid: false };
	if (raw !== "") return { mode: "off", invalid: true };
	return { mode: skillSearchFlagOn(env) ? "bm25" : "off", invalid: false };
}

let warnedInvalidMode = false;

/** One stderr line per process for an unknown `OMK_SKILL_SELECT` value; nothing goes into the request. */
function warnInvalidModeOnce(env: NodeJS.ProcessEnv): void {
	if (warnedInvalidMode) return;
	warnedInvalidMode = true;
	const value = (env[SKILL_SELECT_ENV] ?? "").trim().slice(0, 40);
	process.stderr.write(
		`${SKILL_SELECT_ENV}=${value}: unknown value, skill selection stays off (use bm25 or metacon).\n`,
	);
}

/** R1: a mode is set, more than 24 model-invocable skills at session start, and a `read` tool. */
export function skillSearchActivation(
	env: NodeJS.ProcessEnv,
	skills: readonly Skill[],
	hasReadTool: boolean,
	warn: (env: NodeJS.ProcessEnv) => void = warnInvalidModeOnce,
): SkillSearchActivation {
	const { mode, invalid } = skillSelectMode(env);
	if (invalid) {
		warn(env);
		return { active: false, inactiveReason: "flag_off", mode: "off", invalidMode: true };
	}
	if (mode === "off") return { active: false, inactiveReason: "flag_off", mode };
	if (!hasReadTool) return { active: false, inactiveReason: "no_read_tool", mode };
	const invocable = skills.filter((skill) => !skill.disableModelInvocation).length;
	if (invocable <= SKILL_PROMPT_COMPACT_THRESHOLD) return { active: false, inactiveReason: "few_skills", mode };
	return { active: true, inactiveReason: "none", mode };
}
