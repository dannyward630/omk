# OMK 1.3.1

**Status: published on 2026-10-08.** The
[`v1.3.1` tag](https://github.com/dmae97/omk/tree/v1.3.1),
[GitHub Release](https://github.com/dmae97/omk/releases/tag/v1.3.1) and
[`open-multi-agent-kit@1.3.1`](https://www.npmjs.com/package/open-multi-agent-kit/v/1.3.1)
are available. All seven public workspace packages were published at 1.3.1;
newer releases have since advanced npm `latest`.

This patch aligned the workspace versions and internal dependency ranges for
fixes and compatible additions. The 1.3.0 changelog section remains unchanged.
The preparation record below preserves its original verification limits; it is
not a statement that 1.3.1 remains unpublished.

## Memory changes prepared on main

- Source-quote memory wrappers release closed controller/store references and
  skip closed predecessors while preserving error and cancellation ownership.
  A pre-aborted request does not start predecessor work.
- Each memory request prices static system-prompt and tool-schema text once.
  Complete message, synthetic tool-pair and final-input accounting remains.
- Source and private-record reads allocate their statted byte length plus one,
  rather than 256 KiB/16 KiB maximum buffers. Size, identity, ownership,
  symlink/hardlink and complete-source scans remain enforced. V2 selection does
  not tokenize records with no lexical match.
- TUI `/session` shows memory state and eligible/omitted counts, never source
  quotes or a semantic verification verdict. It does not enable memory.
- The offline factorial CLI provides independent/dependent and memory-off/on
  controls over actual reopened stores. Its 1,200 deterministic evaluations are
  mechanism checks, not LLM efficacy, measured KV use or process-heap evidence.

See [recall hardening](../packages/coding-agent/docs/memory-recall-hardening.md),
[lifecycle/pricing](../packages/coding-agent/docs/memory-lifecycle-optimization.md)
and [offline experiment](../packages/coding-agent/docs/memory-factorial-experiment.md).
At preparation time, other previously committed work since 1.3.0 remained in
the existing Unreleased changelog; the preparation did not incorporate other
sessions' dirty files.

## Verification recorded before publication

The memory/runtime candidate passed 292 focused tests, 150 WPL tests, whole-tree
type checking, the isolated build and `npm run check`. A separate coverage run
passed 102 tests with 98.23% line and 85.86% branch coverage in the four changed
memory modules. An owned built-TUI session exercised `/session` at 120/80/40
columns and exited normally. The actual local AdaptOrch MCP client/server checked
tool/capability parity, two topology controls and physical transport closure.
These are scoped checks, not production certification or remote orchestration.

Before publication, the full `./test.sh` attempt reached its 600-second bound.
Proxy tests timed out on both the unchanged base and candidate; verified-run
tests failed in both with varying individual failures. This evidence did not
establish that every failure was unrelated, and did not by itself authorize
publication. No security boundary, test assertion or release gate was bypassed
by that preparation change.

The publication links above supersede the preparation-only status. They do not
turn the timed-out local run into a passing full-suite result. The original
GitHub Release body still contains preparation wording; this file corrects the
repository record without rewriting the published tag or immutable Release.

The source version bump did not replace the installed launcher or an
already-running TUI. Restart after a separately verified runtime update.
