begin;

-- 사업자 / 매출자 구분: 내 계보 아래에서 "매출자"(사업을 하지 않고 수당을 사업자에게 넘기는 가족회원)로
-- 내가 직접 표시한 회원번호를 저장한다. 표시는 내 계정에서만 보이고 쓸 수 있다.
create table if not exists public.nrc_seller_marks (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  member_no text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, member_no)
);

alter table public.nrc_seller_marks enable row level security;
drop policy if exists nrc_seller_marks_owner_all on public.nrc_seller_marks;
create policy nrc_seller_marks_owner_all on public.nrc_seller_marks
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, delete on public.nrc_seller_marks to authenticated;

commit;
