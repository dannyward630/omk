# Spec 070: measure request-prefix stability (offline cache-hit proxy) (1.4.4)

Status: **spec only, criteria approved by Tech Lead (2026-10-17)**, measurement only, no product behaviour change. Base: origin/main `fd495fd77b`.
Spec number: 066-069 are taken by local branches; 070 is free in all worktrees and branches.

## Problem
Provider prompt caches (Anthropic `cache_control`, OpenAI automatic prefix cache) only reuse an **exact byte prefix** of the previous
request. omk already places cache breakpoints (`packages/ai/src/providers/anthropic.ts:1240-1326`) and keeps the system-prompt boundary
stable (spec 052, `core/system-prompt-cache-boundary.ts`), but nothing measures how much of each request actually repeats the last one.
The mock provider does not simulate caching, and real-model runs (`cached_tokens`) are on hold pending 인호's cost approval.
`core/request-trace.ts` records usage only, never payloads, so it cannot answer this either.

## Metric (Tech Lead, 2026-10-17)
For each run, for consecutive model requests i-1 → i (same run, kind != summary):
- `prefix_keep_i = first_diff_byte(body_{i-1}, body_i) / len(body_i)`, computed on the **provider-shaped request body** the mock receives
  (canonical JSON as sent, no re-serialisation).
- **Primary:** `prefix_keep_run` = token-weighted mean over the run (weights = prompt tokens of request i).
  **Secondary:** per-turn median of `prefix_keep_i`, reported next to it. Report also the **first diff location**
  as a JSON path (`system`, `tools[3].description`, `messages[7].content[0]`, …) so each break has a cause.
- Upper bound only: real cache reuse is ≤ this (breakpoint placement, TTL, minimum cache size).

## Phase 1 (this spec): baseline on current main, harness-side only
- Bench Analyst's mock records, per request: run id, sequence, body length, sha256, and the first-diff byte and JSON path versus the
  previous body of the same run. Bodies are kept only in the private run dir (0600), never committed (they can contain file contents).
- No omk source change. Scenarios: the 066 run2 set (7 scenarios) plus one multi-turn edit task (read → edit → bash test → edit)
  and one **long session (> 30 turns) that triggers at least one compaction** (fake model reports realistic usage = prompt size),
  20 runs each, Node >=22.19, `OMK_TRUST_PROJECT=0`, load1 logged, equal-length build dirs.
- Output: per-scenario median `prefix_keep_run`, and a table of break causes (JSON path → count, bytes lost).

## Phase 1 success criteria (fixed before measuring)
1. Tool works: on a synthetic run where only one appended user message differs, `prefix_keep` = (len(old) − k)/len(new) exactly
   (unit test). `k` is computed from the old body itself: byte length from immediately after the end of the last element of
   `messages` to the end of the body (never hardcoded, e.g. as 2 bytes `]}`; providers can append keys such as `tools` or `stream`
   after `messages`, making k larger). The unit test covers (a) a body where `messages` is the last key and (b) a body with other keys
   after `messages`; in both the value matches exactly and the first diff path is `messages[n]` (n = index of the appended message).
   In (b) the bytes after `messages` counted as lost each turn are a real loss the metric should measure; the results table shows
   this tail loss (k) as a separate column.
   Note: corrected before any measurement (Tech Lead, 2026-10-17); a typo fix (old wording could never pass), not a relaxation.
2. Determinism: two runs of the same scenario on the same build give identical break-cause tables.
3. Every break with > 1% of request bytes lost is attributed to a JSON path (no "unknown").
Phase 1 claims nothing about cost. It produces the list of candidate fixes; each fix becomes its own spec with its own fixed target
(for example "break cause X removed; `prefix_keep_run` median +N points; no success regression"), behind a default-off flag.

## Suspected break causes to check (not assumed)
- Compaction rewriting history (expected and unavoidable; counted separately).
- Dynamic system-prompt sections after the boundary (date is day-granular, `core/system-prompt.ts:76-80`; cwd; skills; memory).
- Tool list or tool description order changing between turns (`core/prompt-tool-projection.ts`).
- Re-truncation or re-rendering of earlier tool results (066 markers, budget governor `core/context-budget-*`).

## Phase 2 (later, needs 인호's approval)
Confirm the proxy against real `cacheRead` on a small real-provider run: report run count and estimated cost first.

## Decisions (Tech Lead, 2026-10-17)
Long session (> 30 turns, with compaction) included; primary metric token-weighted mean, turn median secondary. No open questions remain.
