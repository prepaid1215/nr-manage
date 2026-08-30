begin;

create table if not exists public.nrc_cloud_credentials (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  source_account_id text not null,
  encrypted_credentials text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.nrc_cloud_credentials enable row level security;
revoke all on public.nrc_cloud_credentials from anon,authenticated;
grant select,insert,update,delete on public.nrc_cloud_credentials to service_role;
grant select,insert,update on public.nrc_sync_jobs to service_role;
grant select,insert,update on public.nrc_sync_snapshots to service_role;
grant select,update on public.nrc_sync_schedules to service_role;

alter table public.nrc_sync_jobs add column if not exists worker_type text
  check(worker_type is null or worker_type in ('PC','CLOUD'));
alter table public.nrc_sync_jobs add column if not exists cloud_worker_id text;

create or replace function public.claim_cloud_sync_job(p_worker_id text)
returns setof public.nrc_sync_jobs
language plpgsql
security definer
set search_path=public
as $$
declare v_job_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select j.id into v_job_id
  from public.nrc_sync_jobs j
  join public.nrc_cloud_credentials c
    on c.owner_id=j.owner_id and c.source_account_id=j.source_account_id
  where j.status='QUEUED' and j.target_device_id is null
  order by j.requested_at
  for update of j skip locked
  limit 1;
  if v_job_id is null then return; end if;
  return query update public.nrc_sync_jobs
  set status='CLAIMED',worker_type='CLOUD',cloud_worker_id=p_worker_id,
      claimed_at=now(),updated_at=now(),message='클라우드 수집기가 작업을 가져왔습니다.'
  where id=v_job_id and status='QUEUED'
  returning *;
end;
$$;

create or replace function public.enqueue_due_cloud_schedules()
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare v_schedule record; v_job_id uuid; v_count integer:=0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  for v_schedule in
    select s.* from public.nrc_sync_schedules s
    join public.nrc_cloud_credentials c
      on c.owner_id=s.owner_id and c.source_account_id=s.source_account_id
    where s.enabled
      and coalesce(s.last_enqueued_on,date '1900-01-01') < (now() at time zone s.timezone)::date
      and s.run_time <= (now() at time zone s.timezone)::time
    order by s.run_time
    for update of s skip locked
  loop
    insert into public.nrc_sync_jobs(owner_id,source_account_id,status,message)
    values(v_schedule.owner_id,v_schedule.source_account_id,'QUEUED',v_schedule.label || ' 클라우드 자동수집 대기 중...')
    returning id into v_job_id;
    update public.nrc_sync_schedules
    set last_enqueued_on=(now() at time zone timezone)::date,last_job_id=v_job_id,updated_at=now()
    where id=v_schedule.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.claim_cloud_sync_job(text) to service_role;
grant execute on function public.enqueue_due_cloud_schedules() to service_role;

commit;
