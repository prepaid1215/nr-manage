# Claude Code 인계 문서 — 2026-11-24 (기록 탭 · NRC 검색 · 등록 회원 · 수집기 로그)

11/08·11/09 인계 문서는 그대로 유효하다. 이 문서는 11/24 하루 동안 추가·변경한 내용과 **아직 끝나지 않은 일**을 정리한다.
비밀 값(계정 비밀번호·토큰·키)은 적지 않았다.

## 1. 지금 상태 (모두 `main`에 푸시됨, 마지막 커밋 `1b10d02`)

| 항목 | 값 |
|---|---|
| 프런트엔드 캐시 버전 | `20261125-18` |
| 수집기 release / 버전 | `2026112506` / `20261125-worker-log-1` |
| EXE SHA-256 | `54a7e2e4401395c9f27fee58174cfc7896d0d64eb7ca41690097826ddab0a053` (60,002,894 bytes) |
| 사무실 PC(`사무실(주하루)`) | 위 버전으로 자동 교체 완료, Defender 탐지 0건 |
| 집 PC(`DESKTOP-E89OGF9`) | 수동으로 같은 EXE 교체 실행함(백업 `NRCSync.manual-backup.exe`). **PC 목록에서 버전 확인 필요** (§4) |

## 2. 운영 DB(SQL) 적용 상태

| 파일 | 내용 | 상태 |
|---|---|---|
| RUN_051 | `nrc_daily_metrics`, `capture_daily_nrc_metrics` | 적용됨 |
| RUN_052 | `nrc_tracked_members`(등록 회원), 일일 기록이 등록 인원도 읽음 | 적용됨 |
| RUN_054 | `nrc_tracked_members`를 `service_role`이 읽는 권한 | 적용됨 (`has_table_privilege` = true 확인) |
| **RUN_053** | 기록 종류(`record_kind` daily/final)와 시간대 규칙 | **실행 여부 미확인 — §4 첫 항목** |

- 전체 SQL 재실행·DB 초기화는 하지 않는다. 위 파일은 모두 여러 번 실행해도 안전하게 작성돼 있다.
- 확인 쿼리(RUN_053): `select column_name from information_schema.columns where table_schema='public' and table_name='nrc_daily_metrics' and column_name='record_kind';` — 한 줄 나오면 적용된 것.

## 3. 오늘 만든 기능

### 3.1 기록 탭 (`v2/frontend/js/records.js`, `records-logic.js`)
- 날짜별 보기를 **사람별 탭**으로 변경. 탭 + `+`(추가), ×(닫기), 선택한 탭은 브라우저에 저장. "전체" 탭은 **탭으로 열어 둔 사람만** 한 표로 보여 준다.
- **NRC에서 찾기**: 기록 목록에 없는 이름을 입력하면 이 PC의 NRC Sync(`POST /lookup/member`)가 NRC 회원 검색으로 **10단계 밖 하위**를 찾아 본·서브1·서브2의 현재 값을 보여 준다. 저장하지 않는다.
- **표에 등록**: 찾은 사람을 `nrc_tracked_members`에 저장 → 수집할 때마다 함께 조회·기록. "등록 해제" 가능. 일부 코드를 못 읽은 사람은 등록을 막는다. 상세: [tracked-members.md](tracked-members.md)
- **오늘 칸 미리 보기**: 공식 기록이 생기기 전까지 오늘 수집한 최신값을 회색 기울임("진행 중")으로 보여 주고, 공식 기록이 있는 칸은 덮어쓰지 않는다. 수집 시각이 오늘(KST)이 아니면 쓰지 않는다.
- **시간대 규칙** ([record-windows.md](record-windows.md)): 일반 기록 = 그날 18:00~24:00의 마지막 수집, 마감일(8·15·23·말일)의 **최종마감** = 마감 다음날 00:00~06:00의 마지막 수집. 수집이 없으면 `-`. 규칙 시작은 `FINAL_RULE_START = 2026-11-23`(3차 마감부터). 그 전 마감일(11/8, 11/15)은 이전 규칙 그대로.
- 설정의 **예약 폼**: 시간이 기록에 쓰이는 시간대(일일 18:00~23:59, 마감일 예약 00:00~05:59)인지 안내만 한다. **저장은 막지 않는다**(사용자 선택 우선).

### 3.2 NRC 이름 검색 흐름 (수집기 `api.py`, `scraper.py`)
- 웹 → `http://127.0.0.1:5050/lookup/member`(앱 로그인 토큰을 body에 전달). PC가 서버 `/credentials/reveal`로 **'공유 PC 수집 승인'된 NRC 계정**을 받아 로그인한다. 비밀번호는 웹 화면·요청 본문을 거치지 않는다.
- 검색 호출: `osPopupMemberList.json`(이름 → 회원번호·직급코드, **산하 전체**) → `osPersonallySales.json`. `goSearch()`는 이름이 아니라 숨은 `schUserId2`를 쓰므로 이름만 넣어서는 검색되지 않는다.
- 같은 이름이 여러 명이면 본/서브1/서브2/단독으로 묶어 보여 준다(`label_member_roles`).

### 3.3 등록 회원 수집
- 서버 `/worker/claim`이 `job.trackedMembers`를 함께 준다(표가 없거나 읽기 실패 시 빈 목록, 수집은 막지 않음).
- 수집기 `scrape_tracked_members`가 계보 NV 뒤에 회원번호로 직접 조회해 통합 JSON의 `trackedMembers`에 넣는다(조직도가 쓰는 `members`/`rstLst`와 분리). 한 명이 실패해도 건너뜀. 3개 조회 포함 수집 약 51초(없을 때 52초).
- 일일 기록 함수가 `members`와 `trackedMembers`를 함께 기록한다.

### 3.4 서버 기록 호출 (`cloud-worker/cloud_service.py`)
- 한국시간 **06:30 이후** 하루 한 번 어제~3일 전을 `capture_daily_nrc_metrics(p_date)`로 기록(놓친 날 보정). 일부 실패 시 나머지를 시도하고 오류를 올리며 10분 간격으로 재시도.

### 3.5 수집기 로그 보강 (`queue_worker.py`)
- `nrcsync.log`(`%LOCALAPPDATA%\NRCSync\nrcsync.log`)에 **시각이 붙은** 줄이 남는다: `작업 배정받음`, `수집 시작: … 등록 회원 N개`, `수집 끝(N초): 계보 … 등록 회원 a/b개 읽음`, `결과 업로드 완료`, `수집 실패(…): 원인`, 작업 요청 응답이 8초 넘게 느릴 때 경고. 같은 오류는 5분에 한 번만(생략 횟수 표시). 비밀번호는 남기지 않는다.
- **어느 PC가 수집했는지**는 이 로그를 그 PC에서 봐야 안다. 웹의 "승인된 Windows PC에서 수집 중…"은 고정 문구이고, DB에는 가져간 PC 번호가 `nrc_sync_jobs.cloud_worker_id`(`pc-pool:<소유자>:<PC번호>`)로만 남는다. 화면에 PC 이름을 보여 주는 기능은 **제안만 하고 미구현**(PC 이름은 본인 PC·관리자에게만 보이게 해야 한다는 기존 설계가 있다).

## 4. 아직 끝나지 않은 일 (우선순위 순)

1. **RUN_053 적용 확인.** 안 했다면 `v2/supabase/RUN_053_RECORD_WINDOWS.sql` 전체를 Supabase SQL Editor에서 실행(`begin;`~`commit;` 한 묶음, 기본 키를 바꾸므로 결과 확인). 적용 전에는 이전 규칙(다음 날 오전 9시 전 마지막 수집)으로 기록된다.
2. **11/24 기록 확인(11/25 오전 6시 30분 이후).** 20:43에 사무실 PC가 주영돈 포함 수집(`작업 9139dce0`, 등록 회원 3/3개)을 올렸다. 18~24시의 **마지막** 수집이 11/24 기록이 되므로, 그 뒤 수집에 등록 인원이 빠져 있으면 주영돈이 빠진다. 기록 탭 "전체"에서 주영돈 칸 확인.
3. **집 PC `DESKTOP-E89OGF9`.** (a) 웹 PC 목록 버전이 `20261125-worker-log-1`인지 확인. (b) 그 PC의 **5050 포트를 NRC Sync가 아닌 `pythonw.exe`(사용자 계정의 `...\Python312\pythonw.exe`, 11/24 확인 시 PID 17316)가 쓰고 있다**(`/health`, `/update-status`가 Flask 404). 사용자의 다른 Python(Flask) 프로그램으로 보인다. NRC Sync 프로세스 2개(런처+본체)는 설치 경로에서 정상 실행 중이었고 작업 수신은 별개지만, 그 PC에서 브라우저로 쓰는 화면(우선 배정 확인)·업데이트 상태 화면은 안 열린다. 어떤 스크립트인지는 `Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | select CommandLine`으로 본다. 해결(그 프로그램의 포트 변경, 또는 NRC Sync 포트를 바꾸려면 앱 `LOCAL_SYNC`와 EXE를 함께 변경)은 미정이고, 집 PC를 원격 수집 전용으로만 쓰면 급하지 않다.
4. **수집이 요청한 PC로 먼저 가지 않는 문제(원인 미확정).** `매출받기`는 요청 직전에 `GET http://127.0.0.1:5050/health`로 "이 PC 우선"(15초)을 정한다. 11/24 저녁 세 번 요청(19:43, 19:52, 20:17)에서 이 요청이 사무실 PC 로그에 도착하지 않았고 다른 PC가 가져갔다. 같은 호출을 앱 페이지에서 직접 보내면 8ms로 정상. 다음 수집 때 PC 로그에 `GET /health`가 요청 시각에 찍히는지, `작업 배정받음`이 이 PC에 찍히는지 본다. 21:xx 이후 사무실 PC가 직접 가져간 경우(20:37, 20:42)는 다른 PC가 busy이거나 우연일 수 있다.
5. **사무실 PC의 소유 계정.** 이 PC는 앱 계정 `8bb38f95…` 소유로 등록돼 있고(PC 이름 `사무실(주하루)`), 사용자가 웹에서 쓰는 계정(`부건호`, 소유자 `431339c1…`)에는 본인 PC가 없다. 부건호 계정으로 옮기려면 "이 PC 자동 등록"을 쓰는데, 이 PC가 **새 PC로 등록돼 원래 계정에서는 빠진다**. 사용자가 아직 결정하지 않았다. (등록 버튼의 POST 연결 오류는 수정·배포됨.)
6. **예약 수집 설정 확인.** 기록으로 쓰려면 일일 예약을 저녁(18:00~23:59), 마감일 예약을 새벽(00:00~05:59, 기본 00:10)에 각각 두어야 한다. 사용자가 현재 설정을 확인하지 않았다.
7. **"NRC Sync 받기" 링크**(`app.js`의 `SYNC_DOWNLOAD`)는 아직 11/8 EXE(`163f804…`, release `2026110804`)를 가리킨다. 새 PC 최초 설치용이며 설치 뒤 자동 업데이트로 최신이 된다. 최신 게시 커밋(`439608d…`)으로 바꾸는 것을 권장.
8. 안 한 것: 최종마감 줄 굵기/미리 보기 범례 조정, CSV에 미리 보기 구분 표시, 수집 PC 이름 표시.

## 5. 이번에 배운 것 (같은 실수 방지)

- **새 표를 만들면 `service_role`에도 GRANT** 한다(RUN_016, RUN_023, RUN_054에서 세 번 같은 실수). Render 서버는 service_role 키로 읽는다. 서버가 오류를 삼키는 안전장치는 원인을 숨기므로, 새 표를 읽을 때는 첫 수집에서 로그로 꼭 확인한다.
- **Chrome에서 로컬 PC로 가는 `fetch` POST에 `targetAddressSpace: "local"`을 붙이면 본 요청이 나가지 않는다**(Failed to fetch, 서버엔 OPTIONS만 도착). GET은 괜찮았다. POST에는 붙이지 않는다.
- **브라우저 진단은 실제 앱 페이지(`https://prepaid1215.github.io/nr-manage/v2/frontend/`)에서 한다.** GitHub Pages의 "페이지 없음" 화면은 CSP로 모든 외부 요청을 즉시 막아, 진단 결과가 왜곡된다. 사이트 루트(`/nr-manage/`)는 옛 "NRC 고객 관리" 화면이다.
- 로컬 API의 `/api/*`는 연결 코드(`NRC_SYNC_TOKEN`)가 필요한데 배포 PC에는 설정돼 있지 않아 항상 401이다. 새 경로는 `/register-device-auto`처럼 `/` 아래에 두고 앱 로그인 토큰으로 호출자를 확인한다.
- Supabase의 `nrc_sync_snapshots`는 `owner_id` 기준 RLS이고 payload가 크다(약 170KB). 미리 보기는 60초 캐시로 한 번만 읽는다.

## 6. 운영 절차 메모

### EXE 빌드·게시 (11/08 문서 §8과 동일, 오늘 반복한 순서)
1. `sync_version.py`의 `APP_RELEASE`·`COLLECTOR_VERSION` 증가 → 테스트(`python -m unittest discover -s v2/sync-client/tests`, `…/cloud-worker/tests`, `npm test --prefix v2/frontend`).
2. `& 'v2/sync-client/build/clean-env/Scripts/python.exe' v2/sync-client/build_release.py` → `build/candidate/NRCSync.exe`.
3. Defender 사용자 지정 검사(시작·완료 이벤트와 탐지 0건 확인) → 크기·SHA-256 확인 → `installer/`에 같은 파일 복사 + `security-check.json` 기록.
4. EXE와 `version.json`을 **같은 커밋**으로 푸시 → 공개 주소 해시 확인 → 수집 PC가 30분 안에 교체(`/health`의 `release`로 확인) → 교체·설치 파일 검사 결과를 `security-check.json`에 반영해 다시 커밋.
- GitHub 캐시 때문에 `main`의 `version.json`이 몇 분 늦게 바뀐다. 자동 업데이트는 마지막 확인 + 30분 주기라 최대 약 35분 걸린다.

### 자동 업데이트가 안 되는 PC를 수동으로 바꿀 때 (PowerShell)
```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/prepaid1215/nr-manage/<커밋>/v2/sync-client/installer/NRCSync.exe" -OutFile "$env:TEMP\NRCSync-new.exe"
(Get-FileHash "$env:TEMP\NRCSync-new.exe" -Algorithm SHA256).Hash   # version.json의 sha256과 같은지 확인
Stop-Process -Name NRCSync -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; Copy-Item "$env:LOCALAPPDATA\NRCSync\NRCSync.exe" "$env:LOCALAPPDATA\NRCSync\NRCSync.manual-backup.exe" -Force; Copy-Item "$env:TEMP\NRCSync-new.exe" "$env:LOCALAPPDATA\NRCSync\NRCSync.exe" -Force; Start-Process "$env:LOCALAPPDATA\NRCSync\NRCSync.exe"
```
PC 등록·자격 증명은 그대로 유지된다. 보안 제품이 차단하거나 격리하면 멈춘다(격리 복원·예외 추가 금지).

### 푸시하면 일어나는 일
- `main` 푸시 → Render(`nrc-sync-cloud-sg`) 자동 배포(몇 분간 재시작 가능), GitHub Pages 반영(1~2분), EXE는 켜진 PC가 30분 안에 자동 교체.

## 7. 지켜야 할 것 (CLAUDE.md 요약 + 오늘 확인)
- 사용자가 요청하기 전에는 실제 등록 PC를 해제하지 않는다(집 PC 임시 해제는 사용자가 직접 누르는 방법으로만 안내했다).
- 커밋·푸시는 사용자가 요청할 때만 한다. EXE를 푸시하면 모든 수집 PC에 자동 배포되므로 특히 그렇다.
- 격리된 파일 복원·백신 예외 추가·보호 해제는 하지 않는다. 암호화 키·갱신 토큰은 건드리지 않는다.
- 프런트 변경 시 import `?v=`와 `index.html`의 앱 버전을 함께 올린다(이번에는 `app.js`, `records.js`, `records-logic.js`, `schedule-hint.js`, `app.css`를 `-18`로 맞춤).

## 8. 테스트 (11/24 마감 시점)
수집기 76개, 서버 39개, 프런트(기록·예약 안내 포함) 모두 통과. 화면 확인은 가짜 Supabase를 붙인 임시 페이지로 했고 **실제 데이터로 확인한 것은 아니다**(오늘 칸 미리 보기, 최종마감 줄, 등록·해제).
