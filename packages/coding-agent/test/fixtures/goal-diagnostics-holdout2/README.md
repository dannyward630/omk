# Ground-truth labeling rule

`manifest.json` gives each fixture `groundTruthLine` (first) and `groundTruthLastLine` (last),
1-based on the sanitized text split on `\n` (trailing whitespace trimmed).

**Last line:** the last *real* error/failure line, not a summary or recap line.

- Build/target failure declaration lines (e.g. bazel `Target ... failed to build`,
  `FAILED: Build did NOT complete`) are summary lines.
- `Found N errors` count lines are summary lines.
- Code-snippet / caret (`^`) display lines are not error lines.
- Single-failure fixtures use last = first.

Full-display comparison (excerpt vs. whole fixture) is done after trimming trailing whitespace, same as the manifest line convention.
