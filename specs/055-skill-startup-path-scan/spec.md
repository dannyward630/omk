---
description: "스킬이 많을 때 시작 비용 줄이기: 스킬 경로 realpath를 한 번만 하고, 스킬 폴더의 ignore 파일은 이미 읽은 readdir 결과로 찾는다 (동작은 main과 같음)"
---

# Feature Specification: 스킬 시작 비용 (realpath 한 번, readdir로 ignore 파일 찾기)

**Specification ID**: `055-skill-startup-path-scan`
**Feature Branch**: `perf/skill-startup-055` (origin/main `f913f49`에서 분기)
**Created**: 2026-10-11
**Status**: 구현됨, 측정 전 (Perf Engineer)
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Perf Engineer의 CPU 프로파일(`/workspace/omk-perf-skillprof-run/runs/20261011-132325-pr9ad9aa28/REPORT.md`, 저장소 밖). 범위는 Tech Lead가 정했다.

## 문제

스킬 1,191개(합성 세트 `/workspace/omk-skill-baseline/env/s1191`)로 `-p` 시작을 프로파일하면, #119 warm 캐시를 써도 첫 요청 전에 스킬 관련 일이 남는다. 아래 ms는 모두 **`--cpu-prof` 오버헤드를 포함한 CPU 프로파일 추정치**다. 벽시계 측정이 아니다(10회, 짝 없음).

- **realpath 3번, 약 51–53 ms.** 같은 스킬 경로를 세 단계가 각자 `canonicalizePath`(JS `realpathSync`, 경로 성분마다 `lstat`)로 다시 푼다.
  - `core/package-manager.ts` `toResolvedPaths` → `mapToResolved` 중복 제거, 약 19 ms
  - `core/resource-loader.ts` `mergePaths`, 약 15 ms
  - `core/skills.ts` `loadSkills` → `addSkills` 중복 제거, 약 16 ms
- **스킬 폴더 걷기, 약 43–45 ms.** `collectSkillEntries`(`core/package-manager.ts`)가 폴더마다 `readdir`을 하고, 그 앞에서 `.gitignore`·`.ignore`·`.fdignore`가 있는지 `existsSync`로 세 번 따로 묻는다(`addIgnoreRules`, 약 9–15 ms).

## 범위

### 1. realpath는 한 번만

- `realpathSync.native`로 바꾸지 **않는다**. Windows와 마운트에서 결과가 다를 수 있고, 그러면 심볼릭 링크 중복 제거 결과가 바뀐다.
- 대신 한 번의 `reload` 안에서 푼 canonical 경로를 다음 단계로 넘긴다. `CanonicalPathMemo`(입력 경로 문자열 → `canonicalizePath` 결과)를 `reload`가 만들고, `packageManager.resolve()`가 채우고, `mergePaths`와 `loadSkills`가 그대로 쓴다.
- 키는 `canonicalizePath`에 넘기던 **정확한 문자열**이다. 값은 같은 함수가 같은 입력에 낸 결과다. 그래서 모든 `seen`/`realPathSet` 비교와 `compareSkillCandidates` 정렬에 들어가는 문자열이 main과 같다. 키가 맞지 않으면 예전처럼 그 자리에서 푼다.
- memo는 `reload` 한 번 동안만 산다. `extendResources` 같은 뒤의 호출에는 넘기지 않는다(그 사이 파일이 바뀌었을 수 있다).
- `ResolvedResource`에는 필드를 더하지 않는다(패키지 inspect 출력이 바뀌지 않게).

### 2. 폴더 걷기: ignore 파일은 readdir 결과에서 찾기

- `collectSkillEntries`만 바꾼다. 먼저 `readdir`을 하고, 그 목록에 이름이 있는 ignore 파일만 읽는다. 목록에 없으면 `existsSync`를 하지 않는다.
- 같은 동작을 지키는 규칙:
  - 목록에 정확히 같은 이름이 있으면 읽는다. 깨진 링크나 디렉터리면 `readFileSync`가 던지고, 지금처럼 삼킨다(`existsSync`가 false였던 경우와 결과가 같다).
  - 대소문자만 다른 이름(`.GitIgnore`)이 있으면 예전처럼 `existsSync`로 묻는다. 대소문자를 구분하지 않는 파일 시스템(macOS, Windows)에서 결과가 같게 하려는 것이다.
  - `readdir`이 실패하면 예전처럼 `existsSync`로 규칙을 더한 뒤 빈 목록을 돌려준다.
- 다른 걷기(`collectFiles`, 프롬프트·테마·확장)는 그대로 둔다.
- ignore 헬퍼(`IGNORE_FILE_NAMES`, `prefixIgnorePattern`, `addIgnoreRules`)는 새 모듈 `core/ignore-rules.ts`로 옮긴다. `package-manager.ts`가 모듈 크기 한도(2289/2289)에 있어서다. 동작은 바꾸지 않고 옮기기만 한다.

## 범위 밖

- 3번 후보: 스킬 설명 압축 캐시와 토큰 추정 memo. 미룬다.
- 디렉터리 mtime 기반 걷기 캐시. 하지 않는다.
- `realpathSync.native`. 하지 않는다.
- 파일 소유: `skills-prompt.ts`, `system-prompt.ts`, `session-system-prompt.ts`, `agent-session.ts`, context-budget 파일은 OMK의 050 소관이라 건드리지 않는다. Perf는 `package-manager.ts`, `resource-loader.ts`의 `mergePaths`와 스킬 경로 코드, `core/skills.ts`의 realpath·걷기 부분을 맡는다. `core/skills.ts`는 모듈 크기 한도(521)라 늘리지 않는다(+1줄 이내).

## 수락 기준 (AC)

1. **동작이 같다.** `loadSkills`와 `DefaultResourceLoader.getSkills()` 결과(진단 포함)가 main과 같다.
   - 번들 6개 세트, 합성 1,191개 세트(`/workspace/omk-skill-baseline/env/s1191/agent/skills`). 두 빌드의 dump를 비교한다.
   - 새 fixture: 같은 스킬을 심볼릭 링크로 두 번 건 경우, 부모 디렉터리를 심볼릭 링크로 건 경우. 중복 제거 결과가 memo 없을 때(main 경로)와 같다.
   - ignore 파일 fixture: 무시된 스킬 디렉터리가 예전처럼 빠진다(`.gitignore`, `.ignore`, `.fdignore`, 대소문자 변형, 디렉터리 이름이 `.gitignore`인 경우, 깨진 링크).
2. **mock 요청 바이트가 main과 같다.** 벤치에서 Perf가 확인한다(스킬 목록 순서와 경로가 같으면 같아야 한다).
3. **성능** (Perf가 나중에 측정. 프로파일러 없이, 20쌍 교차, `OMK_TRUST_PROJECT=0`):
   - 1,191개: 첫 요청까지 중앙값 −30 ms 이상, 95% CI 상한 ≤ 0.
   - 번들 6개 `--noreg`: +5 ms 이내.
4. 게이트: biome, `check-module-size`, `check-import-cycles`, `tsgo --noEmit`, 바꾼 파일의 vitest.
