# 표에 등록한 하위 회원 (10단계 밖) 매일 기록

기록 탭에서 "NRC에서 찾기"로 찾은 10단계 계보 밖의 하위 회원을 "표에 등록"하면, 이후 수집 때마다 함께 조회해 다른 사람처럼 매일 기록한다.

## 흐름

1. 웹 앱(기록 탭): 이름으로 NRC 검색 → 결과 카드의 "표에 등록" → `nrc_tracked_members`에 본·서브1·서브2 회원번호 저장.
2. Render `/worker/claim`: 작업을 줄 때 그 계정(owner + source_account)의 등록 목록을 `job.trackedMembers`로 함께 전달한다. 표가 없거나 조회가 실패하면 빈 목록이고 수집은 막히지 않는다.
3. 수집기(`queue_worker.process_job` → `scraper.scrape_combined_json`): 계보 NV 조회 뒤 등록 회원을 회원번호로 `osPersonallySales.json`에서 직접 조회해 통합 JSON의 `trackedMembers`에 넣는다. 한 명이 실패해도 건너뛴다. 이미 계보에 있는 번호는 다시 조회하지 않는다.
4. `capture_daily_nrc_metrics`(RUN_052로 교체): `members`와 `trackedMembers`를 함께 `nrc_daily_metrics`에 기록하고, 이름·직급은 `rstLst`와 `trackedMembers`에서 찾는다. 조직도가 쓰는 `members`/`rstLst`에는 등록 회원을 넣지 않는다.
5. 기록 탭 표: 탭으로 연 사람만 "전체"에 나온다. 등록한 사람은 기록이 쌓이기 전에도 열이 보인다.

## 적용 순서와 안전장치

| 순서 | 작업 | 순서가 바뀌어도 |
|---|---|---|
| 1 | Supabase SQL Editor에서 `RUN_052_TRACKED_MEMBERS.sql` 실행 | 표가 없으면 웹이 "RUN_052 실행 필요"를 안내하고 서버는 빈 목록을 쓴다 |
| 2 | Render 배포 (push하면 자동) | 구 수집기는 `trackedMembers`를 무시한다 |
| 3 | 새 NRC Sync 배포 (자동 업데이트, 약 30분) | 구 SQL은 `trackedMembers`를 읽지 않아 기록되지 않을 뿐 오류는 없다 |

- 첫 기록: 등록 뒤 첫 **저녁(18~24시) 수집**이 끝난 다음 날 오전 6시 30분 이후([record-windows.md](record-windows.md)의 규칙). 등록한 날의 기록은 없다.
- 계정당 등록은 150개까지(DB 트리거). 수집 시간은 코드 하나당 조회 1번만큼 늘어난다.
- 등록 해제: 탭의 "등록 해제". 이미 쌓인 기록은 지우지 않는다.
- 이름 검색은 이 PC의 NRC Sync `POST /lookup/member`가 한다. 서버에 '공유 PC 수집 승인'된 계정을 `/credentials/reveal`로 받아 로그인하며, 비밀번호는 웹 화면을 거치지 않는다.

## 테스트

```powershell
python -m unittest discover -s v2/sync-client/tests -v
python -m unittest discover -s v2/cloud-worker/tests -v
npm test --prefix v2/frontend
```
