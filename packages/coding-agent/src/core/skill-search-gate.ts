/**
 * Spec 050 R1/R2/R3/R8 and 058 R1/R7: the per-session skill-search decision (mode included) and its
 * fixed tool, split from `prompt-skill-message.ts` (module size). On the startup path, so it stays small: the index, BM25 and the
 * search/suggest run-log records live in `skill-search.ts`, imported on the first search or candidate
 * computation only (R5).
 */
import type { Context } from "omk-ai";
import { getAgentDir } from "../config.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import type { CustomMessage } from "./messages.ts";
import { appendRunLog, RUN_LOG_DIR_ENV } from "./run-log.ts";
import type { SkillSearchSession } from "./skill-search.ts";
import {
	SKILL_SEARCH_TOOL_NAME,
	type SkillSearchActivation,
	skillSearchActivation,
	skillSearchSuggestOn,
	skillSelectMode,
} from "./skill-search-mode.ts";
import type { Skill } from "./skills.ts";
import { createSkillSearchToolDefinition } from "./tools/skill-search-tool.ts";

export interface SkillSearchSetup {
	/** The loaded skills; read again on each search so `/reload` is picked up (the mode itself stays). */
	readonly skills: () => readonly Skill[];
	readonly hasReadTool: boolean;
	readonly agentDir?: string;
	readonly env?: NodeJS.ProcessEnv;
}

export class SkillSearchGate {
	private activation: SkillSearchActivation = { active: false, inactiveReason: "flag_off", mode: "off" };
	private options: SkillSearchSetup | undefined;
	private session: Promise<SkillSearchSession> | undefined;
	private tool: ToolDefinition | undefined;
	private sessionLogged = false;

	/** Whether the system prompt uses skill-search mode (the one fixed line instead of `<available_skills>`). */
	get active(): boolean {
		return this.activation.active;
	}

	/**
	 * R1, at session start: decide once. The mode is read first, so skill search off (or an unknown
	 * `OMK_SKILL_SELECT`, which warns) never reads the skill list.
	 */
	setup(options: SkillSearchSetup): void {
		this.options = options;
		const env = options.env ?? process.env;
		const skills = skillSelectMode(env).mode === "off" ? [] : options.skills();
		this.activation = skillSearchActivation(env, skills, options.hasReadTool);
	}

	/**
	 * R2, on every tool-registry build: the SDK tools plus the fixed `skill_search` tool in an active session.
	 * When another tool (extension, MCP or SDK; `otherNames` plus `tools`) already has that name, ours is not
	 * added and the session behaves exactly like flag off from then on (`<available_skills>` stays), with one
	 * warning.
	 */
	withTool(
		tools: readonly ToolDefinition[],
		otherNames: readonly string[],
		warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
	): ToolDefinition[] {
		if (!this.activation.active) return [...tools];
		if (otherNames.includes(SKILL_SEARCH_TOOL_NAME) || tools.some((tool) => tool.name === SKILL_SEARCH_TOOL_NAME)) {
			this.activation = { active: false, inactiveReason: "name_conflict", mode: "off" };
			warn(`skill search: another tool is already named ${SKILL_SEARCH_TOOL_NAME}; it stays off for this session.`);
			return [...tools];
		}
		this.tool ??= createSkillSearchToolDefinition(async (query, limit) => (await this.search()).search(query, limit));
		return [...tools, this.tool];
	}

	/**
	 * R3 task start: one candidate message, or none (off, worker, nothing above the floor, or any failure).
	 * `explicit` is this prompt's `!skill` / `/skill:` names (058 R4 `explicitSkills`).
	 */
	async candidates(
		query: string,
		env: NodeJS.ProcessEnv = process.env,
		explicit: readonly string[] = [],
	): Promise<CustomMessage | undefined> {
		if (!this.activation.active || !skillSearchSuggestOn(env)) return undefined;
		try {
			return (await this.search()).suggest(query, explicit);
		} catch {
			// Candidates are optional: a failed index build or search never breaks the prompt.
			return undefined;
		}
	}

	/**
	 * R2, whenever the system prompt is rebuilt for an active tool set: if an allowlist, loadout or
	 * `setActiveTools` leaves `skill_search` out, the session turns off (`tool_inactive`) and stays off, so no
	 * candidate message ever points at a tool the model cannot call and the prompt keeps `<available_skills>`.
	 */
	syncActiveTools(activeNames: readonly string[]): void {
		if (!this.activation.active || activeNames.includes(SKILL_SEARCH_TOOL_NAME)) return;
		this.activation = { active: false, inactiveReason: "tool_inactive", mode: "off" };
	}

	/**
	 * R8 `session` record, once, after the first system prompt is set. Hashes only; nothing without a log dir.
	 * Never throws: a failed `prompt-hash` import, hash or write only drops the record, flag on or off.
	 */
	async logSession(context: Pick<Context, "systemPrompt" | "tools">): Promise<void> {
		const env = this.options?.env ?? process.env;
		if (this.sessionLogged || !env[RUN_LOG_DIR_ENV]?.trim()) return;
		this.sessionLogged = true;
		try {
			const { systemHash, toolsHash } = await import("omk-ai/prompt-hash");
			const record = {
				type: "session",
				active: this.activation.active,
				inactiveReason: this.activation.inactiveReason,
				mode: this.activation.mode,
				...(this.activation.invalidMode ? { invalidMode: true } : {}),
				systemHash: systemHash(context),
				toolsHash: toolsHash(context),
			};
			appendRunLog("skill-select", record, { env });
		} catch {
			// The run log is diagnostics only; it never fails the prompt.
		}
	}

	/** First search or candidate computation imports the index module (never on the startup path, R5). */
	private search(): Promise<SkillSearchSession> {
		const options = this.options;
		if (!options) return Promise.reject(new Error("skill search is not set up"));
		this.session ??= import("./skill-search.ts").then(
			({ SkillSearchSession }) =>
				new SkillSearchSession({
					skills: options.skills,
					agentDir: options.agentDir ?? getAgentDir(),
					env: options.env ?? process.env,
					mode: this.activation.mode === "metacon" ? "metacon" : "bm25",
				}),
		);
		return this.session;
	}
}
