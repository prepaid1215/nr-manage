begin;

-- 매출자 표시를 두 종류로 나눈다.
--  seller = 매출자: 매출(NV)만 올려 주는 박스 (수당 계산에서 제외)
--  income = 수당매출자: 수당이 생기고 그 수당을 사업자에게 넘기는 박스 (6만 NV·장려금 계산 대상)
-- 기존 표시는 모두 seller 로 남는다.
alter table public.nrc_seller_marks
  add column if not exists kind text not null default 'seller';
alter table public.nrc_seller_marks
  drop constraint if exists nrc_seller_marks_kind_check;
alter table public.nrc_seller_marks
  add constraint nrc_seller_marks_kind_check check (kind in ('seller', 'income'));

grant update on public.nrc_seller_marks to authenticated;

commit;
