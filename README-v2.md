# NRC Management System

기획안 1.0을 기준으로 처음부터 다시 만든 모듈형 NRC 사업관리 시스템입니다. 운영 백엔드는 Supabase를 사용합니다.

## 구조

- `frontend/`: 모바일 우선 웹 UI
- `supabase/`: PostgreSQL 스키마, RLS 권한, 예제 데이터와 검증 SQL
- `backend/`: 초기 Google Apps Script 실험본(참고용, 운영 미사용)
- `docs/`: 요구사항과 API 문서

## Supabase 최초 설정

1. Supabase 프로젝트를 만들고 SQL Editor에서 `supabase/migrations/001_team_permissions.sql`을 실행합니다.
2. 이어서 `002_protected_business_tables.sql`을 실행합니다.
3. Authentication에서 사용자를 만들고 `seed.example.sql`의 UUID 자리표시자를 실제 UUID로 바꿔 실행합니다.
4. `frontend/team-permissions.html`에서 Project URL과 publishable key로 연결합니다.
5. 팀 소유자 계정으로 로그인하여 대상별 공유 범위를 설정합니다.

비밀번호와 세션은 Supabase Auth가 관리합니다. 업무 데이터 접근은 프론트엔드가 아니라 PostgreSQL RLS가 차단합니다.
