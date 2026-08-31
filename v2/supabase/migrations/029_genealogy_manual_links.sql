begin;

-- 앤텔레콤 사이트는 계보를 10단계까지만 보여주고, 그 위쪽 경로는 아무 데서도
-- 조회할 수 없다. 활동하는 사람이 없어 끊긴 구간을 화면에서만이라도 이어
-- 보이게 하는 수동 연결 테이블. 실적/NV 집계에는 관여하지 않는다.
create table if not exists public.genealogy_manual_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  member_id text not null,
  member_name text not null,
  parent_id text not null,
  note text,
  created_at timestamptz not null default now(),
  unique(owner_id, member_id)
);

create index if not exists genealogy_manual_links_owner_idx
  on public.genealogy_manual_links(owner_id);

alter table public.genealogy_manual_links enable row level security;

drop policy if exists genealogy_manual_links_owner_all on public.genealogy_manual_links;
create policy genealogy_manual_links_owner_all on public.genealogy_manual_links
  for all using(owner_id=auth.uid() or public.is_app_admin())
  with check(owner_id=auth.uid() or public.is_app_admin());

grant select, insert, update, delete on public.genealogy_manual_links to authenticated;

commit;
