# goal-diagnostics-holdout5

Blind holdout fixtures: genuine, unedited output from throwaway projects run with
jest, mocha, tsc, eslint, mypy, pyright, yamllint, markdownlint, stylelint, bats and htmlhint.
Only sanitization: absolute project paths rewritten to `/home/dev/proj/...`, trailing
whitespace trimmed, single trailing newline. No ANSI.

## Real error line
A line that states a failure itself: an assertion/exception message, each compiler or
type-checker diagnostic, an error-severity lint finding (including linters whose findings
carry no "error" word, e.g. stylelint `✖`, htmlhint `^` lines, bats `not ok`), or a
threshold-failure message. NOT: banners/headers, file-name group lines, stack frames,
code frames, got/expected detail, continuation lines, warnings, or final recaps/counts.

`groundTruthLine` is the first real error line, `groundTruthLastLine` the last one.

## Line convention
1-based indices into `content.split("\n")`. `linesBefore = groundTruthLine - 1`.
`sanitizedBytes`/`sanitizedLines` are measured on the stored file (lines exclude the final empty element).

## kind
a: >24 lines before the first real error; b: a non-error line matches /error|fail|exception/i;
c: the first real failure line has no such keyword; d: only the end-of-run summary shows failure.

## Declaration
작성 전과 작성 중 097 spec(specs/097-*), diagnostics 소스, PR #174, PR #175, 하네스 방 논의, 다른 holdout manifest를 보지 않았음
