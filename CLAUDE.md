# NRC 사업관리 프로그램

작업을 시작할 때 다음 문서를 먼저 읽는다.

1. [최신 인계 문서 — 2026-11-08](v2/docs/CLAUDE_CODE_HANDOFF_2026-11-08.md)
2. [기존 작업 기록](v2/docs/HANDOFF.md)
3. 기능에 따라 `v2/docs/account-recovery.md`, `v2/docs/line-metrics.md`, `v2/docs/closing-calculator.md`

## 현재 구조

- 운영 코드는 `v2/`에 있다. 웹 화면은 프레임워크 없는 HTML/CSS/JavaScript ES modules다.
- `v2/frontend`: GitHub Pages 웹 앱.
- `v2/cloud-worker`: Render의 인증·작업 배정·결과 저장 API.
- `v2/sync-client`: 승인된 Windows PC에서 실제 NRC 수집을 실행하는 Python/Playwright 프로그램.
- `v2/supabase`: 운영 DB 변경 SQL, 마이그레이션, DB 검증 SQL.
- 실제 브라우저 수집은 승인된 Windows PC에서 한다. Render의 `RUN_BROWSER_WORKER`는 운영상 `false`다.

## 유지할 동작

- 수집을 요청한 현재 노트북/PC의 NRC Sync를 먼저 사용한다. 대기 중 15초 안에 응답하지 않으면 다른 승인 PC로 넘긴다.
- 일반 사용자는 본인 PC, 관리자는 전체 PC를 등록 해제·다시 등록할 수 있다. 해제 기록을 물리 삭제해 자동 재등록을 허용하면 안 된다.
- 회선의 실제 `0`과 수집되지 않은 값을 구분한다. 구버전 수집 결과로 정상 회선 값을 덮어쓰면 안 된다.
- 마감 계산 박스에는 서브1·서브2와 실회선을 표시한다. 대실적·소실적 계산 자체는 내부에서 계속 사용한다.

## 개발·배포 주의사항

- 먼저 `git status`와 최근 커밋을 확인하고 사용자 변경을 보존한다.
- 운영 DB에는 RUN_046, RUN_047 변경이 적용돼 있다. 전체 SQL 재실행이나 DB 초기화를 하지 않는다.
- 프런트엔드 변경 시 실제 수정 모듈의 import `?v=`와 `index.html`의 앱 버전을 함께 갱신한다.
- Windows EXE는 `requirements-build.txt`로 만든 별도 환경에서 `build_release.py`로 빌드한다. 후보 파일의 Defender 검사와 해시 검증 후 동일한 파일만 게시한다.
- 이전 EXE에 실제 Defender 탐지가 있었다. 격리 복원·백신 예외 추가·보호 해제는 하지 않는다.
- 계정 비밀번호, 갱신 토큰, service-role 키, 암호화 키를 소스·문서·로그에 넣지 않는다. 기존 암호화 키를 재생성하면 저장된 승인정보를 복호화하지 못할 수 있다.
- 사용자에게 특정 PC 해제를 요청받기 전에는 실제 등록 PC를 임의로 해제하지 않는다.

테스트와 배포 절차, 현재 버전·알려진 제한은 최신 인계 문서에 있다.
