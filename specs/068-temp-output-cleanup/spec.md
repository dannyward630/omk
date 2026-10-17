# Spec 068: clean up full-output temp files (bash + MCP no-session spill) (1.4.4)

Status: spec only, Tech Lead decisions applied (2026-10-17). No implementation yet. **Lands after 066 merges.** Base: origin/main `fd495fd77b`. **Depends on 066**
(`harness/066-tool-output-truncation`, not merged yet), which adds the MCP no-session spill
`<tmpdir>/omk-mcp-<16 hex>.log`. Spec number: 066 and 067 are taken by local branches; 068 is free in all worktrees and branches.

## Problem
Every truncated bash result, and (with 066) every truncated MCP result in `--no-session` mode, leaves a 0600 file in
`$TMPDIR` that omk never deletes. Bench Analyst's 066 mock run2 (`/workspace/omk-eval-066/REPORT_run2.md`,
`ab_run2.tmp_before` = 3 → `ab_run2.tmp_after` = 123 `omk-mcp-*` files) left 120 files, about 72 MB, after one run of
280 CLI runs (`ab_run2/results.jsonl`). On this box `/tmp` now holds 772 `omk-bash-*.log` and 123 `omk-mcp-*.log` (265 MB for all
`omk-*.log`). Workers and benchmarks (R8 uses `--no-session -p`) grow this without bound, and the files can contain
secrets (that is why they are 0600).

Important for safety: a loose `omk-*.log` glob also matches about 40 unrelated logs on this box (`omk-build.log`,
`omk-pr80-check.log`, …) written by people and agents. Any sweep must match only the exact generated name.

## Current behaviour (`packages/coding-agent/src`)
| creator | path | when | deleted? |
|---|---|---|---|
| bash tool | `core/tools/output-accumulator.ts:20` `defaultTempFilePath(prefix)` → `<tmpdir>/<prefix>-<randomBytes(8) hex>.log`; created `:216-218` (mode 0600) once output exceeds the limits (`shouldUseTempFile` `:207`); prefix `omk-bash` (`core/tools/bash.ts:147`) | output > 2000 lines / 50KB | never; path is shown to the model (`core/tools/bash-output.ts:17-24`, `details.fullOutputPath`) |
| user `!` bash | `core/bash-executor.ts:71` `<tmpdir>/omk-bash-<16 hex>.log` (0600) | output > 100KB | only when the path is never surfaced (`discardTempFile` `:80-95`); else never |
| MCP no-session spill (066) | `core/mcp/output-cap.ts` → `defaultTempFilePath("omk-mcp")`, 0600, `flag: "wx"` | MCP text > cap and no session file | never |
| MCP session spill (066) | `<session>.artifacts/mcp-<id>.txt` | MCP text > cap, persisted session | with the session (`core/session-artifacts.ts`), **out of scope** |
| read spill | `core/tools/artifact-spill.ts:22` `mkdtemp(<tmpdir>/omk-spill-)` | read truncated | never (**listed as open question**) |

The process already knows about signals (`core/session-termination.ts:107`, `modes/rpc/rpc-mode.ts:350-359`,
`modes/acp/acp-mode.ts:27-28`), but no exit hook touches these files.

## Options
A. **Delete on process exit**: a per-process registry of created paths; synchronous `unlinkSync` in
   `process.on("exit")`. That covers a normal end, `process.exit()` called from the existing SIGINT/SIGTERM/SIGHUP
   handlers, and uncaught errors. SIGKILL and crashes still leak.
B. **Per-process registry only**: like A, but delete when the owning session/tool context is disposed (session
   switch, `/new`, end of print run). Finer than exit, but the paths outlive the result message in the transcript.
C. **Startup sweep**: at startup, delete files in `os.tmpdir()` that match exactly `^omk-(bash|mcp)-[0-9a-f]{16}\.log$`,
   are regular files (not symlinks) owned by the current uid, and are older than a threshold (proposed 24 h by mtime).
   Optional cap (e.g. keep the newest 200 MB). This catches SIGKILL and crash leftovers and pre-068 litter.
D. **Keep files referenced by a live session**: never delete a path that a persisted session still references.
   Either move it into `<session>.artifacts/` (as 066 does for MCP) or skip it in A/B/C while the session file exists.

## Decision (Tech Lead)
1. Registry + delete on exit (A) for files created while the session is **not persisted** (`--no-session`, print/json
   workers).
2. Persisted sessions keep today's behaviour. Moving their bash spills into `<session>.artifacts/` (option D) is a
   **separate spec, out of scope**. So are `omk-spill-*` read spills (`artifact-spill.ts:22`).
3. Startup sweep (C): strict pattern + uid + regular file + **24 h by mtime**, **once per day** via a stamp file in
   the agent dir, **no size cap**. Runs in every mode, including the interactive TUI, where it runs **asynchronously
   after the first render and never blocks startup**.
4. Long-running workers: a timer **touches (updates mtime of) this process's registered files every 1 hour**, so other
   processes' sweeps keep them. Timer based, not on write; registered files only; the timer is `unref()`ed.
5. Lands after 066 merges (the MCP temp files only exist with 066).

## Implementation constraints
- **No new dependencies** (no `tmp`, `tmp-promise`, `signal-exit`; Library Scout). Use `fs.unlinkSync`, the strict
  anchored regex `^omk-(bash|mcp)-[0-9a-f]{16}\.log$`, and `fs.lstatSync`.
- Hook into the existing signal handling (`core/session-termination.ts:107`, `modes/rpc/rpc-mode.ts:350-359`,
  `modes/acp/acp-mode.ts:27-28`) plus one `process.on("exit")` listener. Do not add new signal handlers that change
  how a signal ends the process.

## Safety rules
- Delete only paths this process created and registered (A), or files matching the strict pattern, owned by our uid,
  regular, and older than the threshold (C). Never a glob like `omk-*.log`; never follow symlinks (`lstat`).
- Model-read race: a file must stay while the process (or session) that put its path in a tool result is alive.
  A deletes only at exit. C only touches files older than 24 h, and a live process re-touches its registered files every
  hour, so another live process's files never reach the threshold.
- Decisions use `lstat`, never follow symlinks, and skip files of a different uid and non-regular files.
- Exit handler is synchronous, best effort, swallows errors, and never changes the exit code.
- The `!` bash `discardTempFile` path stays as it is.

## Risks
- **The uid check filters nothing on this box.** Every agent runs as the same uid (`box`), so "owned by our uid" is
  true for every agent's files. The real protection is the 24 h threshold plus the hourly touch of live files plus
  criterion 7. The uid and regular-file checks still protect multi-user hosts and odd entries (criterion 8).
- SIGKILL, OOM kills and crashes skip the exit handler (Node can't catch them); their files wait for the next daily
  sweep after 24 h.
- A process that is suspended for more than 24 h (SIGSTOP, laptop sleep) misses its touch ticks, so another process's
  sweep could delete its files. Accepted; the model can rerun the command.
- `os.tmpdir()` differs per process when `TMPDIR` differs; each process only sweeps its own `os.tmpdir()`.

## Prior art (Agent Researcher)
- Claude Code: startup cleanup of old tool-result and session files by age, `cleanupPeriodDays` (default 30).
  https://code.claude.com/docs/en/settings-reference, https://github.com/anthropics/claude-code/issues/38576
- Node.js: `exit` listeners must be synchronous, and SIGKILL can't be caught (hence the sync `unlinkSync` plus the sweep).
  https://nodejs.org/api/process.html
- wrangler added a startup sweep after SIGKILL leftovers. https://github.com/cloudflare/workers-sdk/issues/13872
- Anchored, fixed-length-hex regex for safe temp matching. https://github.com/bloknayrb/tandem/pull/872

## Flag plan (decided)
Default **off**: `OMK_TEMP_OUTPUT_CLEANUP=1` enables A, C and the touch timer. Unset or `0`: byte-identical to today
(same files created, none deleted, no exit handler, no timer, no sweep). Flipping the default to on is a separate,
later PR, after one release with the flag.

## Success criteria (fixed before any measurement)
OMK rule: every mock run and decoy test uses a **per-run private `TMPDIR`** (shared `/tmp` is used by all agents).
Mock setup as Bench Analyst run2 (`--no-session -p --mode json`, mock LLM + MCP server, outputs over the cap for both
bash and MCP), n = 20 runs per arm, flag on:
1. Files created by this run: **0 left** after it exits (before/after diff of its private `TMPDIR`). Other runs'
   leftovers are the sweep's job (C).
2. Mid-output fact recovery via `read` of the spilled path: **20/20** (same as 066 run2). The file exists while the run uses it.
3. SIGINT and SIGTERM during a run after a spill: **0** leftovers in 20 runs each.
4. SIGKILL leftovers: removed by the next startup sweep only when older than 24 h. A fresh one survives (faked mtime).
5. Decoys untouched: `omk-build.log`, `omk-bash-xyz.log` (bad hex), and a matching file younger than 24 h are kept.
6. Persisted-session runs: spilled files referenced by the session are kept (count unchanged vs main).
7. Two concurrent processes **under the same uid** (as on this box), sharing one private `TMPDIR`: process 1 holds registered spill files (mtime faked to > 24 h
   before its touch tick, then touched). Process 2's startup sweep must not delete process 1's live files (test).
8. Sweep decisions use `lstat`: a symlink matching the pattern (pointing at a real old file) is neither followed nor
   its target deleted; files of a different uid (when testable) and non-regular files (directory/FIFO with a
   matching name) are skipped (test).
9. Flag off: file creation and deletion counts identical to main; no exit handler, timer or sweep installed.
10. TUI: the sweep runs after the first render and never blocks startup (first-frame time unchanged within noise,
    paired A/B).
11. Full suite green; paired `--noreg` A/B (Bench Analyst) on success / ctx / wall time.

Do **not** manually delete the existing ~265 MB of `omk-*.log` in the shared `/tmp` before the flag merges.

## Open questions
Resolved by Tech Lead (2026-10-17): default off; 24 h / daily stamp / no size cap; hourly touch timer for registered
files; persisted-session bash spills and read spills are separate specs; the TUI sweep is async after the first render;
lands after 066. Remaining:
- Stamp file location and name (proposed `<agentDir>/temp-output-sweep.stamp`), and behaviour when the agent dir is
  read-only (skip the sweep).
