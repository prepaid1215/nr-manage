begin;

create extension if not exists pgcrypto;

create type public.team_role as enum ('OWNER','MANAGER','MEMBER','VIEWER');
create type public.share_resource as enum ('customers','activity','checklist','sales_summary','performance','organization_summary','commission','closing_sales','private_memo');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  member_no text not null unique,
  name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references public.profiles(id),
  invite_code_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.team_role not null default 'MEMBER',
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (team_id,user_id)
);

-- 계보가 아니라 실제 운영상 관리 관계다. 하위는 이 관계만으로 상위를 볼 수 없다.
create table public.management_relations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  manager_id uuid not null references public.profiles(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(team_id,manager_id,member_id),
  check(manager_id <> member_id)
);

-- 같은 팀이어도 이 레코드가 없으면 다른 사람의 데이터는 보이지 않는다.
create table public.sharing_grants (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  resource public.share_resource not null,
  can_read boolean not null default true,
  can_write boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(team_id,viewer_id,owner_id,resource),
  check(viewer_id <> owner_id)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  team_id uuid references public.teams(id),
  action text not null,
  target_type text not null,
  target_id text,
  result text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index team_members_user_idx on public.team_members(user_id) where active;
create index sharing_grants_lookup_idx on public.sharing_grants(viewer_id,owner_id,resource) where can_read;
create index management_relations_manager_idx on public.management_relations(team_id,manager_id);

create or replace function public.is_team_owner(p_team_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.teams t where t.id=p_team_id and t.owner_id=auth.uid() and t.active)
$$;

create or replace function public.can_access_owner(p_owner_id uuid,p_resource public.share_resource,p_write boolean default false)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid()=p_owner_id or exists(
    select 1
      from public.sharing_grants g
      join public.team_members viewer on viewer.team_id=g.team_id and viewer.user_id=auth.uid() and viewer.active
      join public.team_members owner_m on owner_m.team_id=g.team_id and owner_m.user_id=p_owner_id and owner_m.active
     where g.viewer_id=auth.uid() and g.owner_id=p_owner_id and g.resource=p_resource
       and g.can_read and (not p_write or g.can_write)
       and g.valid_from<=now() and (g.valid_until is null or g.valid_until>now())
  )
$$;

create or replace function public.is_team_owner_of_member(p_user_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.teams t
    join public.team_members m on m.team_id=t.id and m.user_id=p_user_id and m.active
    where t.owner_id=auth.uid() and t.active
  )
$$;

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.management_relations enable row level security;
alter table public.sharing_grants enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_self_or_granted on public.profiles for select using (
  id=auth.uid() or public.is_team_owner_of_member(id) or public.can_access_owner(id,'organization_summary',false)
);
create policy profiles_self_update on public.profiles for update using(id=auth.uid()) with check(id=auth.uid());

create policy teams_member_read on public.teams for select using (
  exists(select 1 from public.team_members m where m.team_id=id and m.user_id=auth.uid() and m.active)
);
create policy teams_owner_manage on public.teams for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());

create policy team_members_visible_to_same_team on public.team_members for select using (
  user_id=auth.uid() or public.is_team_owner(team_id) or exists(
    select 1 from public.sharing_grants g where g.team_id=team_members.team_id and g.viewer_id=auth.uid() and g.owner_id=team_members.user_id and g.resource='organization_summary' and g.can_read
  )
);
create policy team_members_owner_manage on public.team_members for all using(public.is_team_owner(team_id)) with check(public.is_team_owner(team_id));

create policy relations_allowed_read on public.management_relations for select using (
  manager_id=auth.uid() or public.is_team_owner(team_id)
);
create policy relations_owner_manage on public.management_relations for all using(public.is_team_owner(team_id)) with check(public.is_team_owner(team_id));

create policy grants_participant_read on public.sharing_grants for select using (
  viewer_id=auth.uid() or owner_id=auth.uid() or public.is_team_owner(team_id)
);
create policy grants_owner_manage on public.sharing_grants for all using(public.is_team_owner(team_id)) with check(public.is_team_owner(team_id));

create policy logs_actor_read on public.audit_logs for select using(actor_id=auth.uid() or (team_id is not null and public.is_team_owner(team_id)));

revoke all on function public.is_team_owner(uuid) from public;
revoke all on function public.can_access_owner(uuid,public.share_resource,boolean) from public;
revoke all on function public.is_team_owner_of_member(uuid) from public;
grant execute on function public.is_team_owner(uuid) to authenticated;
grant execute on function public.can_access_owner(uuid,public.share_resource,boolean) to authenticated;
grant execute on function public.is_team_owner_of_member(uuid) to authenticated;

commit;
