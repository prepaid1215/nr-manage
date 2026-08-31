begin;

-- 관리자 화면에서 가입자별 수집 성공/실패 횟수를 볼 수 있게 admin_user_overview를 확장한다.
drop function if exists public.admin_user_overview();

create function public.admin_user_overview()
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
  collection_count bigint,
  job_success_count bigint,
  job_error_count bigint,
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
    sn.last_snapshot_at, coalesce(sn.collection_count,0),
    coalesce(jb.success_count,0), coalesce(jb.error_count,0),
    coalesce(pl.draft_count,0), coalesce(pl.done_count,0)
  from public.profiles p
  left join lateral (
    select max(e.created_at) last_seen_at, count(*) event_count,
      (array_agg(e.page order by e.created_at desc) filter(where e.page is not null))[1] last_page
    from public.app_events e where e.user_id=p.id
  ) ev on true
  left join lateral (
    select max(s.collected_at) last_snapshot_at, count(*) collection_count
    from public.nrc_sync_snapshots s where s.owner_id=p.id
  ) sn on true
  left join lateral (
    select count(*) filter(where j.status='SUCCESS') success_count,
      count(*) filter(where j.status='ERROR') error_count
    from public.nrc_sync_jobs j where j.owner_id=p.id
  ) jb on true
  left join lateral (
    select count(*) filter(where c.status='DRAFT') draft_count,
      count(*) filter(where c.status='DONE') done_count
    from public.nrc_closing_plans c where c.owner_id=p.id
  ) pl on true
  order by ev.last_seen_at desc nulls last, p.created_at desc;
end
$$;

revoke all on function public.admin_user_overview() from public;
grant execute on function public.admin_user_overview() to authenticated;

commit;
