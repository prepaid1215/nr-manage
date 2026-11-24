# Claude Code 인계 — 2026-11-09 갱신

기준: `main` 마지막 커밋 `5c20f56` (2026-11-09). 11/08 인계 문서
[CLAUDE_CODE_HANDOFF_2026-11-08.md](CLAUDE_CODE_HANDOFF_2026-11-08.md)의 **추가분**만 담는다.
수집 구조, 회선 수 규칙, PC 관리, 자동 업데이트, EXE 빌드·게시 절차, 보안 이력은 11/08 문서가 그대로 유효하다.

## 1. 11/08 문서 이후 추가된 기능

| 영역 | 내용 | 커밋 |
| --- | --- | --- |
| 내 계보도 탭 (`custom-tree.js`, `custom-tree-logic.js`) | 구성원 제외를 저장하고 마감 계산과 연동. 이후 사람을 클릭해 불을 켜는 방식으로 변경. 한 사람은 본코드·서브1·서브2 3코드가 한 몸이며, 켜진 사람만으로 계보도를 구성하고 하나도 없으면 전체를 쓴다. | `3444277`, `5951440`, `e57f06b` |
| 마감 추천 (`performance-calculator.js`) | 아래로 균등 분배하며 약한 회선 쪽을 먼저 채운다. 최소 조각 보장. 제외된 구성원은 건너뛰고 나머지끼리 계속 분배한다. 한 박스로 합쳐질 때 사유를 표시한다. | `b3a5129`, `e2a24ec`, `f158fc0` |
| 실적 탭 → 추천·제외 하위 탭 (`closing-lab.js`, `selective-split.js`, `closing-model.js`) | 코드를 제외하고 추천을 받는 화면. 드래그 이동, 연결선에 하위 합계 표시. 코드를 제외하면 입력한 매출을 지우고 나머지를 다시 계산한다. | `12e3932`, `407bc89`, `f62eda4` |
| 실적 탭 → 목표합계 추천 하위 탭 | 서브1 + 서브2 합계를 목표로 추천한다. | `5c20f56` |
| 설정 → 수집 PC 삭제 버튼 | `hidden_at`으로 목록에서만 숨긴다. 해제(revoked) 기록은 물리 삭제하지 않으므로 구버전의 자동 재등록이 막힌 상태가 유지된다. | `cf1b079` |

## 2. DB SQL (운영 적용 완료, 2026-11-23 확인)

세 파일 모두 운영 DB(`nrc-management-v2`)에 적용돼 있다. 048은 테이블 존재(REST 권한 거부 응답), 049는 `information_schema`에서 `hidden_at` 컬럼 확인, 050은 11/23 SQL Editor에서 직접 실행해 `Success`를 확인하고 테이블 존재를 재확인했다.
11/09 푸시 후 11/23까지 050이 빠져 있어 그 사이 내 계보도의 선택 저장은 동작하지 않았을 수 있다. 모두 여러 번 실행해도 안전하게 작성됐지만, 전체 RUN 재실행은 하지 않는다.

| 파일 | 내용 |
| --- | --- |
| `RUN_048_CUSTOM_GENEALOGY_EXCLUSIONS.sql` | 내 계보도 구성원 제외 저장 |
| `RUN_049_PC_HIDE.sql` | `nrc_sync_devices.hidden_at` 추가 |
| `RUN_050_CUSTOM_TREE_PICKS.sql` | `nrc_custom_tree_picks` 테이블(불을 켠 사람의 본코드 번호) |

`5951440`은 업데이트 권한 없이도 제외를 저장하도록 고친 수정이므로, 048의 권한 설계와 함께 본다.
적용 전에 해당 기능을 쓰면 저장이 실패하거나 화면이 비어 보일 수 있다.

## 3. 현재 버전

| 항목 | 값 |
| --- | --- |
| 프런트엔드 앱 캐시 버전 | `20261109-6` (`v2/frontend/index.html`) |
| custom-tree 계열 모듈 캐시 | `?v=20261109-1` |
| 수집기 EXE | 변경 없음. 11/08 문서의 release `2026110804` |

## 4. 검증 상태

- 확인함: `npm test --prefix v2/frontend` 실행 결과 표시된 마지막 항목(균등 분배, 제외 계속 분배, 선택 분할)이 통과로 출력됐다. 전체 종료 코드와 sync-client·cloud-worker 테스트는 이번에 다시 실행하지 않았다.
- 확인하지 못함: 11/09 기능의 운영 화면 확인, GitHub Pages workflow 결과, PR·Actions 현황(`gh` 미설치).
- 11/09 이후 main 커밋은 없다.

## 5. 다른 브랜치

| 브랜치 | 상태 |
| --- | --- |
| `diagnostics/nrc-sync-windows-smoke-20261109` | main보다 9커밋 앞서고 6커밋 뒤처져 있다. 새 Windows 후보 EXE를 게시 없이 빌드·실행하는 CI와 기존 NRC 서버 이전(legacy handoff) 문서 작업이다. 미병합. EXE 게시 전 Defender 검사와 해시 검증 규칙은 그대로 적용한다. |
| `feat/closing-line-total-rules`, `codex/supabase-rebuild` | 8월 작업으로 main에 이미 포함됨 |

## 6. 이어서 시작할 순서

1. `CLAUDE.md`와 11/08 문서, 이 문서를 읽는다.
2. `git status`, `git fetch`, 진단 브랜치와 main의 차이를 확인한다.
3. 운영 DB의 RUN_048~050은 적용 완료다. 새 SQL이 생기면 적용 여부를 확인하고 사용자에게 적용을 요청한다.
4. 운영 화면에서 내 계보도, 추천·제외, 목표합계 탭이 동작하는지 확인한다.
5. 진단 브랜치의 후보 EXE 작업을 이어갈지 사용자에게 묻는다.

시작 문장:

> CLAUDE.md와 v2/docs/CLAUDE_CODE_HANDOFF_2026-11-09.md를 먼저 읽어줘. 11/08 문서도 함께 참고하고, git 상태를 확인한 다음 이어가자. 운영 DB 초기화나 등록 PC 임의 해제는 하지 마.

## 7. 일별 실적·회선수 기록 (2026-11-24 추가, 운영 DB 미적용)

- `v2/supabase/RUN_051_DAILY_METRICS.sql`: `nrc_daily_metrics` 표와 `capture_daily_nrc_metrics(p_date)` 함수. 적용 전까지 기록은 시작되지 않는다.
- 클라우드 워커(`cloud_service.py`)가 한국시간 날짜가 바뀐 뒤 하루 한 번 이 함수를 호출해 어제 24시 이전 마지막 통합 스냅샷의 회원별 대실적·소실적·실회선·소비자총회선을 저장한다. 같은 날짜·계정은 덮어쓰지 않는다.
- 실회선·소비자총회선은 수집기 v2가 실제로 읽은 값만 저장하고 못 읽었으면 NULL(실제 0과 구분).
- 이 SQL은 로컬 Postgres가 없어 실행해 보지 못했다. 운영 적용 후 `select capture_daily_nrc_metrics(current_date - 1)` 결과로 확인한다.
