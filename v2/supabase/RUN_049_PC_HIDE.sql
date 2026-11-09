-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 수집 PC 목록의 "삭제"용 표시 칸입니다. 행은 지우지 않고 목록에서만 숨깁니다.
-- (등록 해제 기록을 물리 삭제하면 구버전 프로그램이 같은 PC를 다시 등록할 수 있어서 행은 그대로 둡니다.)
-- 여러 번 실행해도 안전합니다.

begin;

alter table public.nrc_sync_devices add column if not exists hidden_at timestamptz;

commit;
