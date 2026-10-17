# 066 results summary (head+tail)

Raw logs are archived at `/workspace/omk-bench-archive/066/` and not committed.

## 061 scenario with a 400KB MCP output (64k window, faux provider reporting realistic usage, 20 runs per arm)
`SPEC066_RUNS=20 SPEC066_PRINT=1 npx vitest run test/spec066-mcp-overflow-scenario.test.ts`

| tree / arm | give-up hits (`OVERFLOW_RECOVERY_FAILED`) | overflow compactions | prompt elapsed p50/p90/p95 ms | load1 |
|---|---|---|---|---|
| branch, default (cap on, head+tail) | **0 / 20 runs** | **0** | 21 / 23 / 27 | 10.18 (other agents' jobs) |
| branch, `OMK_MCP_OUTPUT_CAP=0` | 20 / 20 runs | 40 (2 per run) | 255 / 288 / 307 | 10.18 |
| main `0ce36329dc` | 20 / 20 runs | 40 (2 per run) | 257 / 332 / 345 | 3.70 |
| main `0ce36329dc`, env set (no effect on main) | 20 / 20 runs | 40 | 242 / 279 / 288 | 3.70 |

The gating numbers are counts, so load does not affect them. Elapsed times are only indicative.

## Criterion 6: error text at the end survives (`bench/tail-error.mjs`)
| case | head+tail (shipped) | head-only |
|---|---|---|
| log 400KB, error last line | yes | **no** |
| log 400KB, error + 30-line stack at end | yes | **no** |
| log 400KB, error + 1500 lines of trailing noise | **no** | **no** |
| json 400KB single line, error field last | yes | **no** |
| log 400KB, error at first line | yes | yes |
| log 400KB, error in the middle | **no** | **no** |

Detection rate: head+tail **4/6**, head-only **1/6** → criterion 6 (head+tail ≥ head-only) met. When the error sits
more than ~1000 lines / 25KB before the end, or in the middle, both strategies lose it. The model then has only the
spill-file path in the marker.

## No-session spill fix (after Bench Analyst `--noreg` failure)
- Regression test: in `--no-session`, a fact in the middle of a 200KB MCP output is recovered by `read` on the temp
  file named in the marker (`test/spec066-mcp-output-cap.test.ts`).
- 061 scenario rerun (the harness session is in-memory, so this exercises the temp-file path), 20 runs, load1 4.45:
  capped 0 give-ups / 0 overflow compactions (18/23/24 ms p50/p90/p95); `OMK_MCP_OUTPUT_CAP=0` 20/20 give-ups,
  40 compactions.
