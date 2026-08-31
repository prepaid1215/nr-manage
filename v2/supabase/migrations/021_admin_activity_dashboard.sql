begin;

create table if not exists public.app_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_at timestamptz not null default now()
);

create table if not exists public.app_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  page text,
  action text,
  detail jsonb not null default '{}'::jsonb,
  app_version text,
  created_at timestamptz not null default now()
);

create index if not exists app_events_user_created_idx
  on public.app_events(user_id, created_at desc);
create index if not exists app_events_type_created_idx
  on public.app_events(event_type, created_at desc);

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.app_admins where user_id=auth.uid())
$$;

alter table public.app_admins enable row level security;
alter table public.app_events enable row level security;

drop policy if exists app_events_own_insert on public.app_events;
drop policy if exists app_events_admin_read on public.app_events;
create policy app_events_own_insert on public.app_events
  for insert with check(user_id=auth.uid());
create policy app_events_admin_read on public.app_events
  for select using(public.is_app_admin());

drop policy if exists profiles_admin_read on public.profiles;
create policy profiles_admin_read on public.profiles
  for select using(public.is_app_admin());

create or replace function public.admin_user_overview()
returns table(
  user_id uuid,
  username text,
  name text,
  member_no text,
  status text,
  joined_at timestamptz,
  last_seen_at timestamptz,
  event_count bigint,
  last_page text,
  last_snapshot_at timestamptz,
  draft_plan_count bigint,
  done_plan_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    raise exception 'admin access required';
  end if;
  return query
  select p.id, p.username, p.name, p.member_no, p.status, p.created_at,
    ev.last_seen_at, coalesce(ev.event_count,0), ev.last_page,
    sn.last_snapshot_at, coalesce(pl.draft_count,0), coalesce(pl.done_count,0)
  from public.profiles p
  left join lateral (
    select max(e.created_at) last_seen_at, count(*) event_count,
      (array_agg(e.page order by e.created_at desc) filter(where e.page is not null))[1] last_page
    from public.app_events e where e.user_id=p.id
  ) ev on true
  left join lateral (
    select max(s.collected_at) last_snapshot_at
    from public.nrc_sync_snapshots s where s.owner_id=p.id
  ) sn on true
  left join lateral (
    select count(*) filter(where c.status='DRAFT') draft_count,
      count(*) filter(where c.status='DONE') done_count
    from public.nrc_closing_plans c where c.owner_id=p.id
  ) pl on true
  order by ev.last_seen_at desc nulls last, p.created_at desc;
end
$$;

create or replace function public.admin_recent_events(p_limit integer default 200)
returns table(
  event_id bigint,
  user_id uuid,
  username text,
  user_name text,
  event_type text,
  page text,
  action text,
  detail jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    raise exception 'admin access required';
  end if;
  return query
  select e.id, e.user_id, p.username, p.name, e.event_type, e.page,
    e.action, e.detail, e.created_at
  from public.app_events e
  join public.profiles p on p.id=e.user_id
  order by e.created_at desc
  limit least(greatest(coalesce(p_limit,200),1),1000);
end
$$;

revoke all on table public.app_admins from anon, authenticated;
revoke all on table public.app_events from anon;
grant insert, select on table public.app_events to authenticated;
grant usage, select on sequence public.app_events_id_seq to authenticated;
revoke all on function public.is_app_admin() from public;
revoke all on function public.admin_user_overview() from public;
revoke all on function public.admin_recent_events(integer) from public;
grant execute on function public.is_app_admin() to authenticated;
grant execute on function public.admin_user_overview() to authenticated;
grant execute on function public.admin_recent_events(integer) to authenticated;

do $$
declare v_admin_id uuid;
begin
  select id into v_admin_id from public.profiles
  where lower(username)=lower('bisangharu') limit 1;
  if v_admin_id is null then
    select id into v_admin_id from auth.users
    where lower(email)=lower('app-bisangharu@nrc-members.com')
       or lower(coalesce(raw_user_meta_data->>'username',''))=lower('bisangharu')
    limit 1;
  end if;
  if v_admin_id is null then
    raise exception '관리자 앱 아이디 bisangharu를 Auth 사용자에서도 찾지 못했습니다.';
  end if;
  insert into public.profiles(id,username,name,status)
  select v_admin_id, 'bisangharu',
    coalesce(nullif(raw_user_meta_data->>'name',''), '관리자'), 'ACTIVE'
  from auth.users where id=v_admin_id
  on conflict(id) do update set
    username=coalesce(public.profiles.username, excluded.username),
    updated_at=now();
  insert into public.app_admins(user_id) values(v_admin_id)
  on conflict(user_id) do nothing;
end
$$;

commit;
