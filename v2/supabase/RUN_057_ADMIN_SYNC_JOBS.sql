-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요. 새 함수 하나만 만들고 기존 표는 바꾸지 않습니다.
-- 오류확인 화면의 "최근 수집 작업"용: 수집 작업마다 누가 요청했고 어느 PC가 처리했는지, 성공/실패와 오류 내용을 돌려줍니다.
-- 관리자(is_app_admin)만 호출할 수 있습니다. 여러 번 실행해도 안전합니다.
-- 해제된 PC도 기록이 남아 있으므로 이름이 그대로 나옵니다(device_revoked로 구분).
-- 처리 PC는 옛 방식(claimed_by)과 현재 방식(cloud_worker_id의 'pc-pool:계정ID:PC ID')을 모두 읽습니다.

create or replace function public.admin_recent_sync_jobs(p_limit integer default 100, p_only_failed boolean default false)
returns table(
  job_id uuid,
  requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  status text,
  message text,
  error text,
  requester_id uuid,
  requester_name text,
  requester_username text,
  source_account_id text,
  device_id uuid,
  device_name text,
  device_owner_name text,
  device_revoked boolean,
  worker_type text
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
  select j.id, j.requested_at, j.started_at, j.completed_at, j.status,
    left(j.message, 300), left(j.error, 500),
    p.id, p.name, p.username, j.source_account_id,
    d.id, d.device_name, dp.name, (d.revoked_at is not null), j.worker_type
  from public.nrc_sync_jobs j
  left join public.profiles p on p.id = j.owner_id
  left join public.nrc_sync_devices d on d.id = coalesce(
    j.claimed_by,
    case when j.cloud_worker_id ~ '^pc-pool:[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}$'
      then split_part(j.cloud_worker_id, ':', 3)::uuid end)
  left join public.profiles dp on dp.id = d.owner_id
  where (not coalesce(p_only_failed, false) or j.status = 'ERROR')
    and j.status in ('SUCCESS', 'ERROR', 'RUNNING', 'CLAIMED', 'CANCELLED')
  order by j.requested_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
end
$$;

revoke all on function public.admin_recent_sync_jobs(integer, boolean) from public;
grant execute on function public.admin_recent_sync_jobs(integer, boolean) to authenticated;
notify pgrst, 'reload schema';

-- 확인: 관리자 계정으로 로그인한 상태가 아니면 SQL Editor에서는 'admin access required' 오류가 나는 것이 정상입니다.
select proname, pronargs from pg_proc where proname = 'admin_recent_sync_jobs';
