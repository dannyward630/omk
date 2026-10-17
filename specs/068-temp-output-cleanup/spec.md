# Spec 068: clean up full-output temp files (bash + MCP no-session spill) (1.4.4)

Status: draft, spec only, no implementation. Base: origin/main `fd495fd77b`. **Depends on 066**
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

## Recommendation
**A + C, with D for persisted sessions:**
1. Registry + delete on exit (A) only for files created while the session is **not persisted** (`--no-session`, print
   or json workers). Nothing can reference those paths after the process is gone.
2. For persisted sessions, keep today's behaviour in 068 (the path is in the transcript and a resumed session may
   `read` it). Moving bash spills into `<session>.artifacts/` (D) is a follow-up spec.
3. Startup sweep (C) with the strict pattern + uid + age rule, rate-limited to once per day via a stamp file in the
   agent dir, so SIGKILL and crash leftovers are bounded too.

## Safety rules
- Delete only paths this process created and registered (A), or files matching the strict pattern, owned by our uid,
  regular, and older than the threshold (C). Never a glob like `omk-*.log`; never follow symlinks (`lstat`).
- Model-read race: a file must stay while the process (or session) that put its path in a tool result is alive.
  A deletes only at exit; C only touches files older than the threshold, so a file in use by another live
  `--no-session` process (younger than 24 h) survives. Open question: long-running workers older than the threshold.
- Exit handler is synchronous, best effort, swallows errors, and never changes the exit code.
- The `!` bash `discardTempFile` path stays as it is.

## Flag plan
Behaviour change → propose default-off `OMK_TEMP_OUTPUT_CLEANUP=1` (enables A and C); Tech Lead decides the default.
Unset or `0`: byte-identical to today (same files created, none deleted).

## Success criteria (fixed before any measurement)
Mock setup as Bench Analyst run2 (`--no-session -p --mode json`, mock LLM + MCP server, outputs over the cap for
both bash and MCP), n = 20 runs per arm, flag on:
1. Leftover files matching `^omk-(bash|mcp)-[0-9a-f]{16}\.log$` created by the runs: **0** (before/after diff of `$TMPDIR`).
2. Mid-output fact recovery via `read` of the spilled path: **20/20** (same as 066 run2). The file exists while the run uses it.
3. SIGINT and SIGTERM during a run after a spill: **0** leftovers in 20 runs each.
4. SIGKILL leftovers: removed by the next startup sweep only when older than the threshold. A fresh one (< threshold) survives (tests with faked mtime).
5. Decoys untouched: `omk-build.log`, `omk-bash-xyz.log` (bad hex), a symlink matching the pattern, a file owned by another uid (if testable), and a matching file younger than the threshold are all kept.
6. Persisted-session runs: spilled files referenced by the session are kept (count unchanged vs main).
7. Flag off: file creation and deletion counts identical to main; no exit handler installed.
8. Full suite green; paired `--noreg` A/B (Bench Analyst) on success / ctx / wall time.

## Open questions for Tech Lead
1. Default: off (`OMK_TEMP_OUTPUT_CLEANUP=1` to enable) or on with `=0` to roll back?
2. Sweep threshold and cap: 24 h by mtime? Plus a size cap (e.g. newest 200 MB kept)? Once per day via a stamp file?
3. Long-running `--no-session` workers (> threshold): touch (update mtime of) registered files periodically so another process's sweep keeps them, or accept the risk?
4. Persisted sessions: leave bash spills in `$TMPDIR` as today, or move them into `<session>.artifacts/` (option D) in 068?
5. Include `omk-spill-*` read-spill directories (`artifact-spill.ts:22`) in 068, or a separate spec?
6. Should the sweep also run for the interactive TUI, or only for print/json/rpc modes?
7. Land after 066 merges (MCP temp files only exist with 066), or merge with bash-only support first?
