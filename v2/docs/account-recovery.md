# 아이디·비밀번호 복구

2026-11-08 구현. 프런트엔드와 기존 Render 수집 서버를 사용한다. Supabase Edge Function이나 새 외부 서비스는 필요 없다.

## 사용 흐름

- 신규 회원: 가입할 때 질문·답·답 확인을 입력한다. Auth 가입 후 로그인된 세션으로 서버에 퀴즈를 저장한다. 퀴즈 저장만 실패하면 가입 성공과 퀴즈 미등록 상태를 구분해 안내한다.
- 기존 회원: 설정 → 계정 → 복구 퀴즈에서 현재 비밀번호를 확인하고 등록·변경한다.
- 아이디 찾기: 이름·회원번호·등록한 질문·답이 일치하면 아이디를 표시한다.
- 비밀번호 재설정: 아이디·회원번호·질문·답 확인 후 새 비밀번호를 저장한다. 기존 비밀번호는 조회하지 않는다.
- 관리자 초기화: 오류확인 → 가입자 현황 → 비밀번호 초기화. 관리자 본인의 현재 비밀번호를 확인한 후 무작위 임시 비밀번호를 발급한다. 이 창에서만 확인·복사하고 회원에게 직접 전달한다. 닫으면 화면의 임시 비밀번호도 지운다.
- 임시 비밀번호로 로그인한 회원에게는 업무 화면을 열기 전에 새 비밀번호 설정을 요구한다. 변경 후 로그아웃하고 새 비밀번호로 로그인한다. 퀴즈를 등록하지 않은 회원도 관리자 초기화로 복구할 수 있다.

## 배포 순서

1. **NRC 프로젝트 `ymagjzwebshfnjiisrao`**의 SQL Editor에서 `v2/supabase/RUN_046_ACCOUNT_RECOVERY_QUIZ.sql`을 한 번 실행한다. 다른 프로젝트에 실행하지 않는다.
2. `v2/cloud-worker` 변경을 기존 Render 서비스 `nrc-sync-cloud-sg`에 배포한다. Dockerfile에 새 모듈 복사가 포함되어 있다. 기존 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ORIGIN`을 사용하며 새 비밀키는 필요 없다.
3. 서버와 DB가 준비된 후 `v2/frontend`를 GitHub Pages에 배포한다. 이번 캐시 버전은 `20261108-1`이다.
4. 테스트 계정으로 가입·퀴즈 등록·찾기와 관리자 초기화·새 비밀번호 변경을 확인한다.

2026-11-08 NRC 운영 DB에 SQL을 적용하고 Render에 서버 커밋 `c92cf25`를 배포했다. 연결된 Supabase 도구의 프로젝트 범위가 달라, 로그인된 NRC 관리 대시보드에서 적용했다. 운영 DB의 RLS·권한 검사와 운영 API의 미로그인 차단·비회원 복구 차단·CORS 검사를 통과했다. 프런트엔드 배포 버전은 `20261108-1`이다. 실제 회원의 비밀번호는 검증 과정에서 변경하지 않았다.

## 서버 보호

- 퀴즈 답은 임의의 salt와 scrypt(N=16384, r=8, p=1)로 해시한다. 앞뒤 공백, 연속 공백, NFKC 문자 표현, 영문 대소문자를 정규화한다. 원문 답을 Auth metadata·프로필·로그에 저장하지 않는다.
- 질문·답 해시 테이블은 RLS를 켜고 `anon`, `authenticated`, `PUBLIC` 권한을 모두 회수한다. 앱 관리자도 브라우저에서 해시를 읽을 수 없다. 서버의 service role만 사용한다.
- 기존 운영 DB에는 service role의 프로필 조회·감사 로그 기록 권한이 없었다. 복구에 필요한 프로필 열의 조회와 감사 로그 열의 INSERT·ID 시퀀스 사용만 명시적으로 허용했다.
- 회원번호별 15분에 5회, 접속 주소별 15분에 30회까지 시도할 수 있다. 아이디 찾기·비밀번호 재설정은 같은 회원번호 제한을 공유한다. 카운터는 DB에서 원자적으로 갱신하므로 서버 재시작으로 초기화되지 않는다.
- 관리자 권한은 사용자 편집 가능 metadata가 아닌 `app_admins`의 실제 행으로 검사한다. 정지 계정·자기 계정 초기화는 차단한다. 초기화 전후 `audit_logs`에 관리자·대상·결과만 남긴다.
- 임시 비밀번호 변경 여부는 서버 전용 Auth `app_metadata.recovery_password_required`로 관리한다. 앱 시작 시 서버의 현재 사용자 정보를 확인하고 변경 화면을 먼저 연다. 클라이언트 metadata 변경으로 해제할 수 없다. 이는 앱 진입 흐름의 제한이며 기존의 모든 DB RPC에 별도 비밀번호 변경 검사를 추가한 것은 아니다.
- 비밀번호 변경에는 Supabase Auth의 관리자 업데이트 API를 사용한다. 이 API는 갱신 가능한 세션을 폐기한다. 이미 발급된 단기 JWT가 만료 전에 즉시 무효화된다고 가정하지 않는다.
- 비밀번호 확인에 사용한 별도 로그인 세션은 즉시 local 범위로 로그아웃한다. 복구 API 응답은 `Cache-Control: no-store`이다.
- Render의 마지막 프록시가 추가한 `X-Forwarded-For` 마지막 주소를 접속 제한 키로 사용한다. 프록시 구조가 바뀌면 이 신뢰 경계를 다시 확인한다.

## 검증

```powershell
python -m unittest discover -s v2/cloud-worker/tests -v
npm test --prefix v2/frontend
python v2/cloud-worker/tests/browser_account_recovery.py
```

브라우저 검증은 Python Playwright와 설치된 Microsoft Edge를 사용한다. 실제 프런트엔드 모듈과 Flask 복구 API를 연결하되 Auth·DB 전송만 테스트 어댑터로 대체한다. 운영 계정은 읽거나 변경하지 않는다.

DB 권한과 카운터는 별도의 임시 PGlite PostgreSQL 엔진으로 검증한다.

```powershell
npm install --prefix "$env:TEMP/nrc-recovery-check" --no-package-lock --no-save @electric-sql/pglite
node v2/supabase/tests/account_recovery.test.cjs "$env:TEMP/nrc-recovery-check"
```

테스트 어댑터와 로컬 PostgreSQL 엔진의 검증은 배포된 Supabase Auth/Render 환경에서의 최종 실사용 검증을 대신하지 않는다.
