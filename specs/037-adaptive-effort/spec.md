---
description: "Keep the configured reasoning effort while the agent plans, debugs or verifies, and send `high` (never more than the configured effort) for explore, edit, build and run, based on the active todo kind and a bash/tool phase classifier (opt-in, default off)"
---

# Feature Specification: Adaptive reasoning effort per phase

**Specification ID**: `037-adaptive-effort`
**Feature Branch**: `spec/037-adaptive-effort` (spec + test fixture, PR #129, merged as `86f5612`); implementation `feat/037-adaptive-effort` from origin/main `7da50f6`
**Created**: 2026-10-11
**Status**: Implementation (flag default off; effect unverified until the A/B)
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: 인호's request to vary reasoning effort by todo and task. Tech Lead split it into 049 (typed todos, OMK) and this spec (effort, Runtime Engineer). Rules below were settled in the team room on 2026-10-11 by Tech Lead, Bench Analyst, OMK and Runtime Engineer; the effort direction was reversed on 2026-10-11 (see Decisions).
**Depends on**: 049 (`TodoKind`, `activeTodoKind()`; branch `feat/049-typed-todos`, not on main yet), 059 (`llm-call.jsonl`, Runtime Engineer's separate PR that reserves `phase`/`phaseSource` as `null`), 033 (response reasoning cap, on main), 042 (`appendRunLog`), 051 (`omk-ai` `prompt-hash`).
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: advance (benchmark score), opt-in. Default behavior is unchanged; the flag stays off in 1.5.0. The effect is unverified until the A/B runs, which wait for credits and 인호's approval.

| Dimension | Baseline | Acceptance target | Regression floor | Verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Request bytes (flag off) | main `b60d3c4` | With `OMK_ADAPTIVE_EFFORT` unset, provider payloads are byte-identical to main and `phase-classifier.ts` / `adaptive-effort.ts` are never loaded | Any byte difference or module load fails CI | `npx vitest run test/adaptive-effort-flag-off-cold-path.test.ts test/adaptive-effort.test.ts` in `packages/coding-agent` | those files |
| Classifier parity | Bench Analyst's `phase_r8_v3.decide` (sha256 `d0dcbf7856c5…`, lib `phase_r8_v2.py` `9353de25b324…`) | 310/310 fixture samples match | Any mismatch fails CI | `npx vitest run test/phase-classifier.test.ts` | `test/fixtures/phase-classifier-r8.json` |
| Prompt cache | R8: 90.2% cache read; 16.1% of consecutive call pairs read < 50% of the previous prompt; gaps > 5 min only 0.5% (Bench Analyst, R8) | With the flag on, `systemHash`/`toolsHash` are constant for the whole session and the model never changes | Any hash change across turns fails CI | `npx vitest run test/suite/adaptive-effort-cache.test.ts` | that file + `llm-call.jsonl` cacheRead/cacheWrite around each switch |
| Off cost (Perf) | main, same box | Paired 20-pair run, `paired_verdict.py --block startup_ms=5 --block idle_rss_mib=5` gives OK | BLOCK on a clear regression only (CI lower bound > 0 and median ≥ the value) | `/workspace/omk-bench-analyst/paired_verdict.py` (sha256 `07afdce05289…`) | Perf Engineer's TSV |
| Benchmark | A arm (R8 conditions, everything `xhigh`) on the same pin | Staged A/B (see Measurement): pass rate non-inferior (`≥ A − 1` on common tasks) and the median of per-run paired differences in `cost_in_usd_ticks` below 0 (bootstrap 95% CI strictly below 0) | Pass rate below `A − 1` | Staged A/B below | run ledger under `/workspace/omk-eval-*` |

## Problem

- Every request in a run uses one effort (`thinkingLevel`). The bench runs one level for the whole task, whether the agent is listing files or debugging a failing test.
- The work that most needs thinking (planning, a repeated failure, judging whether a result is correct) is a small share of calls. In R8 (Bench Analyst, `phase_r8_v2.out`, 265 runs, 11,251 classified calls) the phase split was explore 37.9%, edit 33.1%, run 15.1%, verify 7.3%, build 6.3%, debug 0.2%. With the v3 classifier (Bench Analyst R8 v3 rerun, 2026-10-11, 11,251 tool calls) the low group is 91.4% and the high group 8.7% of calls.
- The bench already runs at the top level: `/workspace/omk-ab/run_ab.sh:13` exports `EFFORT=xhigh` (grok-4.7). `/workspace/omk-ab` is not a git repository; the script's sha256 is `9daa1aec36002057da1558f06a3735c8ce98578f9516a161b45aa09918529e04`. On grok-4.7 `max` and `ultra` send `"xhigh"` (`grok-thinking.ts:4-13`), so there is no higher level to raise to. The room for a gain is cost and time on the low-group calls, not pass rate.
- Todo kinds alone are too sparse to drive effort: in R8, 123/265 runs (46%) used `update_todo`, median 3 calls per run, against about 44 tool calls per run. `bash` is 75% of 11,572 tool calls, so the bash command text is the main signal.

## Current code (main `b60d3c4`)

Where effort is set per request:

- `packages/agent/src/agent.ts:406`: `createLoopConfig()` sets `reasoning` from `_state.thinkingLevel` (`"off"` → `undefined`). `packages/agent/src/agent-loop.ts:468-473` lets a `prepareNextTurn` snapshot replace it between turns.
- That `reasoning` reaches every `StreamFn` call as `options.reasoning`. The main agent's `streamFn` is built in `packages/coding-agent/src/core/sdk.ts:511` by `createSdkProviderStream` (`core/sdk-provider-stream.ts:28-30`), which is also used by first-party summary calls through `agent.streamFn` (`core/compaction/compaction.ts:541-542`).
- `packages/agent/src/provider-request.ts:50-51` checks `options.reasoning` against the model contract.
- The wire value comes from `model.thinkingLevelMap` (`packages/ai/src/providers/openai-completions.ts:563-574`). For grok-4.7 (`packages/ai/src/providers/grok-thinking.ts:4-13`) `xhigh`, `max` and `ultra` all send `"xhigh"`. `getSupportedThinkingLevels(model)` (`packages/ai/src/models.ts:95`) already hides levels whose wire payload collapses into another.

Where 033 wraps the stream:

- `sdk-provider-stream.ts:29`: `createResponseReasoningCapStreamFn(createProviderStream(runtime), resolveResponseReasoningCapConfig())`.
- `core/response-reasoning-cap.ts:124` reads `options.reasoning` as the first attempt's effort; `:42-54` lowers it one step for the retry, sent at `:223`.

## Design

### 1. Activation and insertion point

- Off unless `OMK_ADAPTIVE_EFFORT=1` (exactly `1`; anything else, including unset, is off). Read once when the stream function is built.
- **Insertion point: `core/sdk-provider-stream.ts` `createSdkProviderStream`, outermost.** On main `7da50f6` (059, #128) that function returns `cap(llmCallLog(provider))`, with the model contract applied inside `provider`. The implementation PR moves the contract into its own layer above the log (Tech Lead's #128 review: `effortSent` must be read after the contract), and 037 wraps the result, so the composed stream is `adaptive(cap(contract(llmCallLog(provider))))`:

  ```ts
  const capped = createResponseReasoningCapStreamFn(
  	createModelContractStreamFn(createLlmCallRunLogStreamFn(createProviderStream(runtime)), runtime.modelContract),
  	resolveResponseReasoningCapConfig(),
  );
  return process.env.OMK_ADAPTIVE_EFFORT === "1" ? createLazyAdaptiveEffortStreamFn(capped) : capped;
  ```

  The 059 log is innermost, so each provider request (including a 033 retry) is logged with the effort it was actually sent with, after 037, the cap and the model contract. Without a contract `createModelContractStreamFn` returns its inner stream itself; a request the contract refuses never reaches the log.

  `createLazyAdaptiveEffortStreamFn` is a few lines in `sdk-provider-stream.ts`: on its first call it does `await import("./adaptive-effort.ts")` and keeps the wrapper. With the flag off nothing is imported, the returned function is the same `capped` object as today, and request bytes match main.
- **Composition with 033.** The adaptive wrapper decides the effort and passes it as `options.reasoning` to the cap wrapper. The cap therefore applies to the effort actually sent: it measures that attempt and, on overrun, retries one step below *that* effort. A 033 retry happens inside one outer call, so it is not a classification and does not move 037's state.
- **Subagent workers**: always off (`worker-env.ts` sets `OMK_ADAPTIVE_EFFORT=0`, as for 034 and 049).
- **Summary and compaction calls**: a call whose `context.tools` is empty or missing is passed through untouched and does not update state.

### 2. Phase

```ts
import type { TodoKind } from "./todo-state.ts"; // 049: "plan" | "explore" | "edit" | "debug" | "verify"
export type Phase = TodoKind | "build" | "run";
export type PhaseSource = "todo" | "tool";
```

Each outer call resolves one phase from two inputs:

- **Todo kind**: `activeTodoKind()` from `core/todo-runtime-state.ts` (049). Read only when `OMK_ADAPTIVE_EFFORT=1`, **independent of `OMK_TODO_VERIFY`**. If 049's flag is off but the model still sends `kind`, the value is stored as on main and 037 uses it; this keeps the 037 arm from also having to switch on 049. `undefined` (no todo, or 049's `unknown`) means no todo signal.
- **Tool signal**: the classifier result for the tool calls of the last assistant message (section 3), processed once per tool call id.

Resolution, in order:

1. Todo kind is `plan` → `plan`, source `todo`. `plan` only ever comes from the todo kind; the tool classifier cannot produce `plan`. The todo kind is one input to the phase, not the trigger for an effort change: effort changes are driven by the resolved phase through the hysteresis and cap in section 4 (Decision 3).
2. Tool signal defined → that phase, source `tool` (the tool signal wins over a disagreeing todo kind).
3. Todo kind defined → that kind, source `todo`.
4. Otherwise keep the previous phase and its source; at the start of a run, no phase (low group).

`activeTodoDifficulty()` is not read in v1 (no data yet).

**Until 049 is on main** (not on `7da50f6`): `phase-classifier.ts` defines `TodoKind` locally with the same five values (marked `TODO(049)`), and `createAdaptiveEffortStreamFn` takes the todo kind as an injected `todoKind()` that defaults to no todo signal. Phases then come from tool calls only. Wiring `activeTodoKind()` (and importing 049's `TodoKind`) is a follow-up once 049 merges.

**Implementation choices** (not fixed above): tools that give no tool signal (`update_todo`, subagent, MCP, …) are not added to `recent`, as in `phase_r8_v3.load_runs`; the classifier's previous phase starts undefined (the bench script starts at `run`; both are the low group). Every outer call with tools is one classification, including a call that re-sends a context with no new tool calls (it resolves to the previous phase). A `lowerClamped` call neither advances the 2-classification count nor changes the group, so every group change is a counted switch and the 4-switch cap always ends in low.

### 3. Classifier (`core/phase-classifier.ts`, pure functions)

All rules live in one module of pure functions with no I/O, mirroring Bench Analyst's `phase_r8_v3.decide` (which reuses `phase_r8_v2.py` and the segment rules of `phase_r8.py`). Signature, matching the fixture:

```ts
decidePhase(input: { command: string; failed: boolean; prevPhase: Phase | undefined; recent: ReadonlyArray<{ key: string | null; failed: boolean }> }): Phase | undefined
```

`recent` is the last five tool calls (non-bash tools have `key: null`). `failed` is the tool result's `isError`; for `bash` that covers a non-zero exit, timeout and abort (`core/tools/bash.ts:229-250`).

**Non-bash tools**: `read`, `grep`, `find`, `ls` → `explore`; `edit`, `write` → `edit`; `diagnostics` → `verify`. Other tools (`update_todo`, subagent, MCP, …) give no tool signal.

**Bash, plain commands.** Text before the first `<<` is split on `&&`, `||`, `;`, `|` and newline. Each segment is classified after stripping prefixes (`sudo`, `nice`, `time`, `nohup`, `stdbuf`, `command`, `exec`, `VAR=…`, `timeout <opts> <dur>`); the highest segment wins with order verify > build > edit > run > explore. A command with no classified segment is `explore`.

- **edit**: `sed -i`, `tee`, `patch`, `git apply`, or an output redirect `>`/`>>` to anything other than `/dev/null` or an fd (covers `cat > file`).
- **verify**: `pytest`, `ctest`, `python -m pytest`/`unittest`, `npm|yarn|pnpm test`, `cargo test`, `go test`, `make test|check`; a binary whose name contains `test`/`check`; `bash|sh|python|node` running a path under `test/`/`tests/` or named `test_*`, `run_tests*`, `*check*`.
- **build**: `make`, `cmake`, `ninja`, `meson`, `./configure`, `gcc`/`g++`/`clang`/`cc`/`c++`, `rustc`, `javac`, `tsc`, `cargo build|install|check`, `go build|install|get|mod`, `npm|yarn|pnpm install|i|ci|add|run *build*`, `pip`/`pip3`/`uv`/`conda`/`python -m pip` (except `show|list|freeze` → explore), `apt`, `apt-get`, `dpkg`, `mvn`, `gradle`.
- **explore**: `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `tree`, `file`, `wc`, `stat`, `diff`, `sort`, `awk`, `jq`, `readelf`, `objdump`, `strings`, `xxd`, `ps`, … (the full list is `EXPL` in `phase_r8.py`), `sed` without `-i`, read-only `git` subcommands (`log`, `diff`, `show`, `status`, …), `--help`/`-h`, `man`.
- **neutral** (no vote): shell keywords, `cd`, `echo`, `export`, `mkdir`, `cp`, `mv`, `rm`, `chmod`, `sleep`, ….
- **run**: anything else, i.e. executing a program or script; also other `npm`/`cargo`/`go`/`git` subcommands.

**Bash, inline python** (`python3 - <<EOF`, `python3 <<EOF`, `python3 -c …`, within the first 3000 chars). If a segment before the python call is verify, build or edit, that wins. Otherwise the body is classified in order:

1. writes → `edit`: `open(…, 'w'|'a'…)`, `.write_text`, `.write_bytes`, `json.dump(…, f)`, `shutil.copy|move`, `os.rename|replace`, `.to_csv(`, `.save(`, `np.save`;
2. checks → `verify`: `assert`, `== expected`/`expected ==`, `PASS`/`FAIL`, or `subprocess` together with `test`;
3. read-and-print only → `explore`: no `subprocess`/`os.system`/`def`/`class`/`while`, under 40 lines, and uses `print`/`listdir`/`glob`/`read`;
4. otherwise → no new phase (keep the previous phase).

**debug.** A command key is the first token that is a path or a script file (`.py`, `.sh`, `.js`, `.pl`, `.R`) in the winning segment, else its first two tokens. All inline python shares the key `py:inline` (equivalent to "body hash, loosened: any inline python within the next 5 calls after an inline-python failure counts as the same key"). When a call fails and a call with the same key also failed within the previous 5 calls (with or without edits in between), the phase is `debug`. The first failure keeps its normal phase (usually `verify` or `run`).

**One classification per outer call.** Before each LLM request, all not-yet-seen tool calls of the last assistant message are fed through `decidePhase` in order (updating `recent` and the previous phase); the phase after the last one is that call's tool signal. A call with no new tool calls has no tool signal.

**Rule changes** must update, in the same PR, the TypeScript rules, `test/fixtures/phase-classifier-r8.json` (regenerated by Bench Analyst's `phase_fixture.py`) and Bench Analyst's `phase_r8` script, so the runtime and the bench analysis agree. The script stays outside the repo; the PR updates its sha256 in Decisions 2.

### 4. Effort switching

- **Two groups.** High = `plan`, `debug`, `verify`. Low = `explore`, `edit`, `build`, `run` (and "no phase", so a run starts in low).
- **Ceiling.** The configured effort (`options.reasoning` from `thinkingLevel`, the user's default or `/think`) is the ceiling. It is re-read on every call, so `/think` changes apply. 037 never sends more than the ceiling and never raises to `max`.
- **Supported levels per model.** `getSupportedThinkingLevels(model)` (`packages/ai/src/models.ts:95`), ordered as `EXTENDED_THINKING_LEVELS`, reduced to distinct provider values: a level's provider value is `model.thinkingLevelMap?.[level] ?? level`, and of several levels with the same provider value only the lowest is kept. grok-4.7: `low`, `medium`, `high`, `xhigh` (`max`/`ultra` collapse to `xhigh`, `grok-thinking.ts:4-13`). grok-4.5: `low`, `medium`, `high` (`xhigh` is `null`; `max`/`ultra` send `"high"`). Anthropic models resolve through the same map (`anthropic.ts:796-815`); OpenAI-style providers through `thinkingLevelMap` (`openai-completions.ts:563-574`, `openai-responses.ts:273`).
- **High group sends the ceiling.** `options` is passed unchanged (same object).
- **Low group sends `high`.** Target = `high`, or the ceiling if the ceiling is below `high`. If the model does not support the target, the next supported level below it is used. The low-group level is therefore the same whether the ceiling is `max` or `xhigh`, and it equals arm C's level, so Stage 1 (A vs C) results apply to B's low group directly.
- **Clamped.** When the target's provider value equals the ceiling's provider value (ceiling `high` or below; grok-4.5 at `max`, which sends `"high"`), or the model supports no level at or below the target (reasoning undefined/off), nothing different is sent: `options` is passed unchanged and the call is logged `lowerClamped: true`. A clamped call is not a switch.
- **Examples.** grok-4.7, ceiling `xhigh` (the bench): A all `xhigh`; B high group `xhigh`, low group `high`; C all `high`. Ceiling `max` on a model that maps `max` separately (for example a Claude model with `{"xhigh":"xhigh","max":"max"}`): A all `max`; B high group `max`, low group `high`; C all `high`.
- **Hysteresis.** The group changes only when the new group holds for **2 consecutive classifications** (outer calls, resolved phase from the todo kind and the tool classifier, section 2). Effort changes only on a group change. This replaces the earlier "change effort only when the todo changes" rule (Decision 3).
- **Cap.** At most **4 switches per run** (process). The run starts in low, so after the 4th switch it is back in low and stays there. The cache cost of these switches is checked with Requirement 7 (`cacheRead`); see Decision 3 for the fallback.

### 5. Prompt cache rules (Tech Lead, required)

- The model is never switched within a conversation: the wrapper passes `model` through unchanged.
- Effort changes only on a group change through section 4 (2-classification hysteresis, 4-switch cap), and only downward from the ceiling.
- System prompt and tool list bytes are identical for the whole session; 037 only changes `options.reasoning`, never `context.systemPrompt` or `context.tools`.
- Thinking blocks during tool use are passed through unchanged: `context.messages` is passed as is; `transform-messages.ts:106` keeps signed thinking blocks for the same model, and the model never changes.
- `llm-call.jsonl` records `cacheRead`/`cacheWrite` for every call, so the cache-hit drop on the call after each switch is measurable. On Anthropic, changing thinking parameters invalidates message-level cache breakpoints while system and tools stay cached; this is why switches are rare (hysteresis, cap) and why Requirement 7 measures it on a Claude model. xAI behavior is unknown and is measured the same way.

### 6. Run log (`llm-call.jsonl`, spec 059)

With the flag on, 037 fills the fields 059 reserves as `null` and adds its effort fields, through a setter in 059's record module (with the flag off the setter is never called, `phase`/`phaseSource` stay `null` and the other fields are absent):

- `phase`: `Phase | null`; `phaseSource`: `"todo" | "tool" | null`
- `effort` (059's existing field) is the level passed to the provider stream after 037 and the 033 cap chose it (059 sits innermost), and `effortSent` (059) is its provider wire value (for example `max` → `"xhigh"` on grok-4.7); 037 adds neither
- `effortGroup`: `"low" | "high"`
- `effortSwitch`: `{ from, to, n }` on the call where the group changed, else `null`
- `lowerClamped`: boolean (section 4); there is no `raiseClamped`, since 037 never raises
- 059's existing `cacheRead`, `cacheWrite`, `systemHash`, `toolsHash` give the before/after view.

Privacy (spec 042): enums, numbers and hashes only. No command text, todo label or prompt text.

## Agent-Oriented Requirements

### Requirement 1 - Classifier parity (Priority: P0)

**Agent**: coder · **Evidence Gate**: command-pass · **Risk**: low (pure functions)

`test/phase-classifier.test.ts`:
1. For every sample in `test/fixtures/phase-classifier-r8.json` (310: debug 60, verify/explore/build/run/edit 50 each), `decidePhase({ command, failed, prevPhase, recent })` equals `expected`. Failure output lists the mismatching indices.
2. Unit cases: `plan` is never returned; non-bash tool mapping; a first failure is not `debug`; a second same-key failure within 5 calls is `debug` with and without an edit in between; inline python write/check/read/other order; segment order verify > build > edit > run > explore.

### Requirement 2 - Flag off is main (Priority: P0)

**Risk**: low

1. `test/adaptive-effort.test.ts`: with the flag unset, `createSdkProviderStream` returns the same function object as the 033 path, and a mock provider's captured payload (`onPayload`) is byte-identical for flag unset vs `OMK_ADAPTIVE_EFFORT=0`, over a multi-turn tool-using conversation.
2. `test/adaptive-effort-flag-off-cold-path.test.ts` (pattern of `print-mode-worker-cold-path.test.ts`): with the flag off, `phase-classifier.ts` and `adaptive-effort.ts` are never loaded during a headless run against a local mock.
3. Perf off cost: paired 20 pairs, `paired_verdict.py --block startup_ms=5 --block idle_rss_mib=5` returns OK.

### Requirement 3 - Phase resolution and switching (Priority: P0)

**Risk**: medium (changes the effort sent)

`test/adaptive-effort.test.ts`, fake inner `StreamFn` recording `options.reasoning`:
1. Todo `plan` + tool signal `edit` → `plan`/`todo`. Todo `edit` + tool `verify` → `verify`/`tool`. No todo + tool `explore` → `explore`/`tool`. Todo `debug` + no tool signal → `debug`/`todo`. Neither → previous phase.
2. `activeTodoKind()` is read with `OMK_TODO_VERIFY` unset.
3. The run starts in low: grok-4.7 at ceiling `xhigh` sends `high` from the first call. One high classification does not switch; two in a row switch to high and pass the caller's `options` object unchanged (`xhigh`); two low in a row switch back to `high`.
4. Low-group target: ceiling `max` or `xhigh` → `high`; ceiling `medium` → `medium` (never above the ceiling); a model without `high` → the next supported level below; grok-4.5 at ceiling `max` (sends `"high"`) → `options` unchanged, `lowerClamped: true`, not counted toward the cap; reasoning off/undefined → unchanged, `lowerClamped: true`. No call ever sends a level above the ceiling.
5. After 4 switches no further switch happens and the run stays in low.
6. A 033 retry inside one outer call does not advance the classification; the cap's retry effort is one below the effort 037 sent.
7. A call with no tools (summary/compaction) gets `options` unchanged and leaves state unchanged.
8. Each tool call id is classified once, even when the same context is sent again.

### Requirement 4 - Cache invariants (Priority: P0, Tech Lead)

`test/suite/adaptive-effort-cache.test.ts`, real `AgentSession` with the flag on and a scripted mock provider that drives a high-group switch and back:
1. `systemHash` and `toolsHash` (`omk-ai` `prompt-hash`) are equal on every request of the session.
2. The `model` passed to the provider is the same on every request.
3. `messagesPrefixHash` of the previous turn's messages is unchanged on the next request, including assistant messages with thinking blocks produced at a different effort.
4. Every `llm-call.jsonl` line has `cacheRead`/`cacheWrite`, and the switch call carries `effortSwitch`.
5. Thinking blocks are passed through: the assistant messages (with signed thinking blocks) sent back to the provider are byte-identical to what the provider returned, across a switch.

### Requirement 5 - Run log (Priority: P0)

With a temp `OMK_RUN_LOG_DIR`: flag off → `phase`/`phaseSource` stay `null`; flag on → enum values as above; a unique string planted in a bash command and a todo label never appears in the file.

### Requirement 6 - Gates (Priority: P0)

biome, module-size, import-cycles, `tsgo --noEmit`, and the touched vitest files pass. New modules under the 250 pure-LOC ceiling. No `any`. First commit is this spec and the fixture.

### Requirement 7 - Cache read across effort changes on a Claude model (Priority: P0, 인호 / Tech Lead)

Anthropic invalidates the message-level cache when thinking settings change; system and tools cache survive. Using 059's `llm-call.jsonl` from a Claude-model run with `OMK_ADAPTIVE_EFFORT=1` (a short live session, or the Claude arm if one is run), report for every `effortSwitch` the cache-read ratio `cacheRead / (input + cacheRead + cacheWrite)` of the call right after the change versus the call right before, with `cacheWrite` shown separately, the number of switches, and `gapMs` (to separate TTL expiry from the effort change). The same report is made for the xAI arm. This is a reported measurement, not a pass/fail gate; a drop is expected on Claude and bounded by the 4-switch cap. If the drop is noticeable, Decision 3's fallback (todo-only switching) applies. **The real Claude run costs credits and does not run until 인호 approves it**; a local mock run cannot replace it, because the cache behavior is the provider's.

## Measurement (staged A/B, pending credits and approval)

Bench Analyst R8 v3 rerun (2026-10-11, v3 classifier, 11,251 tool calls): low group 91.4% of calls, high group 8.7%; with the 2-consecutive rule 150/265 runs (57%) never switch group. In those runs B and C send identical requests, so B can differ from C only on the other 43% of runs and only on about 9% of their calls.

**Arms** (one joint pin build that contains 037; same model grok-4.7, same TB timeouts, workers off, 049 and every other opt-in flag off in all arms):

- **A, control**: R8 conditions, everything `xhigh` (`EFFORT=xhigh`, `/workspace/omk-ab/run_ab.sh:13`, sha256 `9daa1aec36002057da1558f06a3735c8ce98578f9516a161b45aa09918529e04`; `/workspace/omk-ab` is not a git repo).
- **B, 037**: `OMK_ADAPTIVE_EFFORT=1`, ceiling `xhigh`; high group `xhigh`, low group `high`.
- **C, all `high`**: config only (`EFFORT=high`), flag off.

**Stage 1: A vs C** (runs after the joint A/B credits exist and 인호 approves the spend):
- Pass rate, non-inferiority: C ≥ A − 1 on common tasks (the earlier A/B rule `B ≥ A − 1`).
- Cost: the median of per-run paired differences in `cost_in_usd_ticks` (d = C − A, paired by task × repetition), with a bootstrap 95% CI from Bench Analyst's `/workspace/omk-bench-analyst/paired_verdict.py` (sha256 `07afdce05289…`: 10,000 resamples, fixed seed `20261011`, the team rule). C wins on cost only if the CI is strictly below 0.
- Time is reported only.

**Stage 2** depends on Stage 1:
- **C non-inferior**: 037 has little room to beat C. Whether to change the default effort to `high` is decided separately, and B is not run.
- **C loses pass rate**: run B vs A (and B vs C) to see whether keeping `xhigh` on plan/debug/verify recovers the loss. Same rules: B ≥ A − 1 on common tasks; cost as above.
- At this n (3 runs/task/arm, 57% of runs identical between B and C), a B vs C verdict defaults to **inconclusive** unless the pre-registered rule is clearly met.

**Common to all stages**:
- Frozen before running (Bench Analyst, per the constitution): pin SHA, tasks and controls, 3 runs/task/arm, win rule and uncertainty statement. Pairing is by task × repetition. Runs with ≥ 1 switch are a secondary view only.
- Cost source: xAI `cost_in_usd_ticks` from the adapter's `omk_usage_raw.jsonl` (joined to `llm-call.jsonl` per call where needed). `costTotal` (`usage.cost.total`, logged by 059) undercounts xAI because it leaves out reasoning tokens, exactly the tokens 037 changes, so it is reported only and never used for a verdict. A call whose usage never arrived (`usageMissing: true` in 059, e.g. a cap abort) is counted with a lower and an upper bound, not as 0. `usage.cost.billed` is not on main (only on `ab/leak-fixes` `53924015ba`); if it lands before the run and matches the ticks, it may be shown alongside them. Cache read and cache write are shown separately. Claude `cacheWrite` is priced only when running Claude.
- Cache report: per switch, cache-read ratio of the call before vs after (Requirement 7), against the R8 reference (16.1% of consecutive pairs read < 50% of the previous prompt).
- Report: pass count per task per arm; switches per run (median, p90, share at the cap); share of `lowerClamped` calls; time and cost per run.
- Until then the effect is unverified and the flag stays off (also in 1.5.0).

## Known risks

- A `plan` todo left active wins over every tool signal, so such a run can stay in the high group while editing. Visible in `llm-call.jsonl` (`phaseSource: "todo"`, `phase: "plan"`).
- The fixture covers bash classification on R8 commands only; other task mixes may classify differently.
- Masked fixture commands (placeholders such as `d1/f1`, `b3`, `q2`) keep the rule-relevant tokens; a rule that depends on masked text cannot be checked by the fixture.

## Non-goals

- Switching models.
- Per-turn effort chosen by the model, or any prompt change.
- Raising effort above the configured default, including raising failed or hard todos to `max`. Out of 1.5.0; a separate A/B later.
- Changing the default effort itself (decided separately from Stage 1, see Measurement).
- Using `activeTodoDifficulty()`.
- Default-on, or a `settings.json` key.

## Decisions

1. **Direction reversed: lower the low group instead of raising the high group** (Tech Lead, 2026-10-11 15:18 KST). The bench base is `xhigh`, the top grok-4.7 wire level, so the earlier "raise the high group one level" design was a no-op (every raise clamped). This reverses the earlier "037 v1 does not change the default effort" decision. Refined later the same day (Tech Lead): the configured effort is the ceiling and is never exceeded; the low group is fixed to `high` (or the ceiling if lower, or the next supported level below), not "one level below"; the A/B is staged (A vs C first). Flag off still changes nothing.
2. **Bench's phase script stays out of the repo.** Only the masked JSON fixture is committed. `phase_r8_v3.py` sha256 `d0dcbf7856c52f781742b903095aea47e06872f6da69fd17a662dd9af29012a5` (lib `phase_r8_v2.py` `9353de25b32401a32c87331d4a3b19911b8f753d8c06ab7e6560367964378a2e`). A rule change updates the TypeScript rules, the fixture and these sha256 values in the same PR.
3. **Effort switches on the resolved phase (tool classifier + todo kind), not only on todo changes** (Tech Lead, 2026-10-11, PR #129 review). This replaces Tech Lead's earlier rule "change effort only when the todo changes". Rule: the group changes after 2 consecutive classifications in the new group, at most 4 switches per run (section 4). Reason: todo-only switching would never act in runs that use no todos (in R8, 142/265 runs never called `update_todo`), and Bench Analyst's R8 v3 analysis and the A/B design are based on this rule. The prompt-cache cost of switching is checked with Requirement 7's `cacheRead`; if on a Claude model `cacheRead` drops noticeably because of the switches, 037 falls back to todo-only switching.

## Expected Files

This PR:
- `specs/037-adaptive-effort/spec.md`
- `packages/coding-agent/test/fixtures/phase-classifier-r8.json`: Bench Analyst's `phase_fixture_v3.json` byte for byte (sha256 `3288f329ae2500a09f0e54089df4488575f906c35277bd1d8d466f0fd47acf96`); masking checked: no absolute user paths, URLs, tokens or TB task names

Implementation PR (`feat/037-adaptive-effort`, from origin/main `7da50f6`):
- `specs/037-adaptive-effort/spec.md`: this update (base, Expected Files, 049 interim, composition)
- `packages/coding-agent/src/core/phase-classifier.ts`: pure classifier, phase resolution and groups; local `TodoKind` until 049
- `packages/coding-agent/src/core/adaptive-effort.ts`: `StreamFn` wrapper, low-group level, hysteresis and cap state, injected todo kind, 059 field setter call
- `packages/coding-agent/src/core/sdk-provider-stream.ts`: model contract as its own layer above the 059 log (#128 review), flag check and lazy wrapper (outermost, around `cap(contract(llmCallLog(provider)))`)
- `packages/coding-agent/src/core/llm-call-run-log.ts`: `setLlmCallPhaseFields` fills `phase`/`phaseSource` and adds `effortGroup`/`effortSwitch`/`lowerClamped` for the current call; never called with the flag off
- `packages/coding-agent/CHANGELOG.md`: Unreleased entries for the opt-in flag and the `effortSent` fix (`scripts/sync-readme-releases.mjs` run; README release sections only list released versions, so no change)
- `packages/coding-agent/examples/extensions/subagent/worker-env.ts`: `OMK_ADAPTIVE_EFFORT=0`
- `packages/coding-agent/docs/environment-variables.md`: `OMK_ADAPTIVE_EFFORT` row and the full `llm-call.jsonl` field list
- Tests: `test/phase-classifier.test.ts`, `test/adaptive-effort.test.ts`, `test/adaptive-effort-flag-off-cold-path.test.ts`, `test/suite/adaptive-effort-cache.test.ts`, `test/sdk-provider-stream-contract-log.test.ts` (#128 review: `effortSent` after the contract), `test/finish-check-reverify.test.ts` (worker env)
