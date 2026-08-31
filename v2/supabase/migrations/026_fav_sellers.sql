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
