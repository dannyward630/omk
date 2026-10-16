---
description: "턴 뒤 임계값 컴팩션이 마지막 응답 usage만 보고 뒤에 붙은 도구 출력을 빼먹는다. 입력 용량 검사와 같은 기준으로 재서, 하드 상한에 닿기 전에 컴팩션이 돌게 한다"
---

# Feature Specification: 입력 용량 거절 전에 컴팩션 돌리기

**Specification ID**: `060-compaction-before-capacity`
**Feature Branch**: `harness/060-compaction-before-capacity` (origin/main `e28c260`에서 분기. spec 번호 059는 이미 `059-llm-call-log`가 써서 060을 쓴다)
**Created**: 2026-10-16
**Status**: 승인(Tech Lead, OMK, 2026-10-16, 플래그 없음). R1만 범위
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: 1.4.3 긴 세션 메모리 측정(Harness Engineer, `bench-mem/`) 중 200턴 세션이 5/5 모두 `PromptInputCapacityError`로 죽었다. Tech Lead가 우선순위를 올렸다.

## 지금 코드가 하는 일 (경로는 `packages/coding-agent/src/core/` 기준)

- **턴 뒤 임계값 검사**: `agent-session.ts:3874` `_checkCompaction`은 정상 응답이면 `contextTokens = calculateContextTokens(assistantMessage.usage)`(`agent-session.ts:3949`)로 잰다. 마지막 응답의 provider usage뿐이라 **그 응답 뒤에 붙은 도구 결과는 들어가지 않는다**. 이 값으로 `_runtimeCompactionDecision`(`agent-session.ts:3521-3535`)이 히스테리시스 판정을 한다.
- **입력 용량 검사(하드 상한)**: 다음 프롬프트 전에 `session-turn-admission.ts:93-114` `admit` → `session-input-admission.ts:186` `admitSessionInput` → `assertSessionInputCapacity`(`session-input-admission.ts:133-145`)가 **전체 히스토리 + pending**을 토큰 카운터로 센다. 넘으면 `prompt-budget.ts:240`이 `PromptInputCapacityError`를 던진다.
- **마지막 구조 한 번**: 넘었을 때 컴팩션이 켜져 있으면 `agent-session.ts:894-897`의 `compact`(`_runThresholdCompaction(true)`, 비상 설정)를 한 번 돌리고 다시 잰다. 실패하거나 컴팩션 엔트리가 안 생기면 그대로 거절한다(`session-input-admission.ts:199-205`).

## 원인

1. 두 검사가 서로 다른 값을 잰다. 임계값 검사는 provider usage(도구 출력 제외), 용량 검사는 전체 히스토리 추정치다. usage가 작게 보고되거나(가짜 provider는 항상 input 100) 큰 도구 출력이 응답 뒤에 붙으면, 임계값 컴팩션이 **한 번도 안 돌고** 바로 하드 상한에 닿는다.
2. 그러면 남는 길은 하드 상한에서의 비상 컴팩션 한 번뿐이다. 이것이 실패하면 세션이 죽는다. bench-mem에서는 가짜 모델이 요약 요청에 도구 호출로 답해서(`compaction/summary-response.ts:8`, "invalid summary stop reason") 이 한 번이 실패했고, 5/5가 죽었다.

재현(`test/compaction-before-capacity.test.ts`, 64k 창, 도구 결과 약 24KB/턴): main에서는 1~6턴 동안 컴팩션이 0번이고, 7턴째 하드 상한에서 처음 컴팩션이 돈다. 요약이 정상이면 세션은 살아남는다. 요약이 실패하면 7턴째에 `PromptInputCapacityError`로 죽는다.

## Requirements

### R1 - 같은 기준으로 재기 (P0, 유일한 범위)

`_checkCompaction`의 정상 응답 경로(`agent-session.ts:3949`)에서
`contextTokens = max(calculateContextTokens(usage), 전체 입력 추정치)`로 바꾼다. 추정치는 용량 검사와 **같은 토큰 카운터**(`SessionTurnAdmission`이 마지막으로 받은 counter)로 `estimateContextInputTokens`(`prompt-budget.ts:203`)가 시스템 프롬프트, `agent.state.messages` 전체, 도구 스키마를 센 `localTokens`다. usage가 더 크면(provider가 정확하면) 지금과 같다. 오류 응답 경로는 바꾸지 않는다.

계산은 `SessionTurnAdmission.thresholdContextTokens()`가 하고, 컴팩션을 결정하면 `recordCompactionDecision()`이 `appendRunLog("compaction-trigger", …)`(`run-log.ts:50`, `OMK_RUN_LOG_DIR`가 있을 때만)로 한 줄을 남긴다. 필드: `trigger`(`usage` | `estimate` | 오류 경로는 `error-estimate`), `usageTokens`, `estimatedTokens`, `contextTokens`, `contextWindow`, `emergency`. main에는 컴팩션 run-log 엔트리가 없어서 이 이름으로 새로 만든다.

### 범위에서 뺀 것

- (구 R2) `SessionTurnAdmission`에서 하드 검사 전 이른 컴팩션: 뺐다(Tech Lead 조건). R1만으로 AC를 못 채우면 범위를 넓히지 않고 멈추고 보고한다. R1만으로 AC를 모두 채웠다.
- 플래그 없음(Tech Lead, OMK 결정). 바뀌는 것은 "죽던 세션이 산다"와 "하드 상한의 비상 컴팩션이 그 전의 일반 컴팩션으로 당겨진다"뿐이다.

## Acceptance Criteria

모두 `packages/coding-agent/test/compaction-before-capacity.test.ts`(64k 창, 가짜 모델 usage는 기본값 input 100)다. "main"은 `e28c260`이다.

1. **재현**: 도구 결과 24KB/턴, 16턴. 수정 전에는 실패하고(첫 컴팩션 턴 7, `expected 7 to be less than 7`), 수정 후에는 **5번 돌려 5/5 통과**한다. 16턴 완료, `PromptInputCapacityError` 없음, 실패한 컴팩션 없음, 첫 컴팩션 턴 < 7.
2. **비상 요약 실패**: 하드 상한(입력 용량 검사)의 비상 컴팩션 요약 요청에 가짜 모델이 오류를 낸다. main에서는 7턴째 `PromptInputCapacityError`로 죽는다(확인함). 수정 후에는 일반 임계값 컴팩션이 먼저 돌아 하드 상한에 닿지 않고 16턴을 모두 마친다. **5번 돌려 5/5 통과**. "5/5 완주"의 직접 증거다.
3. **단일 출력이 창보다 큼**(약 400KB): 크래시 없이 2턴을 마친다. 기존 잘림/스필 경로가 깨지지 않았는지만 본다. main에서도 통과한다.
4. **작은 출력의 컴팩션 시점 그대로**: 200B/턴 16턴에서 컴팩션 0회(main과 같다). 그리고 **기존 컴팩션 테스트 전부가 한 줄도 고치지 않고 통과**한다(`npx vitest run test/compaction --exclude test/compaction-before-capacity.test.ts`: 19 files passed, 283 passed / 10 skipped).
5. **run log**: 컴팩션이 일어나면 `compaction-trigger.jsonl`에 `trigger`와 `usageTokens`, `estimatedTokens` 두 값이 남는다. 재현 시나리오에서는 `trigger: "estimate"`이고 `estimatedTokens > usageTokens`다.
6. **반스래시**: 재현 시나리오 16턴 동안 컴팩션 시작 ≤ 3회. 수정 후 실측은 2회(턴 6, 12)이고, 상한은 실측 + 1이다.
7. typecheck와 lint는 저장소 pre-commit(`npm run check`)을 통과한다.
8. **재개한 세션**: 첫 `admit()` 전에 도는 프롬프트 전 검사(`_checkCompaction(lastAssistant, false)`)에서도 추정치가 0이 아니다. admission의 기본 counter(fallback)로 센다. run log에 `trigger: "estimate"`이고 `estimatedTokens > 30,000`, 컴팩션이 성공한다.
9. `bench-mem` 큰 출력 워크로드(1M 창, 200턴)가 5/5 완주한다. 같은 시간대에 다른 팀원의 벤치나 테스트가 돌지 않아야 하고, load1을 기록한다.
   결과(2026-10-16, 요약 요청에는 정상 요약으로 답하는 가짜 모델): 수정 후 5/5 완주, 회당 컴팩션 2회, 실패 0, load1 1.80/2.40/2.30/2.88/3.29(다른 팀 벤치·vitest는 돌지 않았고 브라우저 부하만 있었다). 참고로 main도 요약이 정상이면 1/1 완주했다(하드 상한에서 비상 컴팩션 1회). 수정의 차이는 AC 2처럼 비상 컴팩션이 실패할 때 드러난다.

### usage 대비 추정치 비율 (Tech Lead MAJOR)

R1은 `max(usage, 추정치)`라서, 추정치가 실제 usage보다 크게 나오면 정상 세션도 일찍 컴팩션한다. 실제 provider 세션에서 `추정치 / (input + cacheRead + cacheWrite)`의 중앙값이 1.1 이하이고 p90이 1.25 이하여야 한다. 넘으면 `usage + 마지막 usage 뒤에 붙은 메시지의 추정치`(usage가 없으면 전체 추정치)로 바꾼다.

2026-10-16 현재 박스에는 **실제 provider 세션 데이터가 없다**. `~/.omk/agent/sessions`의 세션 파일 763개는 모두 테스트가 만든 것이다(assistant 응답의 provider/model이 `faux/faux-1`, `faux/faux-2`, `anthropic/test`뿐이다). `llm-call*.jsonl` run log도 없다. 그래서 이 비율은 아직 재지 못했고, 머지 전에 실제 세션(예: `OMK_RUN_LOG_DIR`를 켠 실제 provider 세션 몇 개)으로 재야 한다.

## 측정: 추정 비용

턴마다 전체 입력을 한 번 더 센다. fallback 카운터, Node 22.20, 60회 중 앞 10회 버림(측정 때 load1 3.7이라 참고값):

| 히스토리 | 바이트 | 추정 토큰 | 중앙값 | p95 |
|---|---|---|---|---|
| 200턴(bench-mem 크기) | 1.6MB | 403,669 | 18.2ms | 22.2ms |
| 1M 창 근처 | 3.7MB | 955,397 | 40.1ms | 59.5ms |

모델 호출 한 번(초 단위)에 비하면 작지만, 창이 아주 큰 세션에서는 턴당 수십 ms가 든다. 줄이는 것(증분 카운트, 캐시)은 이 spec 범위가 아니다.

## 하지 않을 것 (Non-goals)

- 하드 상한에서 한 번만 하는 마지막 컴팩션 재시도(`session-input-admission.ts:186-205`)는 바꾸지 않는다.
- 도구 출력 하나가 창보다 큰 경우는 여기서 고치지 않는다. AC 3은 기존 잘림/스필 경로가 깨지지 않았는지만 본다. 제대로 된 수정은 1.4.4다.
- 히스토리 이중 보관(`agent-loop.ts:270`의 `structuredClone` 스냅샷과 `session-manager.ts:982` 엔트리): 1.4.4.
- 오래된 도구 출력 마스킹(Agent Researcher 제안): 기본 꺼진 플래그로 따로 간다.
- 토크나이저(js-tiktoken 설치, 워커): lockfile에 없고 이 버그와 무관하다.

## 파일 목록

- `packages/coding-agent/src/core/agent-session.ts` (R1, `_checkCompaction` 두 줄. module-size 기준선 4215줄을 넘지 않는다)
- `packages/coding-agent/src/core/session-turn-admission.ts` (`thresholdContextTokens()`: 같은 counter로 센 추정치와 usage 중 큰 값, `recordCompactionDecision()`: run log)
- `packages/coding-agent/test/compaction-before-capacity.test.ts` (새 회귀 테스트 5개)

## 위험과 대응

- **컴팩션이 더 일찍, 더 자주 돈다 → 요약 호출 비용이 는다.** usage가 정확한 provider에서는 max가 usage를 고르므로 거의 그대로다. 늘어나는 것은 usage가 도구 출력을 빼먹던 경우뿐이고, 그때의 대안은 하드 상한의 비상 컴팩션이나 세션 종료다. 히스테리시스는 그대로 두고, AC 6(반스래시 상한)과 AC 4(작은 출력 0회, 기존 테스트 무수정 통과)로 막는다.
- **추정치가 실제보다 크면 너무 일찍 컴팩션한다.** 용량 검사와 같은 카운터를 쓰므로 하드 상한보다 먼저 거절되는 일은 없다. 정상 세션의 시작 턴은 AC 4로 확인한다.
- **턴마다 전체 입력을 센다 → CPU.** 실측 중앙값 18ms(1.6MB), 40ms(3.7MB)다(위 표). PR에 적는다.

## 롤백

수정 커밋(R1)을 되돌린다(데이터 형식·설정 변경 없음, 세션 파일 호환). 회귀 테스트는 남겨 두고 `it.fails`로 바꾼다.
