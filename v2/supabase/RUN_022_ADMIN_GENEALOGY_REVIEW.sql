begin;

create or replace function public.admin_user_latest_snapshot(p_user_id uuid)
returns table(
  source_account_id text,
  payload jsonb,
  collected_at timestamptz
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
  select s.source_account_id, s.payload, s.collected_at
  from public.nrc_sync_snapshots s
  where s.owner_id=p_user_id and s.snapshot_type='combined'
  order by s.collected_at desc
  limit 1;
end
$$;

create or replace function public.admin_user_closing_plans(p_user_id uuid)
returns table(
  top_member_id text,
  top_major_target numeric,
  top_minor_target numeric,
  top_major_nv numeric,
  top_minor_nv numeric,
  top_completed_nv numeric,
  status text,
  completed_at timestamptz,
  updated_at timestamptz
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
  select p.top_member_id, p.top_major_target, p.top_minor_target,
    p.top_major_nv, p.top_minor_nv, p.top_completed_nv,
    p.status, p.completed_at, p.updated_at
  from public.nrc_closing_plans p
  where p.owner_id=p_user_id
  order by p.updated_at desc;
end
$$;

revoke all on function public.admin_user_latest_snapshot(uuid) from public;
revoke all on function public.admin_user_closing_plans(uuid) from public;
grant execute on function public.admin_user_latest_snapshot(uuid) to authenticated;
grant execute on function public.admin_user_closing_plans(uuid) to authenticated;

commit;
