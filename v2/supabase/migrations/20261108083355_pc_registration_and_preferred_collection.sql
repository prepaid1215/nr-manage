begin;

alter table public.nrc_sync_devices
  add column if not exists revoked_at timestamptz,
  add column if not exists collector_version text;
alter table public.nrc_sync_jobs add column if not exists preferred_until timestamptz;

-- Keep revoked rows: old clients must not recreate them with heartbeat upserts.
drop policy if exists nrc_sync_devices_owner_all on public.nrc_sync_devices;
drop policy if exists nrc_sync_devices_read on public.nrc_sync_devices;
drop policy if exists nrc_sync_devices_insert on public.nrc_sync_devices;
drop policy if exists nrc_sync_devices_update on public.nrc_sync_devices;
create policy nrc_sync_devices_read on public.nrc_sync_devices for select to authenticated
  using (owner_id=(select auth.uid()));
create policy nrc_sync_devices_insert on public.nrc_sync_devices for insert to authenticated
  with check (owner_id=(select auth.uid()) and revoked_at is null);
create policy nrc_sync_devices_update on public.nrc_sync_devices for update to authenticated
  using (owner_id=(select auth.uid()) and revoked_at is null)
  with check (owner_id=(select auth.uid()) and revoked_at is null);
revoke delete on public.nrc_sync_devices from authenticated;
grant select,insert,update on public.nrc_sync_devices to service_role;

create or replace function public.set_pc_registration(p_actor uuid,p_device uuid,p_enabled boolean)
returns public.nrc_sync_devices language plpgsql security invoker set search_path=public as $$
declare d public.nrc_sync_devices;
begin
  select * into d from public.nrc_sync_devices where id=p_device for update;
  if not found then raise exception 'PC를 찾을 수 없습니다.' using errcode='P0002'; end if;
  if d.owner_id<>p_actor and not exists(select 1 from public.app_admins where user_id=p_actor) then
    raise exception '본인 PC 또는 관리자 권한이 필요합니다.' using errcode='42501';
  end if;
  update public.nrc_sync_devices set revoked_at=case when p_enabled then null else now() end,
    status='OFFLINE',last_error=null,updated_at=now() where id=p_device returning * into d;
  if not p_enabled then
    update public.nrc_sync_jobs set status='CANCELLED',completed_at=now(),updated_at=now(),
      message='수집 PC 등록이 해제되어 작업을 취소했습니다.',error='PC 등록 해제'
      where status in ('CLAIMED','RUNNING') and
      (claimed_by=p_device or cloud_worker_id='pc-pool:'||d.owner_id::text||':'||p_device::text);
    update public.nrc_sync_jobs set target_device_id=null,preferred_until=null,updated_at=now()
      where status='QUEUED' and target_device_id=p_device;
  end if;
  return d;
end; $$;
revoke all on function public.set_pc_registration(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_pc_registration(uuid,uuid,boolean) to service_role;

create or replace function public.claim_cloud_sync_job(p_worker_id text)
returns setof public.nrc_sync_jobs language plpgsql security invoker set search_path=public as $$
declare v_job uuid; v_device uuid; v_owner uuid;
begin
  if p_worker_id like 'pc-pool:%' then
    v_owner:=split_part(p_worker_id,':',2)::uuid;
    v_device:=split_part(p_worker_id,':',3)::uuid;
    perform 1 from public.nrc_sync_devices where id=v_device and owner_id=v_owner and revoked_at is null for update;
    if not found then raise exception '등록 해제된 PC입니다.' using errcode='42501'; end if;
  end if;
  select j.id into v_job from public.nrc_sync_jobs j join public.nrc_cloud_credentials c
    on c.owner_id=j.owner_id and c.source_account_id=j.source_account_id
    where j.status='QUEUED' and (j.target_device_id is null or j.target_device_id=v_device
      or j.preferred_until<=now())
    order by (j.target_device_id=v_device) desc nulls last,j.requested_at
    for update of j skip locked limit 1;
  if v_job is null then return; end if;
  return query update public.nrc_sync_jobs set status='CLAIMED',worker_type='CLOUD',
    cloud_worker_id=p_worker_id,claimed_at=now(),updated_at=now(),message='승인된 PC에 작업 배정 중'
    where id=v_job and status='QUEUED' returning *;
end; $$;
revoke all on function public.claim_cloud_sync_job(text) from public,anon,authenticated;
grant execute on function public.claim_cloud_sync_job(text) to service_role;

-- Also block collectors that still use the legacy direct claim RPC.
create or replace function public.guard_revoked_pc_job()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_device uuid;
begin
  if new.status not in ('CLAIMED','RUNNING','SUCCESS') then return new; end if;
  v_device:=new.claimed_by;
  if new.cloud_worker_id like 'pc-pool:%' then v_device:=split_part(new.cloud_worker_id,':',3)::uuid; end if;
  if v_device is not null and not exists(select 1 from public.nrc_sync_devices where id=v_device and revoked_at is null) then
    raise exception '등록 해제된 PC는 수집할 수 없습니다.' using errcode='42501';
  end if;
  return new;
end; $$;
revoke all on function public.guard_revoked_pc_job() from public,anon,authenticated;
drop trigger if exists guard_revoked_pc_job on public.nrc_sync_jobs;
create trigger guard_revoked_pc_job before insert or update on public.nrc_sync_jobs
  for each row execute function public.guard_revoked_pc_job();

-- Device-first locking gives completion and revocation a single, consistent order.
create or replace function public.start_pc_sync_job(p_actor uuid,p_device uuid,p_job uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
  perform 1 from public.nrc_sync_devices where id=p_device and owner_id=p_actor and revoked_at is null for update;
  if not found then raise exception '등록 해제된 PC입니다.' using errcode='42501'; end if;
  update public.nrc_sync_jobs set status='RUNNING',started_at=now(),updated_at=now(),
    message='승인된 Windows PC에서 수집 중...',error=null where id=p_job and status='CLAIMED'
    and cloud_worker_id='pc-pool:'||p_actor::text||':'||p_device::text;
  if not found then raise exception '유효하지 않은 수집 작업입니다.' using errcode='42501'; end if;
  return true;
end; $$;
revoke all on function public.start_pc_sync_job(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.start_pc_sync_job(uuid,uuid,uuid) to service_role;

create or replace function public.complete_pc_sync_job(p_actor uuid,p_device uuid,p_job uuid,p_payload jsonb,p_error text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare j public.nrc_sync_jobs; v_snapshot bigint;
begin
  perform 1 from public.nrc_sync_devices where id=p_device and owner_id=p_actor and revoked_at is null for update;
  if not found then raise exception '등록 해제된 PC입니다.' using errcode='42501'; end if;
  select * into j from public.nrc_sync_jobs where id=p_job
    and cloud_worker_id='pc-pool:'||p_actor::text||':'||p_device::text for update;
  if not found then raise exception '이 PC에 배정된 작업이 아닙니다.' using errcode='42501'; end if;
  if j.status='SUCCESS' and j.snapshot_id is not null then return jsonb_build_object('ok',true,'alreadyCompleted',true); end if;
  if j.status<>'RUNNING' then raise exception '이미 종료된 수집 작업입니다.' using errcode='42501'; end if;
  if coalesce(p_error,'')<>'' then
    update public.nrc_sync_jobs set status='ERROR',error=left(p_error,4000),message='Windows PC 수집 실패',
      completed_at=now(),updated_at=now() where id=p_job;
    return jsonb_build_object('ok',true);
  end if;
  if p_payload->>'sourceAccountId' is distinct from j.source_account_id then
    raise exception '요청 계정과 수집 결과 계정이 다릅니다.';
  end if;
  -- Old collectors must never overwrite corrected line metrics again.
  if coalesce(p_payload->>'collectorVersion','')='' or exists(
    select 1 from jsonb_array_elements(coalesce(p_payload->'members','[]'::jsonb)) m
    where coalesce((m->>'lineMetricsVersion')::integer,0)<2
  ) then raise exception '수집기 업데이트가 필요합니다. 회선 정보가 누락된 결과는 저장하지 않습니다.'; end if;
  insert into public.nrc_sync_snapshots(owner_id,source_account_id,snapshot_type,payload,collected_at)
    values(j.owner_id,j.source_account_id,'combined',p_payload,
      coalesce(nullif(p_payload->>'수집일시',''),nullif(p_payload->>'collectedAt',''),now()::text)::timestamptz)
    returning id into v_snapshot;
  update public.nrc_sync_jobs set status='SUCCESS',snapshot_id=v_snapshot,completed_at=now(),
    updated_at=now(),message='승인된 Windows PC 수집 완료',error=null where id=p_job;
  return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.complete_pc_sync_job(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_pc_sync_job(uuid,uuid,uuid,jsonb,text) to service_role;

notify pgrst,'reload schema';
commit;
