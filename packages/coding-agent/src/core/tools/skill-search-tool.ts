/** Spec 050 R2 / 058 R2: the fixed `skill_search` tool, registered only in skill-search sessions. */
import { Type } from "omk-ai";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	SKILL_SEARCH_DEFAULT_LIMIT,
	SKILL_SEARCH_MAX_LIMIT,
	SKILL_SEARCH_MAX_QUERY,
	SKILL_SEARCH_TOOL_NAME,
} from "../skill-search-mode.ts";

export interface SkillSearchToolDetails {
	readonly query: string;
	readonly queryHash: string;
	readonly limit: number;
	/** 058 R2: which ranker produced the list, for a future TUI card. */
	readonly mode: "bm25" | "metacon";
	/** Distinct skills with a positive BM25 score (capped at 64). */
	readonly matchCount: number;
	readonly candidates: readonly {
		readonly name: string;
		/** BM25 score, in both modes. */
		readonly score: number;
		readonly location: string;
		/** `metacon` pick, `bm25-fill` after the picks, or plain `bm25` order (058 R4.4). */
		readonly source: "bm25" | "metacon" | "bm25-fill";
	}[];
}

export type SkillSearchRunner = (
	query: string,
	limit: number,
) => Promise<{ text: string; details: SkillSearchToolDetails }>;

/** R2: fixed schema and text, independent of the skill count or content. */
export function createSkillSearchToolDefinition(run: SkillSearchRunner): ToolDefinition {
	return {
		name: SKILL_SEARCH_TOOL_NAME,
		label: "Skill search",
		description:
			"Search the available skills by name and description. Returns one line per match, best first: name — short description — location. Read the location with the read tool before applying a skill.",
		promptSnippet: "Find skills (specialized task instructions) by keyword with skill_search.",
		parameters: Type.Object({
			query: Type.String({ description: "What the task needs, in a few words.", maxLength: SKILL_SEARCH_MAX_QUERY }),
			limit: Type.Optional(
				Type.Integer({
					description: `Number of results (1-${SKILL_SEARCH_MAX_LIMIT}, default ${SKILL_SEARCH_DEFAULT_LIMIT}).`,
					minimum: 1,
					maximum: SKILL_SEARCH_MAX_LIMIT,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { query, limit } = params as { query: string; limit?: number };
			const bounded = Math.min(SKILL_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit ?? SKILL_SEARCH_DEFAULT_LIMIT)));
			const result = await run(query.slice(0, SKILL_SEARCH_MAX_QUERY), bounded);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	} as ToolDefinition;
}
