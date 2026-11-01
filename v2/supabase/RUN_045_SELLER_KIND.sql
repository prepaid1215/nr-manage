-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 매출자 표시를 두 종류로 나눕니다: 매출자(매출만 올려 주는 박스) / 수당매출자(수당이 생겨 사업자에게 넘기는 박스).
-- 기존 표시는 모두 "매출자"로 남습니다. (이 SQL이 없으면 앱은 구분 칸 없이 기존 방식 그대로 동작합니다)
-- 먼저 RUN_040을 실행한 상태여야 합니다.

begin;

alter table public.nrc_seller_marks
  add column if not exists kind text not null default 'seller';
alter table public.nrc_seller_marks
  drop constraint if exists nrc_seller_marks_kind_check;
alter table public.nrc_seller_marks
  add constraint nrc_seller_marks_kind_check check (kind in ('seller', 'income'));

grant update on public.nrc_seller_marks to authenticated;

commit;
