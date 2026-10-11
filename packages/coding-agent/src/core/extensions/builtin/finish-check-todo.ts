/**
 * The finish check's view of the todo list (spec 049, `OMK_TODO_VERIFY`, default off).
 *
 * Off, `createFinishCheckTodo` returns main's message builders unchanged and registers
 * nothing, so flag-off runs build byte-identical messages and never load `todo-verify*.ts`.
 * On, it starts loading the verifier when the extension loads (long before any check turn)
 * and records one `todo-verify` run-log line per check turn when the turn's result is emitted.
 */

import {
	buildFinishCheckContinueMessage,
	buildFinishCheckMessage,
	type FinishCheckLedgerItem,
	hasFinishCheckLedgerLines,
} from "../../finish-check-requirements.ts";
import { getCurrentTodoState } from "../../todo-runtime-state.ts";
import { resolveTodoVerify } from "../../todo-state.ts";
import type { TodoCheckRun } from "../../todo-verify-run.ts";
import type { ExtensionAPI } from "../types.ts";
import { ledgerReply } from "./finish-check-reply.ts";

/** Same channel as `FINISH_CHECK_EVENT` in `finish-check.ts` (not imported, to keep the import graph acyclic). */
const FINISH_CHECK_EVENT_CHANNEL = "finish_check";

export interface FinishCheckTodo {
	/** Command checks the current check turn asks for; added to the tool cap. */
	readonly commandCount: number;
	/** The check-turn message. */
	message(requirements: readonly string[]): string;
	/** Verifies done todos after the check turn; returns how many failed (they join spec 035's failing items). */
	finish(messages: readonly unknown[], cwd: string): number;
	/** The extra turn's message. */
	continueMessage(ledger: readonly FinishCheckLedgerItem[]): string;
}

const MAIN: FinishCheckTodo = {
	commandCount: 0,
	message: buildFinishCheckMessage,
	finish: () => 0,
	continueMessage: buildFinishCheckContinueMessage,
};

type Verifier = typeof import("../../todo-verify-run.ts") & typeof import("../../todo-verify.ts");

export function createFinishCheckTodo(omk: ExtensionAPI, env: NodeJS.ProcessEnv): FinishCheckTodo {
	if (!resolveTodoVerify(env.OMK_TODO_VERIFY)) return MAIN;
	let verifier: Verifier | undefined;
	// Until the import resolves (it does within milliseconds of extension load) the check behaves as main.
	void Promise.all([import("../../todo-verify-run.ts"), import("../../todo-verify.ts")])
		.then(([run, verify]) => {
			verifier = { ...verify, ...run };
		})
		.catch(() => {});
	let run: TodoCheckRun | undefined;
	omk.events.on(FINISH_CHECK_EVENT_CHANNEL, (data) => {
		const event = data as { active?: boolean; extraTurn?: unknown } | undefined;
		// The result is emitted before the extra turn's message is built, so the run stays until the next check;
		// `log` writes once per run.
		if (event?.active === false && run?.finished) run.log(Boolean(event.extraTurn), env);
	});
	return {
		get commandCount() {
			return run?.commandCount ?? 0;
		},
		message(requirements) {
			run = verifier?.createTodoCheckRun(getCurrentTodoState(), requirements);
			return run?.message ?? buildFinishCheckMessage(requirements);
		},
		finish(messages, cwd) {
			const hasLines = (text: string) =>
				hasFinishCheckLedgerLines(text) || (verifier?.hasTodoLedgerLines(text) ?? false);
			return run?.finish(ledgerReply(messages, hasLines), cwd) ?? 0;
		},
		continueMessage(ledger) {
			return run?.continueMessage(ledger) ?? buildFinishCheckContinueMessage(ledger);
		},
	};
}
