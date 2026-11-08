# Claude Code 인계 — NRC 사업관리 프로그램

정리 기준: 2026-11-08, 마지막 기능 커밋 `e7b7cc9`.
이 문서를 작성하기 직전 작업 트리는 깨끗했고, 아래 기능은 main에 push 및 운영 반영을 확인했다.
이 문서에 포함된 검증 결과는 해당 작업 당시의 결과이며, 이후 환경 상태는 다시 확인한다.

## 1. 프로젝트와 운영 위치

| 항목 | 위치 |
| --- | --- |
| 현재 작업 폴더 | `C:\Users\dona1\OneDrive\문서\ChatGPT\사업관리프로그램` |
| GitHub 저장소 | https://github.com/prepaid1215/nr-manage |
| 작업 브랜치 | `main` |
| 운영 웹 앱 | https://prepaid1215.github.io/nr-manage/v2/frontend/index.html |
| 클라우드 API | https://nrc-sync-cloud-sg.onrender.com |
| 클라우드 상태 | https://nrc-sync-cloud-sg.onrender.com/health |
| Supabase 프로젝트 | `ymagjzwebshfnjiisrao` (`nrc-management-v2`) |
| Windows 로컬 API | `http://127.0.0.1:5050` |
| PC 설치 위치 | `%LOCALAPPDATA%\NRCSync\NRCSync.exe` |
| PC 데이터 | `%LOCALAPPDATA%\NRCSync\data` |
| 시작프로그램 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\NRCSync.vbs` |

Render 운영 서비스 이름은 `nrc-sync-cloud-sg`이고, 저장소 `render.yaml`의 서비스 이름은 `nrc-sync-cloud`로 남아 있다. 새 서비스를 만들지 말고 기존 운영 서비스를 확인한다.
운영 Render 서비스 ID는 `srv-da9o9o6gekts738p8eu0`이다.

## 2. 실제 수집 구조

1. 웹 앱이 Supabase `nrc_sync_jobs`에 수집 요청을 등록한다.
2. 로컬 NRC Sync의 `/health`에서 현재 PC ID를 얻을 수 있으면 그 PC를 `target_device_id`에 지정하고, `preferred_until`을 요청 시각 + 15초로 저장한다.
3. Windows 수집기가 Render `/worker/claim`을 통해 작업을 가져간다.
4. Render는 로그인 사용자와 등록 PC 상태, 수집기 호환성을 확인하고, 승인된 해당 NRC 계정의 자격 증명을 전달한다.
5. 실제 NRC 사이트 접근은 Windows PC의 Playwright가 실행한다.
6. `/worker/complete`가 DB의 원자적 완료 RPC를 호출해 결과와 작업 상태를 함께 저장한다.

Render는 현재 작업 조정 서버다. `RUN_BROWSER_WORKER=false`로 운영하며, 서버에서 브라우저 수집을 켜는 것으로 문제를 해결하려고 하지 않는다.

### 사용자가 명시한 우선순위

**앱 계정에 로그인해서 수집을 요청한 바로 그 노트북·PC가 1순위다.**

구현은 현재 브라우저와 같은 기기에서 실행 중인, 등록된 NRC Sync를 확인하는 방식이다.
웹 로그인만으로 프로그램이 자동 설치·등록되는 것은 아니다. 로컬 프로그램이 없거나 PC ID를 얻지 못하면 공유 승인 PC 대기열을 사용한다.
현재 PC로 지정된 요청도 아직 배정되지 않은 상태에서 15초가 지나면 다른 승인 PC가 처리할 수 있다.
휴대폰 등 로컬 수집기가 없는 기기에서도 공유 PC에 요청할 수 있다.

15초 전환은 **아직 가져가지 않은 요청의 배정**에 적용한다. 이미 실행 중인 PC가 갑자기 꺼진 경우의 작업 회수·재배정은 이번 변경의 완료 검증 범위가 아니다.

## 3. 이번 대화에서 완료한 기능

### 계정 복구·관리자 비밀번호 초기화

- 아이디 찾기 / 비밀번호 재설정을 복구 퀴즈 방식으로 구현했다.
- 신규 가입 시 퀴즈를 등록하고, 기존 회원은 설정 → 계정에서 등록할 수 있다.
- 관리자: 오류확인 → 가입자 현황에서 관리자 비밀번호를 확인한 뒤 임시 비밀번호를 발급한다.
- 회원은 임시 비밀번호로 로그인한 후 새 비밀번호를 설정해야 한다.
- 복구 시도 제한, 답변 해시, 관리자 감사 기록을 포함한다.
- 상세: [account-recovery.md](account-recovery.md).

### 회선 수 누락 수정

NRC의 실제 응답 필드와 수집기 필드 매핑:

| NRC 필드 | 저장 필드 | 의미 |
| --- | --- | --- |
| `totalLineCnt` | `consumerTotalLines` | 소비자 총회선 |
| `telCnt` | `realLines` | 실회선 |
| `acGrpCnt` | `ownSalesLines` | 본인 매출 회선 |
| `autoCnt` | `regularDeliveryLines` | 정기배송 회선 |

- 모르는 필드를 `0`으로 채우던 방식을 수정했다. 누락은 null, 실제 0은 숫자 0이다.
- 각 회원에 `lineMetricsVersion: 2`, `lineMetricsAvailable`, `lineMetricsFound`를 저장한다.
- 프런트엔드 `memberLineMetrics()`가 구버전의 확인되지 않은 0을 `미수집`으로 표시한다.
- 정상 수집본을 저장한 뒤 다른 PC의 구버전 수집 결과가 다시 최신 자료로 저장되는 문제가 실제 확인됐다.
- 현재 API는 호환성 정보를 보내지 않는 구버전에게 새 작업을 주지 않는다. 완료 RPC도 구버전 회선 자료를 거절한다.
- KT/LG 구분은 해당 회원의 실제 회선 목록을 확보한 경우에만 표시한다. 하위 회원의 총회선·실회선 수가 있다고 KT/LG 목록까지 확보된 것은 아니다.
- 상세: [line-metrics.md](line-metrics.md). 이 문서의 이전 실행 파일 버전 정보는 과거 기록이다.

### 등록 PC 해제·다시 등록

- 위치: **설정 → 수집 PC**.
- 일반 사용자는 본인 PC 목록과 관리 버튼을 본다. 다른 소유자의 PC 상세는 노출하지 않고 공유 PC 전체/온라인 대수만 제공한다.
- 관리자는 전체 PC 목록에서 등록 해제·다시 등록할 수 있다.
- 해제 시 `nrc_sync_devices.revoked_at`을 기록하고 OFFLINE으로 전환한다.
- 해제 기록을 남겨 구버전 heartbeat upsert가 PC를 다시 등록하지 못하게 한다. authenticated 역할의 물리 DELETE도 차단한다.
- 해당 PC가 맡은 진행 중 요청은 CANCELLED로 바꾸고, 그 PC를 기다리던 요청은 다른 PC가 맡을 수 있게 한다.
- 해제와 완료 RPC는 장치 → 작업 순서로 잠그며, 해제된 PC의 결과 저장을 차단한다.
- 명시적인 다시 등록 또는 해당 PC에서의 자동 등록으로 재허용한다. 주기적인 heartbeat는 재등록을 수행하지 않는다.
- 기존 수집 자료·로컬 자격 증명을 삭제하지 않는다. 원격 PC에서 이미 열린 브라우저를 강제 종료하거나 프로그램 자체를 제거하는 기능은 아니다.

### Windows 자동 업데이트

- 설치된 EXE는 실행 후 및 30분마다 고정된 공식 manifest 주소를 확인한다.
- 다운로드 파일의 크기, SHA-256, PE 실행 파일 헤더를 검증한다.
- 진행 중인 수집·업로드·메모장 작업이 끝나기를 기다린다. 10분 안에 끝나지 않으면 이번 업데이트를 미룬다.
- 별도 도우미가 기존 프로세스 종료를 기다려 교체하고, 새 버전의 로컬 health와 시작 토큰을 확인한다.
- 정상 시작 실패 시 이전 EXE로 복구하고, 같은 실패 버전의 재시도를 하루 미룬다.
- 개발용 `python api.py`에는 EXE 자동 교체를 적용하지 않는다.
- 자동 업데이트 기능이 없는 옛 PC는 새 EXE를 한 번 직접 설치해야 한다.
- 트레이 → 업데이트 확인, 로컬 `/update-status`에서 상태를 볼 수 있다.

### 가장 최근 화면 변경

- 대상: **실적 → 마감 계산의 계보 박스** (`manual-close.js`).
- 박스 안의 대실적·소실적 표시를 제거하고 **실회선 N회선**을 넣었다.
- 서브1·서브2, 본인 NV, 매출 입력 칸은 유지했다.
- `memberLineMetrics()`를 재사용해 실제 0회선 / 미수집을 구분한다.
- 카드에서 제거한 major/minor DOM 업데이트 호출도 제거했다. 내부 마감·추천 계산의 major/minor 값은 계속 사용한다.
- 주영돈 `2893497` 카드에서 실회선 `9회선`, 매출 입력 후 재계산과 원래 입력값 복원을 운영 화면에서 확인했다.

## 4. 현재 배포 버전과 커밋

| 항목 | 현재 값 |
| --- | --- |
| 마지막 기능 커밋 | `e7b7cc9` — 마감 카드 실회선 표시 |
| PC 관리·현재 PC 우선·구버전 차단 | `163f804` |
| 현재 EXE를 포함하는 고정 커밋 | `163f80438e2705a367e2eb650c46c8a0311815bc` |
| 자동 업데이트 최초 추가 | `28838c6` |
| 프런트엔드 앱 캐시 버전 | `20261108-8` |
| 마감 카드 모듈 캐시 버전 | `manual-close.js?v=20261108-1` |
| 실행 파일 release | `2026110804` |
| collectorVersion | `20261108-device-control-1` |
| 실행 파일 크기 | 57,975,332 bytes |
| 실행 파일 SHA-256 | `7748b4919f0794016e7dad0c886202bbdd4f075f35f9aa3955e590891acdc67d` |

기준 파일: `v2/sync-client/sync_version.py`, `installer/version.json`, `installer/security-check.json`.

현재 PC는 새 버전 교체·재시작을 검증했고 정상 수집했다. 관리자 목록의 `남산pc` 및 오래된 중복 PC 항목은 당시 구버전/업데이트 필요 상태였다. 이 PC들을 임의로 해제하거나 삭제하지 않았다.

## 5. 주요 파일

| 파일 | 역할 |
| --- | --- |
| `v2/frontend/js/app.js` | 설정 PC 목록, 등록 제어, 로컬 PC 확인 및 우선 요청, 조직 상세 |
| `v2/frontend/js/manual-close.js` | 실적 탭의 직접 마감 계산과 이번 실회선 카드 |
| `v2/frontend/js/line-metrics.js` | 실제 0·누락·구버전 자료 구분 |
| `v2/frontend/js/performance-calculator.js` | 마감 계산 핵심 모델·추천 로직 |
| `v2/cloud-worker/cloud_service.py` | PC 관리 API, 작업 배정·수집 결과 저장 |
| `v2/cloud-worker/account_recovery.py` | 복구 퀴즈·관리자 임시 비밀번호 API |
| `v2/sync-client/api.py` | Windows 로컬 API, 트레이, 설치·등록·업데이트 연동 |
| `v2/sync-client/queue_worker.py` | heartbeat, 작업 수신, 수집·업로드 |
| `v2/sync-client/scraper.py` | NRC Playwright 수집 및 원본 필드 파싱 |
| `v2/sync-client/auto_update.py` | 다운로드 검증·교체·정상 시작 확인·복구 |
| `v2/sync-client/work_guard.py` | 업데이트 중 진행 작업 보호 |
| `v2/sync-client/build_release.py` | 별도 환경에서 후보 EXE와 manifest 생성 |
| `v2/cloud-worker/Dockerfile` | Render 패키징. scraper의 `sync_version.py`, `work_guard.py` 의존성 COPY 포함 |

중요 API:

- `GET /devices`: 관리자 전체 / 일반 사용자 본인 PC + 공유 집계.
- `DELETE /devices/<uuid>/registration`: 등록 해제.
- `POST /devices/<uuid>/registration`: 다시 등록.
- `POST /devices/register`: 명시적인 신규·재등록.
- `POST /worker/heartbeat`, `/worker/claim`, `/worker/complete`.
- Windows `GET /health`: release, collectorVersion, deviceId, deviceRevoked, 업데이트 상태.

## 6. DB 적용 상태

운영 DB에 아래 변경을 적용했고, RUN_047은 실제 DB에서 임시 데이터로 테스트 후 rollback했다.

- `v2/supabase/RUN_046_ACCOUNT_RECOVERY_QUIZ.sql`
  - 마이그레이션: `20261108064954_account_recovery_quiz.sql`
- `v2/supabase/RUN_047_PC_REGISTRATION.sql`
  - 마이그레이션: `20261108083355_pc_registration_and_preferred_collection.sql`
  - `revoked_at`, `collector_version`, `preferred_until` 추가.
  - `set_pc_registration`, `start_pc_sync_job`, `complete_pc_sync_job`은 service-role 전용.
  - `claim_cloud_sync_job`은 현재 PC 우선·15초 전환과 해제 상태를 확인한다.
  - `guard_revoked_pc_job` 트리거는 구형 직접 claim 경로도 검사한다.

SQL Editor로 운영 DB에 적용했으며, CLI migration history에 같은 변경이 자동 기록됐다고 가정하면 안 된다.
새 개발 환경에서 운영 DB를 초기화하거나 모든 RUN 파일을 다시 실행하지 않는다. 실제 스키마와 적용 기록을 먼저 확인한다.

## 7. 검증 결과와 재실행 명령

기존 환경에서 다음이 통과했다:

```powershell
npm test --prefix v2/frontend
python -m unittest discover -s v2/sync-client/tests -v
python -m unittest discover -s v2/cloud-worker/tests -v
```

- 프런트엔드: 날짜·마감 계산·실제 0/누락 회선 회귀 검증.
- sync-client: 33개 테스트.
- cloud-worker: 25개 테스트.
- DB: `v2/supabase/tests/pc_registration.sql` — 관리자/본인/다른 사용자 권한, heartbeat 재등록 차단, 해제 후 업로드 차단, 현재 PC 우선, 다른 PC 전환, 구버전 결과 거절, 중복 완료 방지. 임시 데이터는 마지막 rollback으로 제거한다.
- 운영 요청을 실제 현재 PC에 우선 배정해 동일 PC가 가져간 것을 확인했다.
- 새 수집기 완료 결과에서 김정경 `2913195`: 총회선 5, 실회선 5, 본인 매출 0, 정기배송 0, metricsVersion 2를 확인했다. 조직 상세 화면에서도 확인했다.
- 최종 카드 변경 후 매출 8,100 NV를 임시 입력해 재계산을 확인하고 원래 빈 값으로 돌렸다.
- 기능 커밋 `e7b7cc9`의 GitHub Pages workflow success와 운영 화면 반영을 확인했다.

테스트용 환경이 없다면 Windows PC용 의존성은 `v2/sync-client/requirements.txt`, 서버용은 `v2/cloud-worker/requirements.txt`를 각 환경에 설치한다. 프런트엔드는 별도 번들 build 없이 정적 ES modules로 동작한다.

현재 PC에만 있는 참고 이미지(빌드 폴더는 Git 제외이므로 새 clone에는 없다):

- `v2/sync-client/build/pc-management-20261108.png`
- `v2/sync-client/build/manual-card-real-lines.png`

## 8. EXE 빌드·게시 절차

전체 절차는 [installer/README.md](../sync-client/installer/README.md)를 참고한다.

1. Windows x64의 별도 Python 환경을 사용한다. 이번 빌드는 Python 3.12 기반이었다.
2. `requirements-build.txt`의 고정 버전을 공식 PyPI에서 설치한다. 임의 패키지가 섞인 전역 Python으로 배포용 EXE를 만들지 않는다.
3. `sync_version.py`의 release를 증가시키고 collectorVersion을 갱신한다.
4. 해당 환경의 Python으로 `build_release.py`를 실행한다.

```powershell
# 기존의 분리된 빌드 환경이 있는 현재 PC에서 실행하는 예시
& 'v2/sync-client/build/clean-env/Scripts/python.exe' v2/sync-client/build_release.py
```

5. `build/candidate/NRCSync.exe`를 Defender 사용자 지정 검사로 검사한다. 검사 완료 이벤트 및 해당 파일의 탐지 유무를 확인한다. 차단되면 배포하지 않는다.
6. 후보의 크기·SHA-256을 확인하고 실제 시작·설정 보존을 검증한다. 검사한 동일 바이트의 EXE, manifest, 패키지 목록과 검사 기록을 `installer/`에 반영한다.
7. EXE와 manifest를 같은 커밋으로 게시한다. 웹 앱 `SYNC_DOWNLOAD`를 그 커밋의 고정 URL로 변경한다. main URL의 이전 CDN 캐시를 피하기 위해서다.
8. 공개 다운로드의 해시, 새 PC health, 자동 교체 결과를 확인한다.

자동 업데이트 manifest는 `main/v2/sync-client/installer/version.json`을 확인한다. 배포 중단 시 manifest의 `disabled: true`와 웹 앱 다운로드 링크 중단을 함께 적용한다.
GitHub에 EXE를 직접 저장하므로 50MB 권장 크기 경고가 있다. LFS나 별도 릴리스 호스팅으로 옮길 경우 기존 raw 다운로드와 업데이트 코드를 함께 바꿔야 한다.

## 9. 실제 보안 이력과 접근 환경

- 이전 배포 EXE는 Defender가 `Trojan:Win32/Sabsik.FL.A!ml`로 탐지했다. 오탐이라고 단정하지 않았고 당시 배포를 중단했다.
- 분리된 환경에서 다시 빌드한 현재 EXE는 2026-11-08 17:41:38 KST 후보 검사, 17:48:51 KST 설치 경로 재검사에서 탐지가 없었다. 실제 교체·시작도 확인했다.
- 이 결과는 그 시점의 로컬 Defender 검사 결과이며 모든 보안 제품/미래 판정을 보증하지 않는다. 격리 복원, 제외 추가, 보호 해제는 하지 않는다.
- 현재 사용한 Supabase MCP 연결에는 다른 프로젝트만 노출됐다. NRC 운영 DB 변경은 이미 로그인된 Supabase 대시보드에서 수행했다.
- Supabase CLI의 원격 advisors는 로그인 토큰이 없어 실행되지 않았다. 대시보드 Advisor Center와 이번 변경의 DB 권한 테스트를 확인했다. 기존 프로젝트에는 RLS 성능·기존 함수 등의 경고가 있으며, 전체 프로젝트의 경고를 모두 해결했다고 보고하지 않았다.
- 새 Claude Code에서는 GitHub/Supabase/Render 인증 연결을 별도로 확인한다. 기존 브라우저 로그인이나 Codex 커넥터가 자동으로 전달된다고 가정하지 않는다.
- service-role 키·암호화 키는 Render 환경 변수, PC 갱신 토큰·NRC 로컬 자격 증명은 Windows 자격 증명 저장소에 있다. 이 문서에는 비밀 값을 기록하지 않았다.
- 현재 공유 수집 구조는 승인한 NRC 자격 증명을 서버에 암호화해 보관하고 작업 때 승인 PC에 전달한다. 과거 문서의 “NRC 비밀번호는 서버에 전혀 저장하지 않는다”는 설명은 현재 공유 PC 구조와 다르다.
- `NRC_CREDENTIAL_ENCRYPTION_KEY`를 새로 생성하면 기존 암호문을 읽지 못할 수 있다. 기존 운영 키를 유지한다.

## 10. 이어서 시작할 순서

1. 이 폴더에서 Claude Code를 열고 루트 `CLAUDE.md`와 이 문서를 읽는다.
2. `git status`, 최근 커밋, origin/main 상태를 확인한다. 사용자 변경을 덮어쓰지 않는다.
3. 필요한 서비스 연결과 기존 운영 환경 변수를 확인한다. 비밀 값은 출력하거나 문서에 복사하지 않는다.
4. 위 테스트를 재실행하고 운영 `/health` 및 로컬 `/health`를 확인한다.
5. 다음 사용자 요청을 받아 작업한다. 현재 요청된 PC 관리·우선 배정·회선 수정·마감 카드 변경은 완료됐다.
6. 다른 수집 PC의 설치 상태는 별도로 확인한다. 구버전 PC를 자동으로 모두 갱신·해제했다고 가정하지 않는다.

Claude Code에 전달할 시작 문장:

> CLAUDE.md와 v2/docs/CLAUDE_CODE_HANDOFF_2026-11-08.md를 먼저 읽어줘. git 상태와 최근 커밋, 운영/로컬 health를 확인한 다음 현재 구조를 유지하면서 다음 작업을 이어가자. 운영 DB 초기화나 등록 PC 임의 해제는 하지 마.
