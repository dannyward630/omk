# Spec 066: cap MCP tool output like built-in tools (1.4.4)

Status: implemented locally (Tech Lead decisions below). Base: origin/main `0ce36329dc`. Scope (Tech Lead): MCP output first.

## Problem
A tool result larger than the context window makes the session compact over and over (spec 061). 061 bounded the
loop: after `MAX_OVERFLOW_RECOVERY_ATTEMPTS = 2` (`core/agent-session.ts:144`, checked at `:3906`) the prompt ends with
`OVERFLOW_RECOVERY_FAILED` (`core/compaction/overflow-recovery-progress.ts:33`, tool-named message `:52`). So it no
longer hangs, but the turn still fails. Built-in tools can't trigger this, because their output is capped. MCP tools
have no cap, so one large MCP result costs two compactions and then a failed turn.

## Current sizing (file:line, `packages/coding-agent/src`)
| tool | limit | how | marker / way to get more |
|---|---|---|---|
| shared helper | 2000 lines / 50 KB | `core/tools/truncate.ts:11-12`; `truncateHead` `:78`, `truncateTail` `:168`, `truncateLine` `:268` (grep 500 chars `:13`) | `TruncationResult` `:14-37` |
| bash | last 2000 lines / 50 KB | `core/tools/output-accumulator.ts:5,59` → `truncateTail`; `core/tools/bash-output.ts:21` | `[Showing lines a-b of N (50KB limit). Full output: <tmp>]` |
| user `!` bash | 50 KB tail | `core/bash-executor.ts:139,166` | full output in a temp file |
| read | first 2000 lines / 50 KB | `core/tools/read.ts:160`; single huge line `:165`; continuation marker `:175`; spill `:177` (`core/tools/artifact-spill.ts`) | `Use offset=N to continue` |
| grep | 100 matches / 50 KB, 500 chars/line | `core/tools/grep.ts:288,300,305` | notice text |
| find | 1000 results / 50 KB | `core/tools/find.ts:144,274` | notice text |
| ls | 50 KB | `core/tools/ls.ts:135,145` | notice text |
| edit / write | bounded by their own input | `core/tools/edit.ts`, `write.ts` | — |
| **MCP** | **none** (only the 16 MiB JSON-RPC line limit, `core/mcp/protocol.ts:11`) | `core/mcp/tools.ts:79` `mapMcpContent` copies text/resource text as-is; `execute` `:135-146` returns it unchanged | — |
| extension tools | none | `core/tools/tool-definition-wrapper.ts` passes results through | — (out of scope, open question) |
| agent harness shell | 50 KB tail | `packages/agent/src/harness/utils/shell-output.ts:112` | — |

## Proposal
- In `createMcpToolDefinition.execute` (`core/mcp/tools.ts:135`), after `mapMcpContent`, cap the combined text
  blocks with the existing `truncateHead` (2000 lines / 50 KB, `DEFAULT_MAX_*`) and the same marker style as read/grep:
  `[Showing lines 1-K of N (50.0KB limit). MCP output truncated; full output: <spill path>]`. Write the full text with
  `spillTruncatedOutput` (adding a `kind: "mcp"` variant), so the model can `read` it with offset/limit.
- Text-block budgets are shared: once the cap is reached, later text blocks are dropped and counted in the marker.
  Images are untouched (they are already resized elsewhere). `details.structuredContent` is not sent to the model and
  stays as it is.
- `isError` results get the same cap.
- Head (not head+tail) to match read/grep. Head+tail is an open question.
- Small outputs (≤ both limits): no change, byte-identical content array.

## Success criteria (fixed before any measurement)
1. An MCP result over 50 KB or 2000 lines reaches the model at ≤ 50 KB of text plus one marker that uses the
   `truncate.ts` helper and marker format. Unit test.
2. Small MCP outputs (≤ limits, including multi-block, image and resource) give a content array that is
   byte-identical to `origin/main`. Golden test over a corpus of ≥ 20 recorded/synthetic results.
3. On the 061 scenario with a 400 KB MCP output (64k window, realistic-usage fake model that reports
   `usage.input` from the real prompt size, as in 061): **0** `OVERFLOW_RECOVERY_FAILED` hits and **0** overflow
   compactions, over 20 runs. On main, the same scenario hits the give-up limit (baseline recorded first).
4. No regression in task success on the Bench Analyst paired A/B (n=20, `paired_verdict.py --noreg`), and fewer
   context tokens per turn on the large-MCP tasks (CI high < 0).
5. Full coding-agent suite green; module-size ratchet unchanged or explicitly approved.
6. (added before measuring, Tech Lead 2026-10-17) Large MCP outputs whose failure message is at the end: the detection
   rate (the error text survives into what the model sees) with head+tail must be ≥ the rate with head-only.
   Test case "large MCP output with error at the end": head+tail keeps the error, and head-only is recorded as losing it.

## Open questions
- Default-off flag? The 1.4.4 rule says a behavior change goes behind a default-off flag (e.g.
  `OMK_MCP_OUTPUT_CAP=1`) unless Tech Lead waives it. Built-in tools already cap unconditionally, so this could
  count as a parity fix. **Tech Lead decision needed.**
- Head only, or head+tail (keep the end, like bash, for log-like MCP output)?
- Cap per call or per text block? Proposed: per call (combined).
- Spill file: always, or only when the cap is hit? Retention and cleanup of `omk-spill-*` dirs?
- Should the cap be configurable per server (`mcp.json` `max_output_bytes`)? Proposed: not in 1.4.4.
- Should the same cap later wrap extension tools (`tool-definition-wrapper.ts`)? Proposed: a follow-up spec.
- Are `structuredContent`-only results (empty `content`) rendered to the model anywhere? They currently become
  `(no content)` (`core/mcp/tools.ts:140`).

## Tech Lead decisions
- On by default (parity fix with the built-in tools). `OMK_MCP_OUTPUT_CAP=0` turns it off (rollback). MCP only;
  extension tools are unchanged.
- **Head+tail** (decision changed from head-only; Agent Researcher: Codex CLI `truncate.rs`, issue #6415, tail
  errors were lost). Keep the start and the end, cut the middle. The marker sits at the cut and states the total
  lines/bytes and how many were cut. `core/tools/truncate.ts` on main `0ce36329dc` has only `truncateHead` /
  `truncateTail` / `truncateLine` (no head+tail), so a new `truncateHeadTail` is added there, built from their limit
  logic. read/grep/bash are unchanged.
- Limits: the existing 2000 lines / 50KB total, split evenly between head and tail. The strategy is isolated in
  `truncateMcpText` (`core/mcp/output-cap.ts`).
- Spill: the full text goes to `<session>.artifacts/mcp-<toolCallId>.txt` next to the session `.jsonl` (dir 0700,
  file 0600). The marker shows the path relative to the tool cwd. Deleting the session removes the artifacts directory.
- No session file (`--no-session`, used by R8/workers): the full text goes to a temp file with the same directory,
  name convention and mode as bash's full output: `<tmpdir>/omk-mcp-<16 hex>.log`, 0600
  (`defaultTempFilePath`, `core/tools/output-accumulator.ts`). The marker holds that absolute path, so the model can
  `read` it. Like bash's temp files, omk never deletes it. Before this fix the marker said "Full output was not saved",
  and the Bench Analyst A/B failed `--noreg` (200KB mid-output fact 20/20 → 0/20).
- Structured-only results: unchanged (`(no content)`). Not covered.

## Results
See `bench/results/summary.md`. Tests:
- `test/spec066-mcp-output-cap.test.ts` (36): cap + marker, tail error kept / head-only loses
  it, single long line, multi-block + image, `truncateHeadTail` unit tests, no-session marker,
  `OMK_MCP_OUTPUT_CAP=0`, delete removes the spill, 22 golden small outputs.
- `test/spec066-mcp-overflow-scenario.test.ts` (2; `SPEC066_RUNS=20` for the 20-run check).
- `deleteSessionFile` moved from `session-selector.ts` to `core/session-artifacts.ts` (unchanged except artifact removal).
