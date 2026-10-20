# Spec 100 — task_result real producer wiring

Status: draft (spec only, no implementation)
Base: `origin/main` @ `63bbd20b4f` (PR #175, spec 096 merged). **PR #177 (spec 099, head `46539fbcde`) was not on main at fetch time**; this spec assumes 099 lands first and must be rebased onto it before implementation.
Source: 인호's audit, section F2 ("task_result의 분류 입력을 실제 생산자에 연결").

## 1. Problem (all refs are `63bbd20b4f`)

1. **Producer drops the classification inputs.** `factFromGoalAcceptance(result, options)` accepts `currentWorkspaceSha256` and `matchedTests` (`packages/coding-agent/src/core/task-result.ts:164-170`) and uses them for `stale`/`zero_tests` (`task-result.ts:197-199`). The only real producer calls it with no options: `publishHostTaskFact(this.omk.events, factFromGoalAcceptance(result), taskRunId)` (`src/core/extensions/builtin/goal-controller-acceptance.ts:178-179`). So in production `stale` and `zero_tests` are unreachable; only unit tests with synthetic options reach them.
2. **No test counts exist at the source.** `GoalAcceptanceResult` (`src/core/goal-verification.ts:45-59`) has no executed/matched/skipped field and no `checkKind`. A tsc run and a `vitest` run that matched 0 tests are indistinguishable.
3. **Pass fact published before completion is decided.** The fact is published inside `run()` (`goal-controller-acceptance.ts:179`); `acceptance.complete()` is called later (`goal-controller-acceptance.ts:117`) and can throw `evidence-required` ("workspace changed after the acceptance check passed", `src/core/goal-acceptance.ts:137-145`; plus the 099 revision/digest refusal). The catch at `goal-controller-acceptance.ts:118-122` only notifies; the already-published `passed` fact is never downgraded. TUI/print/RPC therefore can show `check: passed` for a goal the host refused to complete.
4. **Coverage denominator is guessed.** `projectCoverage` sets `checksTotal: host.length` (`task-result.ts:134-140`), i.e. the number of facts observed, not the number of required checks. A required check that never ran yields `0/0`, which renders like "nothing required".
5. **Identity is receipt-scoped.** Fact id is `goal-acceptance:${receiptId}` (`task-result.ts:178`) and the collector keys by fact id (`src/core/task-result-collector.ts:92,104`). fail→fix→pass leaves two independent facts instead of one check with attempts.

## 2. Proposed change

Behind `OMK_TASK_RESULT` (existing flag, `task-result.ts:106-108`); see §4.

### 2.1 Source data — `src/core/goal-verification.ts`, `src/core/goal-acceptance.ts`
- Add to `GoalAcceptanceResult` (optional, additive):
  - `checkKind: "test_runner" | "typecheck" | "shell"` — classified from the approved command by a pure `classifyCheckKind(command)` (new, in `goal-verification.ts`); unknown → `"shell"`.
  - `tests?: { executed?: number; matched?: number; skipped?: number }` — filled only for `test_runner`, parsed from the runner's own summary line in the full output (node:test / vitest / jest summary formats; a pure `parseTestCounts(kind, output)`). A field the parser cannot read stays `undefined`. Never default to 0.
- Expose `acceptance.currentWorkspaceSha256(cwd)` reusing `captureGoalWorkspace(cwd).sha256` so freshness comes from the GoalAcceptance owner (audit: projection must not own a second verifier).
- `checkId` = goal key + approved-command digest; `checkRevision` = 099 contract revision. Both copied onto the result.

### 2.2 Fact — `src/core/task-result.ts`
- `GoalAcceptanceFactOptions` gains `executedTests`, `skippedTests`, `checkKind`, `checkId`, `checkRevision`, `completion?: "accepted" | "refused"`, `refusalReason?: string`.
- `TaskCheckFact` gains optional `checkKind`, `tests` (each count `number | "unknown"`), `checkId`, `attempt`.
- Rules (in order after existing failed/aborted/timeout/completeness/gate):
  - `test_runner` and `matched === 0` → `insufficient/zero_tests`.
  - `test_runner` and `matched` unknown → stays `passed` but `tests.matched = "unknown"` (no guess).
  - workspace sha differs → `insufficient/stale`.
  - `completion === "refused"` → `insufficient/completion_refused` (new reason) with `refusalReason`.
- `projectCoverage`: `checksTotal` from the registered required-check plan when known; otherwise `checksTotal: "unknown"` and `receiptsObserved: n`. Never `0` for unknown.

### 2.3 Producer — `src/core/extensions/builtin/goal-controller-acceptance.ts`
- `run()` (l.165-185): publish with full options (`currentWorkspaceSha256` captured after the check, counts, kind, checkId, revision).
- turn-settle path (l.112-128): after `complete()` throws `DurableGoalError`, publish a **replacement** fact (same `checkId`, same `attempt`) with `completion: "refused"`. On success publish nothing extra.
- Required-but-not-run: when a run settles with an approved command and no receipt for the current revision, publish `insufficient/not_run` for that `checkId`.

### 2.4 Collector — `src/core/task-result-collector.ts`
- Key current state by `checkId` (latest attempt wins; replacement of same attempt overwrites); keep prior attempts in `attempts[]` (not counted as separate required checks).

### 2.5 Surfaces — `src/modes/interactive/task-result-status.ts`, `src/modes/print-mode.ts`, `src/modes/rpc/*`
- Render `unknown` literally ("tests: ? matched", "checks: ?/? (1 receipt)"), never `0`. Show `checkKind` and the "observation, not task correctness" scope label already required by the audit.

## 3. Acceptance criteria (measurable)

Harness: a real `GoalAcceptanceFlow` + `GoalController` in a temp git repo with a tiny node:test project (temp HOME, `OMK_TRUST_PROJECT=0`, `env -u TYPESAFE_API_KEY`, `OMK_TASK_RESULT=1`). No hand-built `TaskCheckFact` and no direct `publishHostTaskFact` calls in these tests (enforced by a grep assertion in the test file). Each case asserts TUI status line, print-mode final block, and RPC `task_result` event, and asserts the three agree field-for-field on `check.status`, `reason`, `tests`, `coverage`.

| # | Case | Expected projection (all 3 surfaces) |
|---|------|--------------------------------------|
| 1 | fail→fix: approved `node --test`, first run 1 failing test, edit, rerun passes | final `check: passed`, `tests {executed:1, matched:1, skipped:0}`, `checkKind:test_runner`, one `checkId` with `attempts.length === 2` (failed, passed), `coverage 1/1`; goal completed |
| 2 | external edit: pass, then file edited before `complete()` | `insufficient`, reason `completion_refused` (or `stale` when detected at publish), refusalReason contains "workspace changed"; never `passed`; goal stays active |
| 2b | 099 revision refusal: pass under A, command changed to B before complete | `insufficient/completion_refused`; never `passed` |
| 3 | not run: approved command, run settles without a check | `insufficient/not_run`, `coverage 0/1` (planned denominator) — or `?/?` with `receiptsObserved:0` if plan unknown; never `0/0` |
| 4 | 0 tests: runner filter matches nothing, exit 0 | `insufficient/zero_tests`, `tests.matched: 0`; goal not completed via projection |
| 4b | unparseable runner output, exit 0 | `passed`, `tests.matched: "unknown"` rendered as `?` |
| 5 | cancel: Esc during check | `cancelled`; no `passed` fact ever emitted for that attempt (asserted on full RPC event stream) |

Also: flag off → zero `task_result` events and byte-identical print golden to `63bbd20b4f`; full coding-agent suite green; no new dependencies.

## 4. Flag decision

Proposal: **keep behind existing `OMK_TASK_RESULT`, default off** (1.4.x rule). Justification: task_result itself is default-off; this changes what it emits (new reasons, `unknown` values, replacement facts) and RPC consumers may parse `checksTotal` as a number. No new flag: a second flag would create untested on/off combinations. Additive `GoalAcceptanceResult` fields (kind, counts) are computed regardless of flag but are not surfaced when off. Flipping default-on is a separate decision for Tech Lead after these e2e cases pass.

## 5. Risks
- Test-count parsing is format-fragile; mitigated by `unknown` instead of guesses, and per-runner fixtures.
- `checksTotal: number | "unknown"` is an RPC type change (flag-gated, version bump of `TASK_RESULT_VERSION`).
- Replacement facts could race with run settlement; 096 run-scoping (`taskRunId`) must also gate the refusal fact.
- Workspace hash capture after each check adds cost on large repos (already done once in `complete()`).

## 6. Rollback
Flag off restores 096 behavior (no events). Code rollback: revert the merge; `GoalAcceptanceResult` additions are optional fields so older readers ignore them (to be verified by a test reading a new-field receipt with old parser, unlike #177 where this was unverified).

## 7. Open questions
1. Base: 099 not yet on main — confirm 100 waits for #177 merge (needed for `checkRevision` and revision refusal case 2b).
2. Where does the required-check plan (denominator) come from today? If only one approved command per goal, is `checksTotal = 1` acceptable, or should it stay `unknown` until multi-check plans exist?
3. Should a 0-matched `test_runner` pass also block `complete()` (behavior change to goals), or only downgrade the projection? Spec proposes projection only.
4. Which runners to parse in phase 1 (node:test, vitest, jest?) — and is `tsc` counted as `typecheck` with no test counts?
5. Case 2: publish-time `stale` vs. completion-time `completion_refused` — keep both reasons or collapse into one?
6. Is `skipped` > 0 with `matched` > 0 a pass, or a warning field only? (Audit lists "skipped" as a case; spec treats it as display-only.)
