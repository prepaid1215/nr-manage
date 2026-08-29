-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 여러 PC의 온라인 상태와 수집 작업 대기열을 사용자별로 안전하게 관리합니다.

begin;

create table if not exists public.nrc_sync_devices (
  id uuid primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  device_name text not null,
  source_account_id text not null,
  status text not null default 'OFFLINE'
    check (status in ('ONLINE','BUSY','OFFLINE','ERROR')),
  last_seen_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists nrc_sync_devices_owner_seen
  on public.nrc_sync_devices(owner_id,last_seen_at desc);

create table if not exists public.nrc_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  source_account_id text,
  target_device_id uuid references public.nrc_sync_devices(id) on delete set null,
  claimed_by uuid references public.nrc_sync_devices(id) on delete set null,
  status text not null default 'QUEUED'
    check (status in ('QUEUED','CLAIMED','RUNNING','SUCCESS','ERROR','CANCELLED')),
  message text,
  error text,
  snapshot_id bigint references public.nrc_sync_snapshots(id) on delete set null,
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists nrc_sync_jobs_owner_requested
  on public.nrc_sync_jobs(owner_id,requested_at desc);
create index if not exists nrc_sync_jobs_claimable
  on public.nrc_sync_jobs(owner_id,status,requested_at)
  where status='QUEUED';

alter table public.nrc_sync_devices enable row level security;
alter table public.nrc_sync_jobs enable row level security;

drop policy if exists nrc_sync_devices_owner_all on public.nrc_sync_devices;
create policy nrc_sync_devices_owner_all on public.nrc_sync_devices
  for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());

drop policy if exists nrc_sync_jobs_owner_all on public.nrc_sync_jobs;
create policy nrc_sync_jobs_owner_all on public.nrc_sync_jobs
  for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());

grant select,insert,update,delete on public.nrc_sync_devices to authenticated;
grant select,insert,update,delete on public.nrc_sync_jobs to authenticated;

create or replace function public.claim_nrc_sync_job(p_device_id uuid)
returns setof public.nrc_sync_jobs
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_owner_id uuid;
  v_source_account_id text;
  v_job_id uuid;
begin
  select owner_id,source_account_id into v_owner_id,v_source_account_id
  from public.nrc_sync_devices
  where id=p_device_id and owner_id=auth.uid();

  if v_owner_id is null then
    raise exception '등록되지 않은 수집 PC입니다.';
  end if;

  select id into v_job_id
  from public.nrc_sync_jobs
  where owner_id=v_owner_id
    and status='QUEUED'
    and (target_device_id is null or target_device_id=p_device_id)
    and (source_account_id is null or source_account_id=v_source_account_id)
  order by requested_at
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  return query
  update public.nrc_sync_jobs
  set status='CLAIMED', claimed_by=p_device_id, claimed_at=now(),
      updated_at=now(), message='수집 PC가 작업을 가져왔습니다.'
  where id=v_job_id and status='QUEUED'
  returning *;
end;
$$;

grant execute on function public.claim_nrc_sync_job(uuid) to authenticated;

commit;
