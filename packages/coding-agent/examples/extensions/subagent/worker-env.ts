/**
 * Environment for subagent worker processes.
 *
 * Workers run headless (`-p`), so the finish check would add a verification turn
 * to every worker on top of the lead's own. Workers get it only when
 * `OMK_FINISH_CHECK_WORKERS` opts in. The lead's time budget, snapshot
 * handshake and fresh-context verifier (spec 032) describe the lead's run, so
 * they are not passed down. Workers keep `OMK_RUN_LOG_DIR` and are marked
 * `OMK_RUN_LOG_ROLE=worker` (spec 042) so their lines can be told apart from
 * the lead's. The deliverable guard (spec 034) watches the lead's outputs only,
 * so workers always get it off. The project trust env (spec 053) is not inherited:
 * the caller passes `OMK_TRUST_PROJECT` only when the parent trusted its project and
 * the worker cwd's gated items hash the same (`workerProjectTrustEnv`), or "0" when
 * the parent runs with it forced off. Workers inherit `OMK_SKILL_SEARCH` but never
 * get automatic skill candidate messages (spec 050 R7).
 * `OMK_WORKER_EXTENSIONS` passes through unchanged (spec 057 R8), so a worker that
 * spawns its own workers applies the same rule.
 */
const LEAD_ONLY_VARS = [
	"OMK_TIME_BUDGET_SEC",
	"OMK_FINISH_CHECK_SNAPSHOT_DIR",
	"OMK_FINISH_CHECK_SNAPSHOT_TIMEOUT_SEC",
	"OMK_FINISH_CHECK_REVERIFY",
];

export function subagentWorkerEnv(parent: NodeJS.ProcessEnv, projectTrust?: "1" | "0"): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...parent };
	for (const name of LEAD_ONLY_VARS) delete env[name];
	delete env.OMK_TRUST_PROJECT;
	if (projectTrust) env.OMK_TRUST_PROJECT = projectTrust;
	const optIn = parent.OMK_FINISH_CHECK_WORKERS?.trim();
	env.OMK_FINISH_CHECK = optIn ? optIn : "0";
	env.OMK_DELIVERABLE_GUARD = "0";
	// Spec 050 R7: workers keep OMK_SKILL_SEARCH (the `skill_search` tool) but get no automatic candidates.
	env.OMK_SKILL_SEARCH_SUGGEST = "0";
	if (parent.OMK_RUN_LOG_DIR?.trim()) env.OMK_RUN_LOG_ROLE = "worker";
	return env;
}
