---
description: "OMK_SKILL_SELECT=bm25|metacon으로 스킬 후보를 고르는 방식을 고른다. 꺼짐이 기본이고, 꺼지면 main과 같다. 모두 로컬에서만 돈다"
---

# Feature Specification: 스킬 선택 2단계 - 선택 방식 고르기 (bm25 / metacon)

**Specification ID**: `058-skill-select-modes`
**Feature Branch**: `docs/058-skill-select-modes` (문서만, origin/main `b60d3c4`에서 분기)
**Created**: 2026-10-11
**Status**: 구현 중(`feat/058-skill-select-modes`, #122 위). 범위 결정: 1.5.0은 `bm25|metacon`만 받는다. `wpl`은 Future, 아래 "범위 변경"
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: 인호 요청(1.5.0 하나로 묶어 낸다. 스킬 1,191개를 adaptorch wpl과 metacon으로 고르기). OMK가 맡는다.
**Depends on**: spec 050 구현 PR #121(R6)과 #122(`OMK_SKILL_SEARCH`, `skill_search`, BM25 인덱스), spec 042(`appendRunLog`), spec 049(`TodoKind`, `activeTodoKind()`. 선택 입력이고, 없으면 대체값을 쓴다).

## 범위 변경 (2026-10-11, OMK 결정)

처음 요청은 `bm25|wpl|metacon` 세 방식이었다. 코드를 읽어 보니 `omk-adaptorch-wpl`에는 스킬을 고르거나 순위를 매기는 함수가 없다(아래 "지금 코드가 하는 일"). 그래서 1.5.0에서는 `bm25`와 `metacon`만 받는다. `wpl`은 받지 않고, `metacon`의 별칭으로도 두지 않는다. `wpl` 방식은 먼저 `omk-adaptorch-wpl`에 로컬 순위 모듈이 있어야 하고, 그 모듈은 자기 spec과 근거가 필요하다(P2 규칙: 근거 없이 새 orchestration을 더하지 않는다). Future에 적는다.

## 지금 코드가 하는 일 (origin/main `b60d3c4`와 #121/#122, 경로는 `packages/coding-agent/src/` 기준)

- **#122(`OMK_SKILL_SEARCH`)**: 스킬이 24개를 넘고 `read` 도구가 있으면 system의 `<available_skills>` 목록을 고정 한 줄로 바꾸고, 고정 `skill_search` 도구를 하나 더한다. 순위는 `metacognition/retrieval.ts:31` `searchCorpus`(BM25)다. 작업 시작 때 후보 ≤3개를 `<skill_candidates>` 끝 메시지로 보낸다. 인덱스는 첫 사용 때 만들고 `<agentDir>/cache/skill-index-v1.json`에 캐시한다(`core/skill-search.ts`).
- **#121(R6)**: 첫 프롬프트의 스킬 선택을 system에 고정한다. 두 번째 프롬프트부터 다시 고른 스킬은 `<prompt_skills>` 끝 메시지로 보낸다(`core/prompt-skill-message.ts`). 가장 최근의 `<prompt_skills>`만 적용한다.
- **`metacognition/skills.ts:52` `planSkills(input: SkillPlanInput): SkillPlan`**(MIT, I/O 없음): 능력 커버리지로 스킬 집합을 고른다. 후보가 12개 이하면 정확 탐색(`runExactSearch`), 넘으면 greedy와 singleton 보정(`runGreedySearch`)이다(`metacognition/skill-search-space.ts`). 지금은 **제품 코드에서 부르는 곳이 없다**. 테스트(`test/metacognition-skills.test.ts`)만 있다.
  - 입력: `phase`(≤128자), `needs: {capability, weight(0~1e6), required}[]`(≤128), `catalog: SkillDescriptor[]`(**≤500**), `approvedHashes`(id→contentHash), `installedVersions`, `allowedPermissions`, `explicitSkills`(≤64), `tokenBudget`(≤1e7), `maxSkills`(≤64).
  - `SkillDescriptor`: `id`, `contentHash`, `capabilities`(≤128), `phases`(≤32), `tokenCost`, `dependencies`, `conflicts`, `permissions`, `explicitOnly`, `packages`.
  - 출력: `selected`(사전순), `tokenCost`, `covered`, `uncoveredRequired`, `blockedExplicit`, `rejected`(id→이유), `algorithm`(`exact-small|greedy-with-singleton`), `state`(`covered|capability-gap|explicit-blocked`).
  - 잘못된 입력에는 `ensure`가 예외를 던진다.
- **`packages/adaptorch-wpl`(`omk-adaptorch-wpl`, MIT)**: Work Packet Loop의 상태 기계(`state-machine.ts`의 `canTransition`, `applyTransition`, `isTerminalState`, `requiresHumanApproval`), 다음 전이 도우미(`loop.ts`의 `decideNextTransition`), Outcome Adjudicator, B2C 매핑, 영수증 서명, AdaptOrch 클라이언트를 담는다.
  - **이 패키지에는 스킬을 고르거나 순위를 매기는 함수가 없다**(`rg -i "skill|rank|select"`로 확인, `proof-projection.ts`의 무관한 문자열 하나뿐).
  - 기본 CLI에는 WPL 루프를 도는 코드가 없다(README "Integration": `loop.ts`는 end-to-end dispatcher가 아니다). 코딩 에이전트가 이 패키지를 import하는 곳은 `commands/adaptorch-doctor-cli.ts`와 opt-in 예시 확장 `examples/extensions/correctness-wall/`뿐이다.
  - `adaptorch-client.ts`, `adaptorch-api.ts`, `live-adaptorch-transport.ts`, `mcp-introspection-transport.ts`는 AdaptOrch 서비스(사유 제품)로 나가는 경로다. 058은 이것들을 쓰지 않는다.
- **049 `TodoKind`**: `plan | explore | edit | debug | verify`. `core/todo-state.ts`와 `todo-runtime-state.ts`의 `activeTodoKind()`로 읽는다. **origin/main에는 아직 없다.**

## 결정할 점 (OMK 제안)

- 선택 방식은 둘이다. 둘 다 #122의 고정 도구, 고정 system 줄, 끝 메시지 형식을 그대로 쓴다. 바뀌는 것은 `skill_search` 결과와 작업 시작 후보의 **순서와 구성**뿐이다. 그래서 캐시 안정성(050 AC 2)은 방식과 상관없다.
- 1.5.0의 기본값은 꺼짐이다. 어느 방식을 기본으로 할지는 Bench Analyst의 오프라인 평가(AC 7) 뒤에 정한다.

## Requirements

### R1 - 플래그와 동작 조건 (P0)

- `OMK_SKILL_SELECT=bm25|metacon`. 설정하지 않거나 빈 값이면 꺼짐이고, 요청은 main과 바이트 단위로 같다(AC 1).
- 대소문자를 가리지 않는다. 그 밖의 값(`wpl` 포함)은 꺼짐으로 본다. 프로세스당 한 번 stderr에 경고를 낸다(`OMK_SKILL_SELECT=<값>: unknown value, skill selection stays off (use bm25 or metacon).`, 다른 CLI 메시지처럼 영어다. 값은 앞 40자만 보인다). `OMK_RUN_LOG_DIR`가 있으면 `session` 레코드에 `invalidMode: true`를 남긴다(값 원문은 남기지 않는다). 경고 문구를 요청에 넣지 않으므로 요청은 꺼짐과 같다.
- `bm25`는 #122의 `OMK_SKILL_SEARCH=1`과 같다. 1.5.0에서는 `OMK_SKILL_SEARCH=1`을 `OMK_SKILL_SELECT=bm25`의 별칭으로 남긴다. 둘 다 있으면 `OMK_SKILL_SELECT`가 이긴다.
- 동작 조건은 050 R1과 같다. 시작 시점의 model-invocable 스킬이 24개를 넘고 `read` 도구가 있을 때만 켜진다. 그 밖에는 방식과 상관없이 비활성이고, 요청은 main과 같다.
- 방식은 세션 시작 때 한 번 정하고 세션 동안 바꾸지 않는다(도구 목록과 system이 고정이기 때문이다).

### R2 - 공통 순위 인터페이스 (P0)

- `core/skill-select-rankers.ts`(새 파일, 지연 로드)에 `rankSkills(mode, query, docs, options) → { hits, matchCount, metacon? }`를 둔다. `docs`는 인덱스 문서(`name`, `description`, `location`, `contentHash?`), `options`는 `{ limit, exclude?, explicit?, phase? }`다(`exclude`는 이 세션에서 이미 제안한 이름). `hits`는 `{ name, description, location, contentHash?, score, source }[]`이고 `score`는 두 방식 모두 BM25 점수다. `metacon`은 R7의 계획 통계를 함께 낸다.
- `skill_search` 도구와 작업 시작 후보(#122 `SkillSearchSession.search`, `suggest`)가 이 함수를 부른다. 결과 렌더(`name — description — location`, `<skill_candidates>`), 중복 제안 금지, 점수 하한은 #122 그대로다.
- **같은 내용 합치기**: `bm25`와 `metacon` 모두, `skill_search` 결과와 작업 시작 후보에서 `contentHash`(`loadSkills()`의 SKILL.md sha256)가 같은 스킬은 하나만 남긴다. 남기는 것은 순위가 가장 높은 것(같으면 이름순 앞)이다. 빠진 자리는 다음 순위의 다른 스킬로 채워 상위 k개를 서로 다른 스킬로 만든다. 바이트 단위로 같은 파일이 두 경로에 있을 때만 합쳐진다. `name:` 줄만 다른 복사본은 `contentHash`가 달라서 **합치지 않는다**(의도한 동작이다. 이름이 다르면 모델이 부르는 스킬도 다르다).
- `details`에 `mode`를, `candidates[{name, score, location}]`의 항목마다 `source`(`bm25|metacon|bm25-fill`, R4.4)를 더한다. 이후 TUI 카드가 어떤 방식이 어느 자리를 골랐는지 그릴 수 있게 하려는 것이다. TUI는 만들지 않는다.

### R3 - `bm25` (P0)

- #122 그대로다. `searchCorpus(query, corpus, limit)`, 문서는 `name + " " + description`, 작업 시작 질의는 불용어를 뺀 내용어다.

### R4 - `metacon` (P0)

`planSkills`는 catalog가 500개까지라 1,191개를 바로 넣을 수 없다. 그래서 BM25로 줄인 뒤 커버리지로 고른다.

1. **앞단 줄이기**: `searchCorpus`로 상위 `METACON_PREFILTER = 64`개를 뽑는다(점수 > 0). 없으면 빈 결과다.
2. **`SkillDescriptor` 만들기**(뽑힌 스킬마다, `loadSkills()` 결과만 쓴다):
   - `id` = 스킬 이름.
   - `contentHash` = `Skill.contentHash`(로더가 낸 sha256), 없으면 `sha256(name + "\n" + description)`.
   - `capabilities` = 이름과 설명의 내용어(`retrievalTokens`에서 길이 1과 불용어를 뺀 것, 중복 제거, 앞 128개).
   - `phases` = `["task", "plan", "explore", "edit", "debug", "verify"]`(스킬 frontmatter에 단계 정보가 없어서 모든 단계에 쓸 수 있다고 본다). 그래서 지금은 `planSkills`의 단계 필터(`phase-mismatch`)가 **아무것도 걸러 내지 않는다**. 049가 들어와도 결과는 같고, 단계 정보가 스킬에 생길 때 의미가 생긴다.
   - `tokenCost` = `ceil((compact 설명 길이 + 위치 길이) / 4)`. 후보 메시지에 실제로 싣는 크기다.
   - `dependencies`, `conflicts`, `permissions` = `[]`. `packages` = `{}`. `explicitOnly` = `disableModelInvocation`.
3. **`SkillPlanInput`**:
   - `phase` = 049 `activeTodoKind()`가 있으면 그 값, 없으면 `"task"`. 049가 main에 없는 동안은 늘 `"task"`다. 구현은 049를 import하지 않고 `SkillSearchSessionOptions.phase?: () => string | undefined` 연결점만 둔다(`TODO(049)`). 049가 들어오면 세션이 `() => activeTodoKind()`를 넘기고, 로그의 `phaseSource`가 `todo`로 바뀐다.
   - `needs` = 질의의 내용어. 먼저 중복을 없애고 그다음 앞 128개로 자른다(`planSkills`는 `needs`의 중복을 오류로 본다). 각 `weight`는 앞단에서 쓴 코퍼스 기준 IDF(최소 1), `required`는 모두 `false`다. 그래서 `state`는 `covered`나 `explicit-blocked`만 나온다.
   - `approvedHashes` = 지금 `loadSkills()` 결과의 `{이름: contentHash}`. `catalog`의 `contentHash`와 같은 출처라서 `unapproved-or-changed-content`로 빠지는 스킬은 없다. 인덱스 v2(인덱스에 contentHash 저장)는 만들지 않는다. SKILL.md가 바뀌면 #122의 지문(`fingerprintSkills`: 경로, 크기, mtime, inode)이 달라져 인덱스를 다시 만들기 때문에, 인덱스와 로드 결과가 어긋나는 경우가 없다.
   - `installedVersions` = `{}`, `allowedPermissions` = `[]`.
   - `explicitSkills` = 이번 프롬프트의 `!skill`·`/skill:` 이름 중 앞단 결과에 든 것. `defaultActiveSkills`는 넣지 않는다(구현: 이번 선택에서 기본 스킬을 뺀 이름, `explicitSkillNames`. 기본 스킬과 같은 이름을 명시해도 기본으로 본다).
   - `maxSkills` = 요청한 `limit`(후보는 3, 도구는 1..8). `tokenBudget` = `limit × 160`.
4. **출력과 채우기(제품 동작)**: `selected`를 BM25 점수 순으로 다시 정렬해 앞에 둔다. 점수가 같으면 이름순이다(`searchCorpus`와 같은 규칙). 점수는 BM25 점수다(커버리지 값은 로그에만 남긴다). `selected`가 `limit`보다 적으면 남은 자리를 BM25 순위로 채운다(같은 스킬과 같은 `contentHash`는 다시 넣지 않는다). `metacon`은 질의의 내용어를 덮는 **가장 작은 집합**(같은 커버리지면 `tokenCost`가 가장 작은 것)을 고른다. 내용어를 다 덮으면 더 고르지 않으므로(비용만 늘어난다) 보통 1~3개를 고르고, `limit=10`이면 대부분의 자리는 `bm25-fill`이다. 이것은 의도한 동작이고, 아래 출처별 채점(AC 7)이 이를 다룬다. 그래서 자리마다 출처를 남긴다. `metacon`이 고른 자리는 `source: "metacon"`, 채운 자리는 `source: "bm25-fill"`이다(`bm25` 방식은 모두 `source: "bm25"`). 출처는 도구 `details`, R7 로그, AC 7 내보내기에 함께 나가므로 Bench가 고른 자리와 채운 자리를 따로 채점할 수 있다. 작업 시작 후보(k=3)도 같은 규칙이고, 그 뒤에 #122의 점수 하한을 적용한다.
5. **실패**: `planSkills`가 예외를 던질 때만 그 호출에 `bm25` 결과를 쓰고 `fallback: "metacon-error"`를 남긴다. 세션의 방식은 바꾸지 않는다.
6. **시간 예산**: `planSkills`는 동기 함수라 도중에 끊을 수 없다. 또 부하에 따라 물러나면 같은 질의의 결과가 실행마다 달라져 비교(AC 7)가 흔들린다. 그래서 50 ms는 **끊는 기준이 아니라 기록하는 예산**이다. 걸린 시간을 `planMs`로 남기고, 넘으면 `overBudget: true`를 더한다. 결과는 그대로 쓴다. 지키는 것은 AC 2의 p99 기준이다.

기대 효과: BM25 상위 3개가 같은 단어에 몰린 비슷한 스킬로 채워지는 경우, 커버리지 선택은 질의의 다른 단어를 덮는 스킬을 섞는다. 이것이 bm25와 다른 점이고, 오프라인 평가(AC 7)에서 볼 점이다.

읽을 때 주의할 점: greedy 선택은 같은 커버리지라면 `tokenCost`가 작은 스킬, 곧 **설명이 짧은 스킬**을 고르는 쪽으로 기운다. `metacon`이 짧은 설명의 스킬을 자주 고르면 이 치우침 때문일 수 있으므로, 평가 결과를 읽을 때 고른 스킬의 설명 길이 분포를 함께 본다.

### R5 - 캐시 안정성 (P0, 050 R6 유지)

- 050 R6을 그대로 둔다. 첫 프롬프트의 선택(harness, `!skill`, budget 질의)은 system에 고정하고, 이후 다시 고른 스킬은 `<prompt_skills>` 끝 메시지로 보낸다. 가장 최근의 `<prompt_skills>`만 적용한다.
- 방식은 고정 도구의 **결과**와 끝 메시지의 **내용**만 바꾼다. system 바이트, tools 바이트, 앞 메시지는 세션 동안 같다(050 AC 2를 방식마다 돈다, AC 3).

### R6 - worker (P0)

- worker는 `OMK_SKILL_SELECT`를 물려받는다. `OMK_SKILL_SEARCH_SUGGEST=0`이 붙으므로(#122) 자동 후보는 없고, `skill_search`를 부를 때만 순위를 매긴다.

### R7 - run log (P0, spec 042)

`OMK_RUN_LOG_DIR`가 있을 때만 `skill-select.jsonl`에 남긴다. **해시와 숫자만** 남기고, 질의, 스킬 이름, 경로 원문은 남기지 않는다(050 AC 7과 같은 방법으로 확인).

- 모든 `search`·`suggest` 레코드에 `mode`, `candidateCount`(BM25 점수가 0보다 큰 서로 다른 스킬 수, 최대 64), `top[{ nameHash, score, source }]`(돌려준 상위 k개, `nameHash`는 sha256 앞 12자, `score`는 소수 셋째 자리, `source`는 R4.4), `latencyMs`를 더한다. #122의 `ms`는 `latencyMs`로 바꾼다.
- `metacon`은 `prefilter`(앞단 결과 수), `algorithm`, `state`, `coveredNeeds`, `needs`, `rejected`(이유별 개수), `phase`, `phaseSource`(`todo|default`), `planMs`, `overBudget?`, `fallback?`를 더한다.
- `read.suggested`(제안한 스킬을 모델이 실제로 읽은 비율)는 050 R8의 `read` 레코드가 생기면 **보조 신호로만** 남긴다. 판정 지표가 아니다(AC 7).
- `session` 레코드에 `mode`(`off|bm25|metacon`)와 `invalidMode?`를 더한다.
- `session` 레코드의 `inactiveReason`은 `flag_off|few_skills|no_read_tool|name_conflict|tool_inactive|none`이다(050 R8 목록에 `name_conflict`와 `tool_inactive`를 더한다).
- **`tool_inactive`(#122 병합 후속)**: 허용 목록(`allowedToolNames`), 로드아웃, 확장의 `setActiveTools`가 `skill_search`를 활성 도구에서 빼면 그 세션은 꺼짐으로 바뀌고 계속 꺼짐이다. system은 `<available_skills>`로 돌아가고 후보 메시지는 보내지 않는다. 모델이 부를 수 없는 도구를 가리키는 후보가 나가지 않게 하려는 것이다. 판정은 system을 다시 만들 때(`_rebuildSystemPrompt`) 활성 도구 이름으로 한다.
- **로그 실패는 프롬프트를 깨지 않는다(#122 병합 후속, 필수)**: `session` 레코드를 만드는 동안 `omk-ai/prompt-hash` import, 해시 계산, 쓰기 중 무엇이 실패해도 레코드만 버리고 프롬프트는 그대로 진행한다. 플래그가 꺼져도 켜져도 같다.

### R8 - 지연 로드 (P0)

- 꺼짐과 비활성에서는 `skill-select-rankers.ts`, `skill-search.ts`, `metacognition/skills.ts`를 하나도 로드하지 않는다. 어느 방식도 `omk-adaptorch-wpl`을 import하지 않는다.
- 켜진 세션에서도 첫 검색이나 첫 작업 시작 후보 때 로드한다. 시작 경로에 넣지 않는다.

## Acceptance

- **AC 1 (꺼짐 동일성)**: `OMK_SKILL_SELECT`를 설정하지 않은 `-p` 요청이 main과 바이트 단위로 같다. 050 AC 11의 6케이스(default, xai, budget, bang, xaibang, xaibudget)를 같은 mock 캡처로 돈다. 두 방식 각각을 스킬 24개 이하로 켠 경우(비활성)와 `OMK_SKILL_SELECT=wpl`(알 수 없는 값)도 같아야 한다. 측정은 `OMK_TRUST_PROJECT=0`, 위에 AGENTS.md·CLAUDE.md가 없는 cwd에서 하고 그 조건을 기록한다.
- **AC 2 (방식별 단위 테스트, 고정 fixture)**: `test/fixtures/skill-select/`의 고정 카탈로그(합성 40개, 이름·설명 고정)와 고정 질의 5개로:
  - `bm25`: 상위 k 이름과 점수가 기대값과 같다.
  - `metacon`: 같은 단어에 몰린 비슷한 스킬 3개가 있는 질의에서, BM25 상위 3개와 달리 질의의 다른 내용어를 덮는 스킬이 들어간다. 같은 입력은 같은 출력을 낸다. 점수가 같으면 이름순이다. `planSkills` 예외에서만 bm25로 물러난다(느린 호출은 결과를 그대로 쓰고 `overBudget`만 남긴다). `needs`에 같은 단어가 여러 번 있어도 오류가 나지 않는다.
  - `metacon` 시간: 합성 1,191개와 고정 질의로 `planSkills` 호출(앞단 BM25 포함, 모듈 로드 시간 제외)의 p99가 50 ms 미만이다.
  - 같은 내용 합치기(두 방식 모두): 바이트 단위로 같은 SKILL.md를 두 경로에 두면 결과에 한 번만 나오고, 상위 k개는 서로 다른 스킬로 채워진다. `name:` 줄만 다른 복사본 둘은 둘 다 나온다.
  - 알 수 없는 값(`wpl`, `foo`)은 꺼짐이고, 경고는 프로세스당 한 번이다.
- **AC 3 (캐시 안정성)**: 050 AC 2 테스트(task 2개, `skill_search`, `/reload`)를 방식마다 돈다. 모든 호출의 `systemHash`·`toolsHash`가 첫 호출과 같고 앞 메시지가 유지된다.
- **AC 4 (시작 시간과 RSS)**: 합성 1,191개에서 쌍 측정을 하고 `paired_verdict.py --block startup_ms=5 --block idle_rss_mib=5`로 판정한다. 비교는 (a) 꺼짐 대 main, (b) 방식마다 켬 대 꺼짐이다. 명확한 회귀(BLOCK)가 없어야 한다. 측정은 박스 순서에 따라 슬롯을 받아 하고, `OMK_TRUST_PROJECT=0`과 cwd 조건을 기록한다.
- **AC 5 (log에 원문 없음)**: 고유 문자열을 질의와 스킬 설명에 심고, 방식마다 `skill-select.jsonl` 전체에 그 문자열, 스킬 이름, 경로가 없음을 확인한다.
- **AC 6 (로컬 전용)**: 방식마다 테스트에서 `fetch`, `net.connect`, `child_process` 호출 수를 세어 0이어야 한다. 정적 검사로 `skill-select-rankers.ts`와 `skill-search.ts`가 `omk-adaptorch-wpl`과 `core/adaptorch-bridge.ts`를 import하지 않음을 확인한다.
- **AC 7 (오프라인 품질 평가, Bench Analyst 판정)**: 모델 호출 없이, $0으로 `bm25`와 `metacon`의 순위 품질을 비교한다.
  - **코퍼스**:
    - 주 조건은 박스의 실제 스킬을 **본문 기준**으로 중복 없이 모은 247개다. 박스의 `/workspace/omk-skill-baseline/env/s1191`(1,191개)은 실제 스킬을 4~5번씩 복사하고 `name:` 줄만 바꾼 합성 세트다. `name:` 줄을 뺀 본문이 서로 다른 것이 247개다(OMK 확인, 2026-10-11). 이름에서 `-N`을 떼어 묶으면 241개지만, 그중 6개 이름은 본문이 다른 변형을 갖는다.
    - 본문 기준으로 묶는 이유(Tech Lead 결정, 2026-10-11): 이름이 같아도 본문이 다르면 검색 결과에서는 다른 스킬이다. 제품의 중복 제거(위 "같은 내용 합치기")도 `contentHash` 기준이다. 그래서 판정 단위를 제품 동작과 맞춘다.
    - 1,191개 조건은 보조다. 같은 본문 묶음(`name:` 줄을 뺀 본문)의 복사본 중 어느 것이 나와도 맞힌 것으로 센다. 상위 3개에 서로 다른 묶음이 몇 개인지도 함께 보고한다. 1,191개 파일은 `name:` 줄 때문에 전부 `contentHash`가 달라서, 제품의 "같은 내용 합치기"로 합쳐지는 것은 없다.
  - **질의 50개**: Bench Analyst가 이 평가를 위해 새로 쓴 개발 작업 문장이다(예: "Fix the TypeScript type errors that appeared after upgrading a dependency"). R8 실행의 task 지시문이나 todo 문장을 뽑아 가린 것이 아니다.
  - **한계**: 질의는 스킬 설명을 읽으면서 쓴 것이라 설명과 같은 단어를 쓰기 쉽다. 이것은 단어가 겹칠수록 점수가 오르는 `bm25`에 유리할 수 있다. 그래서 `metacon`이 비기거나 지는 결과는 이 치우침을 함께 적어 읽는다.
  - **정답**: 질의마다 0~3개의 정답 스킬을 **두 방식의 출력을 보기 전에** 정한다. Bench Analyst가 질의와 정답 초안을 만들고 OMK가 정답을 검토한다.
  - **고정된 정답(2026-10-11)**: `/workspace/omk-bench-analyst/skill058/labels_final.tsv`(sha256 `21c6938adec603ade2a0e6280f1479d351f46258bdf544f788c4b8f03fbd6380`). 50개 질의 중 정답이 있는 것이 46개, 없는 것이 4개다. 코퍼스는 같은 폴더의 `corpus247.json`(sha256 `5691f7e11d48569e5fdccaaf245f5396e4a8c942dcc8b5ea50004f035d14404f`)이다. OMK 검토 변경 3건은 `label_review_omk.md`에 있다. 평가는 이 해시의 파일로만 하고, 바꾸려면 새 해시를 이 spec에 적는다.
  - **지표**: 정답이 1개 이상인 질의에서 hit@3과 MRR을 낸다. 같은 질의에서 두 방식을 짝지어(paired) 비교하고, sign test와 bootstrap CI를 낸다. 정답이 0개인 질의는 hit@k에서 빼고, 점수 하한을 넘는 후보를 낸 비율(엉뚱한 제안 비율)로 따로 보고한다.
  - **판정**: `metacon`은 주 조건에서 hit@3이 CI로 분명히 나을 때만 "효과 있음"이다. 그렇지 않으면 `bm25`가 기본값 후보로 남는다.
  - **내보내기(Tech Lead 결정, 2026-10-11)**: `skill_search` 도구 경로(`SkillSearchSession.search`)를 쓴다. 질의는 원문 그대로(작업 시작 후보처럼 불용어를 빼지 않는다), 두 방식 모두 `limit=10`이다. 작업 시작 후보 경로(k=3, 점수 하한)는 평가하지 않는다. 명령: `npx tsx packages/coding-agent/scripts/skill-select-eval.ts --labels <labels_final.tsv> --corpus <corpus247.json> --skills /workspace/omk-skill-baseline/env/s1191/agent/skills --out <dir> --limit 10`. 제품 경로(`loadSkillsFromDir` → `SkillSearchSession.search`, 곧 `skill_search` 도구 본문)를 두 방식 모두 `limit=10`으로 돌려 `bm25.tsv`와 `metacon.tsv`를 쓴다. 형식은 Bench Analyst `score058.py`를 따른다. 첫 줄은 내보낸 커밋을 적는 주석 `# commit <짧은 SHA>`(`#` 줄은 채점에서 건너뛴다)이고, 그다음 `bm25.tsv`는 `qid<TAB>rank<TAB>skill_dir`, `metacon.tsv`는 여기에 `source`(`metacon|bm25-fill`) 열을 더한다. `skill_dir`는 코퍼스 폴더 이름만 쓴다(`a11y-debugging-2`; 절대 경로나 `/SKILL.md` 없음). 각 스킬에 `corpus247.json`의 본문 해시를 `contentHash`로 주어 R2 합치기가 같은 본문 사본을 한 번만 내므로 질의마다 서로 다른 본문 최대 10개가 나온다. 코퍼스에 없는 폴더가 있으면 내보내기를 멈춘다. SHA는 `git rev-parse --short=7 HEAD`이고, `packages/coding-agent/src`에 커밋하지 않은 변경이 있으면 내보내지 않는다. `metacon.tsv`는 058 head에서, `bm25.tsv`는 같은 실행에서 함께 낸다. 인덱스 캐시는 새 임시 agent 디렉터리에 쓰고 지우므로 스킬 디렉터리는 건드리지 않는다. 모델 호출과 네트워크는 없다.
  - **골든 스냅숏**: AC 2의 고정 fixture 기대값(`test/__snapshots__/skill-select-rankers.test.ts.snap`)은 손으로 계산하지 않고 첫 실행에서 기록한 뒤 사람이 검토해 커밋한다. 구현 PR 본문에 그렇게 적는다.
  - **출처별 채점**: `metacon.tsv`의 `source`로 `metacon`이 고른 자리와 `bm25-fill` 자리를 나눠 hit을 따로 보고한다(R4.4). 고른 자리가 적고 대부분 채운 자리라면 두 방식의 차이는 작을 수밖에 없다.
  - `read.suggested`는 판정에 쓰지 않는다. R8에서는 265개 실행 중 6개만 스킬을 읽었고(읽기 11회), 이 값은 순위 품질이 아니라 모델이 제안을 따르는지를 잰다.
  - 번들 6개는 동작 문턱(24개) 아래라 두 방식 모두 비활성이다. 그래서 TB A/B를 하더라도 스킬이 많은 조건(예: 1,191개 세트)이 필요하다. TB A/B는 오프라인 평가를 통과한 방식만, 그 뒤에 한다.
  - **범위**: 결과는 합성 코퍼스 기준이다. 인호의 실제 1,191개는 박스에 없다. 실제 세트와 다를 수 있으므로 1.5.0 릴리스 노트에는 "합성 코퍼스 기준"이라고 적는다.
  - 1.5.0에서 기본값은 꺼짐이고, 어느 방식도 기본으로 켜지 않는다.

## 결과 (AC 7 오프라인 평가, 2026-10-11)

**판정: NOISE.** 기본은 `bm25`로 두고 `metacon`은 opt-in으로 남긴다. 판정은 Bench Analyst가 했다. 아래 표는 Bench Analyst의 표를 그대로 옮겼다.

| 범위 | 지표 | bm25 | metacon | 차이 | 95% CI | 나음/나쁨 |
|---|---|---|---|---|---|---|
| 46개 전체(정답 있는 질의) | hit@3 | 0.783 | 0.804 | +0.022 | −0.043..+0.109 | 2/1 |
| 46개 전체 | MRR | 0.791 | 0.777 | −0.014 | −0.057..+0.013 | 2/3 |
| 42개(Q06, Q24, Q25, Q29 제외) | hit@3 | 0.762 | 0.786 | +0.024 | −0.048..+0.095 | 2/1 |
| 42개 | MRR | 0.783 | 0.767 | −0.016 | −0.064..+0.015 | 2/3 |

- 부호 검정 p = 1.0.
- 50개 질의 중 top 3 집합이 두 방식에서 같은 것은 7개뿐이다. hit@3이 다른 질의는 3개다.
- metacon top 3 칸 138개 중 `bm25-fill`이 11개다. fill로만 정답을 맞힌 질의는 0개다.
- 입력:
  - 내보낸 커밋 `35b3f74`
  - `labels_final.tsv` sha256 `21c6938a…`
  - `corpus247.json` sha256 `5691f7e1…`
  - `bm25.tsv` sha256 `4459fc5e…701f`
  - `metacon.tsv` sha256 `154c9ed4…2b32e`
- 한계:
  - 질의 50개는 Bench Analyst가 썼으므로 bm25 어휘 쪽으로 기울었을 수 있다. 그래서 이 결과가 보여 주는 것은 "바꿀 이유가 없다"이지 "metacon이 더 나쁘다"가 아니다.
  - 1,191개 조건 2차 평가는 돌리지 않았다.
- 새 질의 집합으로 다시 판정하기 전까지 metacon을 기본으로 바꾸지 않는다.

## 알려진 위험

- 정답이 없는 질의에서도 두 방식 모두 후보를 낸다(정답 없는 4개 질의 모두 4/4). 둘 다 "해당 없음"이라고 말하지 못한다. 점수 하한을 두는 것은 이 spec의 범위 밖이다.

## Non-goals

- **Adaptorch-MCP 서버나 AdaptOrch API를 부르는 것.** AdaptOrch는 사유 제품이고 근빈의 승인이 필요하다. 058의 모든 방식은 로컬 순수 함수만 쓴다. `adaptorch-client.ts`, `adaptorch-api.ts`, live/MCP transport, `core/adaptorch-bridge.ts`는 쓰지 않는다.
- 1.5.0에서 어느 방식이든 기본으로 켜는 것.
- 학습형 선택, 임베딩, 모델 호출로 고르기.
- `wpl` 방식(1.5.0). `omk-adaptorch-wpl`에 스킬 순위 함수가 없어서다. 알 수 없는 값으로 다루고 `metacon`의 별칭으로도 두지 않는다. 아래 Future.
- WPL 루프를 기본 CLI에 연결하는 것, packet 상태 변화를 후보 트리거로 쓰는 것.
- 스킬 frontmatter에 capabilities·phases 같은 새 필드를 더하는 것.
- 실제 스킬 디렉터리 정리나 수정. 테스트와 측정은 복사본이나 합성 세트만 쓴다.
- TUI 카드 구현.
- Perf Engineer 소유 파일(`core/skills.ts`, `core/package-manager.ts`, `resource-loader.ts`의 스킬 경로 코드) 수정. `loadSkills()` 결과만 쓴다.

## Future

- **`wpl` 방식**: 먼저 `omk-adaptorch-wpl`에 로컬 순수 순위 모듈(I/O와 네트워크 없음)을 만들어야 한다. 그 모듈은 자기 spec과 근거(AC 7과 같은 오프라인 평가에서 `bm25`·`metacon` 대비 결과)가 필요하다(P2 규칙). 초안 때 검토한 안은 Work Packet 상태(`WorkPacketState`)를 단계로 바꿔 `metacon`의 `phase`에 넣는 것이었다. 기본 CLI에는 WPL 루프가 없어서 그 안은 `metacon`과 결과가 같았고, 그래서 1.5.0에서 뺐다.

## 정할 질문

1. `metacon`의 `METACON_PREFILTER`(64)와 `tokenBudget`(`limit × 160`)은 AC 2 fixture와 1,191개 측정으로 맞춘다. 오프라인 평가(AC 7) 전에 바꿀 수 있고, 평가 중에는 고정한다.
2. ~~049가 1.5.0에 들어가지 않으면 `phase`는 늘 `"task"`다~~: 정했어요. 스킬에 단계 정보가 없어서 지금은 단계 필터가 아무것도 걸러 내지 않으므로, 049가 있든 없든 결과가 같다(R4).

## Expected Files (구현 PR)

- `packages/coding-agent/src/core/skill-select-mode.ts` 또는 #122의 `skill-search-mode.ts` 확장: `OMK_SKILL_SELECT` 해석, 별칭, 활성 판정
- `packages/coding-agent/src/core/skill-select-rankers.ts`(새 파일, 지연 로드): `rankSkills`, `metacon` 어댑터(`SkillDescriptor`·`SkillPlanInput` 만들기)
- `packages/coding-agent/src/core/skill-search.ts`(#122): 순위를 `rankSkills`로 바꾸고 R7 필드 추가
- `packages/coding-agent/src/core/tools/skill-search-tool.ts`(#122): `details.mode`
- `packages/coding-agent/src/core/skill-index-store.ts`(새 파일): #122의 인덱스 파일 읽기·쓰기와 지문을 `skill-search.ts`에서 떼어 낸 것(모듈 크기 250줄 안)
- `packages/coding-agent/src/core/prompt-skill-message.ts`(#121/#122): 세션 방식 전달, `session` 레코드의 `mode`·`invalidMode`
- `packages/coding-agent/scripts/skill-select-eval.ts`: AC 7 내보내기
- 테스트: `test/skill-select-rankers.test.ts`, `test/fixtures/skill-select/catalog.json`(합성 40개, 질의 5개)과 그 스냅숏, `test/skill-search.test.ts`(방식 해석, 세션 출처·로그), `test/suite/skill-search-session.test.ts`(방식별 반복), `test/suite/skill-search-log-failure.test.ts`(로그 실패), `test/prompt-skill-message.test.ts`(`tool_inactive`, 로그 실패), `test/skill-search-flag-off-cold-path.test.ts`(방식별 미로드), `test/skill-select-eval-export.test.ts`, `examples/extensions/subagent/worker-env.test.ts`
- 문서: `docs/skills.md`, `docs/environment-variables.md`
