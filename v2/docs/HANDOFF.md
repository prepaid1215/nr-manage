# NRC Management v2 작업 인수인계

마지막 업데이트: 2026-08-29

## 시작 방법

```powershell
git clone https://github.com/prepaid1215/nr-manage.git
cd nr-manage
```

이미 저장소가 있으면 `git pull origin main`을 실행한다.

- 운영 화면: https://prepaid1215.github.io/nr-manage/v2/frontend/
- Supabase 프로젝트: `ymagjzwebshfnjiisrao`
- 프런트엔드: `v2/frontend`
- DB 마이그레이션: `v2/supabase/migrations`
- PC 수집 프로그램 소스: `v2/sync-client`

## 현재 구현 완료

- 아이디/비밀번호 회원가입 및 로그인
- Supabase RLS 기반 본인/하위/팀 공유 권한 구조
- PC Playwright NRC 10단계 JSON 수집 및 예약 수집
- 조직 목록, 계보도, 회원별 본인 NV/서브1/서브2/대실적/소실적
- 고객 등록/수정/삭제, 내 고객/공유 고객
- 충전 알림, 약정 만료, 문자, VCF 연락처 저장
- 카톡 문자 자동입력, 캡처 OCR, 카톡 백업 일괄등록
- 고객 CSV/VCF/JSON 백업 및 중복 방지 JSON 복원
- 활동 탭 일일업무일지와 날짜별 Supabase 저장

## Supabase에서 실행할 SQL

새 환경에서는 아래 마이그레이션을 번호순으로 확인하고 실행한다.

1. `001_team_permissions.sql`
2. `002_protected_business_tables.sql`
3. `003_self_signup.sql`
4. `004_simple_app_account.sql`
5. `005_local_sync_snapshots.sql`
6. `006_authenticated_table_grants.sql`
7. `007_customer_registration_fields.sql`

화면에 `permission denied for table ...`가 나오면 `006_authenticated_table_grants.sql`을 실행한다.

## 보안 원칙

- 하위 사업자는 상위 사업자를 볼 수 없다.
- 파트너끼리는 기본적으로 서로 볼 수 없다.
- 명시적인 팀 또는 공유 허용이 있을 때만 데이터 공유가 가능하다.
- NRC 홈페이지 비밀번호는 Supabase에 저장하지 않는다.
- 예약 수집 비밀번호는 PC의 Windows 자격 증명 저장소에만 저장한다.
- Supabase service role key를 프런트엔드에 넣지 않는다.

## 다음 작업

1. 활동 기록의 일/주/월/연간 통계와 그래프
2. 체크리스트 화면 및 진행률 통계
3. 마감매출 입력과 연간 요약
4. 수당 입력과 월/연간 통계
5. 목표 20/20, 40/40, 80/80 부족분 및 최적 매출 배치 계산
6. 모바일 앱(PWA/패키징) 마무리

## Codex에 전달할 첫 문장

`v2/docs/HANDOFF.md를 먼저 읽고, 저장소의 현재 상태와 최근 커밋을 확인한 다음 다음 작업을 이어서 진행해줘.`

