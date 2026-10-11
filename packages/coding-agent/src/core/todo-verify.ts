/**
 * Typed todos checked by the finish check (spec 049, `OMK_TODO_VERIFY`, default off).
 *
 * Loaded only with the flag on: `update_todo` imports it at extension load and the finish
 * check through `extensions/builtin/finish-check-todo.ts`. Off, nothing here runs and the
 * tool schema, its result text and every finish-check message stay byte-identical to main.
 *
 * Host checks only `file` checks (stat, size, a string in the first 1 MiB). A `command`
 * check is never run by the host: the model runs it in the check turn and reports a
 * `TODO n: PASS|FAIL - <value>` line, so tool approval and sandboxing stay in the way.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "omk-ai";
import { FINISH_CHECK_MAX_REQUIREMENTS } from "./finish-check-requirements.ts";
import { appendRunLog, type RunLogRecord } from "./run-log.ts";
import { TODO_DIFFICULTIES, TODO_KINDS, type TodoCheck, type TodoItem, type TodoKind } from "./todo-state.ts";

/** Checked todos per list; more are recorded only. Same as the REQ checklist limit. */
export const TODO_VERIFY_MAX_CHECKS = FINISH_CHECK_MAX_REQUIREMENTS;
/** Host file checks of one check turn stop after this; the rest are `unknown`. */
export const TODO_HOST_CHECK_BUDGET_MS = 200;
const CONTAINS_SCAN_BYTES = 1024 * 1024;
const MAX_COMMAND_CHARS = 500;
const MAX_CONTAINS_CHARS = 200;
const MAX_PATH_CHARS = 4096;
const MAX_LABEL_CHARS = 220;
const RUN_LOG_NAME = "todo-verify";

/** The three optional item fields added to `update_todo` with the flag on. Fixed for the session. */
export const TODO_VERIFY_ITEM_FIELDS = {
	kind: Type.Optional(
		Type.String({
			description:
				"Optional. What this item does: plan, explore, edit, debug or verify. Any other value is recorded as unknown.",
		}),
	),
	difficulty: Type.Optional(Type.String({ description: "Optional. Your estimate: low, medium or high." })),
	check: Type.Optional(
		Type.Object(
			{
				type: Type.String({ description: "file or command." }),
				path: Type.Optional(Type.String({ description: "file: the file that must exist." })),
				minBytes: Type.Optional(Type.Number({ description: "file: smallest valid size in bytes." })),
				contains: Type.Optional(Type.String({ description: "file: text the file must contain." })),
				command: Type.Optional(Type.String({ description: "command: a command that shows the item is done." })),
				expect: Type.Optional(
					Type.String({ description: "command: exit0 (default) or a short text the output must contain." }),
				),
			},
			{
				description:
					"Optional. How to show this item is done. When the item is marked done, the finish check verifies it.",
			},
		),
	),
};

export type TodoKindRecord = TodoKind | "unknown";
export type TodoVerifyResult = "pass" | "fail" | "unreported" | "unknown";
export type HostFileFailure = "missing" | "not-a-file" | "too-small" | "no-match";

interface RawTodoFields {
	readonly kind?: unknown;
	readonly difficulty?: unknown;
	readonly check?: unknown;
}

const cut = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);
const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

/** A check as the model sent it, or `undefined` when it is not usable (recorded as "without check", never a tool error). */
export function normalizeTodoCheck(raw: unknown): TodoCheck | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const check = raw as Record<string, unknown>;
	if (check.type === "file") {
		const path = text(check.path);
		if (path === undefined) return undefined;
		const minBytes = check.minBytes;
		const contains = text(check.contains);
		return {
			type: "file",
			path: cut(path, MAX_PATH_CHARS),
			...(typeof minBytes === "number" && Number.isFinite(minBytes) && minBytes > 0 ? { minBytes } : {}),
			...(contains !== undefined ? { contains: cut(contains, MAX_CONTAINS_CHARS) } : {}),
		};
	}
	if (check.type === "command") {
		const command = text(check.command);
		if (command === undefined) return undefined;
		const expect = text(check.expect);
		return {
			type: "command",
			command: cut(command, MAX_COMMAND_CHARS),
			...(expect !== undefined && expect.trim() !== "exit0" ? { expect: cut(expect, MAX_CONTAINS_CHARS) } : {}),
		};
	}
	return undefined;
}

/** The spec 049 fields of one `update_todo` item; a bad `kind` or `difficulty` is dropped (`unknown`), not an error. */
export function normalizeTodoFields(item: object): Pick<TodoItem, "kind" | "difficulty" | "check"> {
	const raw = item as RawTodoFields;
	const kind = TODO_KINDS.find((value) => value === raw.kind);
	const difficulty = TODO_DIFFICULTIES.find((value) => value === raw.difficulty);
	const check = normalizeTodoCheck(raw.check);
	return {
		...(kind ? { kind } : {}),
		...(difficulty ? { difficulty } : {}),
		...(check ? { check } : {}),
	};
}

/** Items the finish check verifies: the first `TODO_VERIFY_MAX_CHECKS` with a check, in list order. */
export function todoCheckTargets(items: readonly TodoItem[]): TodoItem[] {
	return items.filter((item) => item.check !== undefined).slice(0, TODO_VERIFY_MAX_CHECKS);
}

/** The line `update_todo` adds to its result with the flag on (numbers only). */
export function todoChecksLine(items: readonly TodoItem[]): string {
	const attached = items.filter((item) => item.check !== undefined).length;
	return `checks: ${attached} attached · ${items.length - attached} without check`;
}

const count = <T extends string>(values: readonly T[]): Record<string, number> => {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
};
const kindOf = (item: TodoItem): TodoKindRecord => item.kind ?? "unknown";

/** Spec 049 R5 `todo-snapshot` record: numbers and enums only, never label, detail, command or path. */
export function todoSnapshotRecord(items: readonly TodoItem[]): RunLogRecord {
	return {
		type: "todo-snapshot",
		total: items.length,
		byKind: count(items.map(kindOf)),
		byDifficulty: count(items.map((item) => item.difficulty ?? "unknown")),
		withCheck: items.filter((item) => item.check !== undefined).length,
		checkTypes: count(items.flatMap((item) => (item.check ? [item.check.type] : []))),
		done: items.filter((item) => item.status === "done").length,
	};
}

export function logTodoSnapshot(items: readonly TodoItem[], env: NodeJS.ProcessEnv = process.env): void {
	appendRunLog(RUN_LOG_NAME, todoSnapshotRecord(items), { env });
}

/** Why a host file check failed, or `undefined` when it passed. Never records the file's content. */
export function hostFileCheck(check: Extract<TodoCheck, { type: "file" }>, cwd: string): HostFileFailure | undefined {
	const path = resolve(cwd, check.path);
	let size: number;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return "not-a-file";
		size = stats.size;
	} catch {
		return "missing";
	}
	if (check.minBytes !== undefined && size < check.minBytes) return "too-small";
	if (check.contains === undefined) return undefined;
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(Math.min(size, CONTAINS_SCAN_BYTES));
			const read = readSync(fd, buffer, 0, buffer.length, 0);
			return buffer.subarray(0, read).toString("utf8").includes(check.contains) ? undefined : "no-match";
		} finally {
			closeSync(fd);
		}
	} catch {
		return "missing";
	}
}

const TODO_LINE = /^[\s>*`-]*TODO\s+(\d+)\s*:\s*(PASS|FAIL)\b[\s`*]*(?:[-–—:]\s*)?(.*)$/gim;

/** Whether `text` has at least one `TODO n: PASS|FAIL` line. */
export function hasTodoLedgerLines(reply: string): boolean {
	return new RegExp(TODO_LINE.source, "im").test(reply);
}

/** `TODO n: PASS|FAIL - value` lines of the check reply, by number. Same shape as the REQ ledger. */
export function parseTodoLedger(reply: string): Map<number, { status: "pass" | "fail"; measured?: string }> {
	const reported = new Map<number, { status: "pass" | "fail"; measured?: string }>();
	for (const match of reply.matchAll(TODO_LINE)) {
		const measured = match[3]?.replace(/[`*]+$/g, "").trim();
		reported.set(Number(match[1]), {
			status: match[2].toUpperCase() === "PASS" ? "pass" : "fail",
			...(measured ? { measured } : {}),
		});
	}
	return reported;
}

const label = (item: TodoItem): string => {
	const flat = item.label.replace(/\s+/g, " ").trim();
	return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
};

function describeCommand(check: Extract<TodoCheck, { type: "command" }>): string {
	const command = check.command.replace(/\s+/g, " ").trim();
	return check.expect === undefined ? command : `${command} (output must contain: ${check.expect})`;
}

export { describeCommand, label as todoLabel, RUN_LOG_NAME as TODO_VERIFY_RUN_LOG };

/** First 12 hex characters of the sha256 of a todo `id`, the only form an id takes in the run log. */
export function hashTodoId(id: string): string {
	return createHash("sha256").update(id).digest("hex").slice(0, 12);
}
