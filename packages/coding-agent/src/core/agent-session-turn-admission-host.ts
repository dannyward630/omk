/**
 * Turn-admission host for `AgentSession`, moved verbatim out of the constructor
 * (specs/agent-session-split, PR 1). Spec 104 phase 2 attaches the
 * `requiredTools` callback here.
 */
import type { Agent, AgentMessage } from "omk-agent-core";
import type { Api, Model } from "omk-ai";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { SessionRunBudget } from "./session-run-budget.ts";
import { SessionTurnAdmission } from "./session-turn-admission.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { mcpToolGroup } from "./tool-schema-budget.ts";

/** The `AgentSession` members the admission host reads, all read lazily at call time. */
export interface TurnAdmissionSession {
	readonly model: Model<Api> | undefined;
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly _mcpToolNames: ReadonlySet<string>;
	readonly _runBudget: SessionRunBudget;
	readonly _extensionRunner: ExtensionRunner;
	_effectiveTurnContextWindow(pendingMessages: AgentMessage[], sessionWindow: number): number;
	_runThresholdCompaction(emergency: boolean): Promise<boolean>;
}

export function installTurnAdmission(session: TurnAdmissionSession): SessionTurnAdmission {
	// One tool selection serves admission and the admitted run: MCP servers the model's input
	// budget cannot carry are withheld per request, never removed from the active tool set.
	const turnAdmission = new SessionTurnAdmission({
		model: () => session.model,
		state: () => session.agent.state,
		contextWindow: (pending, window) => session._effectiveTurnContextWindow([...pending], window),
		compactionSettings: () => session.settingsManager.getCompactionSettings(),
		latestCompactionTimestamp: () => getLatestCompactionEntry(session.sessionManager.getBranch())?.timestamp,
		toolGroup: (name) => (session._mcpToolNames.has(name) ? mcpToolGroup(name) : undefined),
		compact: async () => {
			await session._runThresholdCompaction(true);
			session._runBudget.assertActive();
		},
		notify: (message) => session._extensionRunner.getUIContext().notify(message, "warning"),
	});
	session.agent.prepareTools = (tools, pending) => turnAdmission.fitTools(tools, pending);
	return turnAdmission;
}
