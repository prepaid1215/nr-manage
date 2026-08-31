-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 소비자관리 고객 등록 화면의 "자주 쓰는 매출자" 즐겨찾기를 계정(아이디)별로
-- 저장하기 위한 테이블입니다.

begin;

create table if not exists public.fav_sellers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  member_no text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique(owner_id, member_no)
);

create index if not exists fav_sellers_owner_idx
  on public.fav_sellers(owner_id, created_at);

alter table public.fav_sellers enable row level security;
drop policy if exists fav_sellers_owner_all on public.fav_sellers;
create policy fav_sellers_owner_all on public.fav_sellers
  for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());

grant select, insert, update, delete on public.fav_sellers to authenticated;

commit;
