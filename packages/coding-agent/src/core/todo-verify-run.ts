/**
 * One finish-check pass over the todo list (spec 049 R2, `OMK_TODO_VERIFY` only).
 *
 * Built when the check turn starts, from the list as it is then. Only `done` items with a
 * check are verified (`pending`, `active` and `blocked` items are counted, never checked).
 * `file` checks run on the host when the check turn settles, so they see the outputs the run
 * ends with; a host failure is a `fail` whatever the model reports. `command` checks get a
 * `TODO n:` line in the check message and are read from the model's `TODO n: PASS|FAIL` reply.
 */

import {
	buildFinishCheckContinueMessage,
	buildFinishCheckMessage,
	extraTurnItems,
	type FinishCheckLedgerItem,
	finishCheckToolCap,
} from "./finish-check-requirements.ts";
import { appendRunLog } from "./run-log.ts";
import type { TodoCheck, TodoItem, TodoState } from "./todo-state.ts";
import {
	describeCommand,
	type HostFileFailure,
	hashTodoId,
	hostFileCheck,
	parseTodoLedger,
	TODO_HOST_CHECK_BUDGET_MS,
	TODO_VERIFY_RUN_LOG,
	type TodoVerifyResult,
	todoCheckTargets,
	todoLabel,
} from "./todo-verify.ts";

export interface TodoCheckRun {
	/** The check-turn message: main's message, plus a `TODO n:` block when a done item has a command check. */
	readonly message: string;
	/** Command checks the model runs in the check turn; they raise the tool cap (never above 12). */
	readonly commandCount: number;
	/** Verifies the done items after the check turn; returns how many failed. */
	finish(reply: string, cwd: string): number;
	/** The extra turn's message: unchanged from main unless a todo failed. */
	continueMessage(ledger: readonly FinishCheckLedgerItem[]): string;
	/** Appends the spec 049 R5 `todo-verify` record once `finish` ran. */
	log(extraTurn: boolean, env?: NodeJS.ProcessEnv): void;
	readonly finished: boolean;
}

interface Verified {
	readonly n: number;
	readonly item: TodoItem;
	readonly check: TodoCheck;
	result: TodoVerifyResult;
	host?: HostFileFailure;
	measured?: string;
}

const HOST_FAILURE_TEXT: Record<HostFileFailure, string> = {
	missing: "the file does not exist",
	"not-a-file": "the path is not a regular file",
	"too-small": "the file is smaller than the minimum size",
	"no-match": "the file does not contain the expected text",
};

const TODO_CHECK_INTRO =
	"TODO checks. These TODO items are marked done and name a command that shows they are done. Run each command on the current outputs; restating your plan is not a check.";
const TODO_REPLY_LINE = "End your reply with one line per TODO item: `TODO <n>: PASS|FAIL - <measured value>`.";

export interface TodoCheckRunOptions {
	readonly now?: () => number;
}

export function createTodoCheckRun(
	state: TodoState,
	requirements: readonly string[],
	options: TodoCheckRunOptions = {},
): TodoCheckRun {
	const now = options.now ?? (() => performance.now());
	const notDone = state.items.filter((item) => item.status !== "done").length;
	const verified: Verified[] = todoCheckTargets(state.items)
		.filter((item) => item.status === "done")
		.map((item, index) => ({ n: index + 1, item, check: item.check as TodoCheck, result: "unknown" }));
	const commands = verified.filter((entry) => entry.check.type === "command");
	let message = buildFinishCheckMessage(requirements);
	if (commands.length > 0) {
		const from = `Use at most ${finishCheckToolCap(requirements.length)} tool calls`;
		const to = `Use at most ${finishCheckToolCap(requirements.length + commands.length)} tool calls`;
		message = [
			message.replace(from, to),
			"",
			TODO_CHECK_INTRO,
			...commands.map(
				(entry) =>
					`TODO ${entry.n}: ${todoLabel(entry.item)} — check: ${describeCommand(entry.check as Extract<TodoCheck, { type: "command" }>)}`,
			),
			TODO_REPLY_LINE,
		].join("\n");
	}
	let finished = false;
	let logged = false;
	let hostCheckMs = 0;

	return {
		message,
		commandCount: commands.length,
		get finished() {
			return finished;
		},
		finish(reply, cwd) {
			const reported = parseTodoLedger(reply);
			const started = now();
			for (const entry of verified) {
				if (entry.check.type === "command") {
					const line = reported.get(entry.n);
					entry.result = line?.status ?? "unreported";
					entry.measured = line?.measured;
					continue;
				}
				// One shared budget for every host check of this turn; past it the rest stay `unknown`.
				if (now() - started >= TODO_HOST_CHECK_BUDGET_MS) continue;
				entry.host = hostFileCheck(entry.check, cwd);
				entry.result = entry.host === undefined ? "pass" : "fail";
			}
			hostCheckMs = now() - started;
			finished = true;
			return verified.filter((entry) => entry.result === "fail").length;
		},
		continueMessage(ledger) {
			const failed = verified.filter((entry) => entry.result === "fail");
			if (failed.length === 0) return buildFinishCheckContinueMessage(ledger);
			const { failing, unmeasured } = extraTurnItems(ledger);
			return [
				...(failing.length + unmeasured.length > 0 ? [buildFinishCheckContinueMessage(ledger)] : []),
				"Finish check result: these TODO items are marked done, but their check does not pass:",
				...failed.map((entry) => `TODO ${entry.n}: ${todoLabel(entry.item)}\n  ${failureDetail(entry)}`),
				"Keep working on these items, or set an item that is not done back to active or blocked with update_todo. Keep the currently saved output in place and never leave a required output worse or missing.",
				"When done, end your reply with one line per TODO item above: `TODO <n>: PASS|FAIL - <measured value>`.",
			].join("\n");
		},
		log(extraTurn, env = process.env) {
			if (!finished || logged) return;
			logged = true;
			const tally = (result: TodoVerifyResult) => verified.filter((entry) => entry.result === result).length;
			appendRunLog(
				TODO_VERIFY_RUN_LOG,
				{
					type: "todo-verify",
					checked: verified.length,
					pass: tally("pass"),
					fail: tally("fail"),
					unreported: tally("unreported"),
					unknown: tally("unknown"),
					hostFail: verified.filter((entry) => entry.host !== undefined).length,
					notDone,
					extraTurn,
					hostCheckMs: Math.round(hostCheckMs * 10) / 10,
					items: verified.map((entry) => ({
						idHash: hashTodoId(entry.item.id),
						kind: entry.item.kind ?? "unknown",
						checkType: entry.check.type,
						result: entry.result,
					})),
				},
				{ env },
			);
		},
	};
}

function failureDetail(entry: Verified): string {
	if (entry.check.type === "file") {
		return `check: file ${entry.check.path} — host check: ${HOST_FAILURE_TEXT[entry.host ?? "missing"]}`;
	}
	return `check: ${describeCommand(entry.check)}\n  measured: ${entry.measured ?? "FAIL"}`;
}
