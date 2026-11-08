-- Rollback-only integration checks; no real PC registrations or snapshots are changed.
begin;
do $$
declare
  owner_id uuid; admin_id uuid; a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
  job_id uuid:=gen_random_uuid(); source_id text:='codex-test-'||gen_random_uuid()::text;
  claimed public.nrc_sync_jobs; payload jsonb; blocked boolean;
begin
  select d.owner_id into owner_id from public.nrc_sync_devices d limit 1;
  select user_id into admin_id from public.app_admins limit 1;
  assert owner_id is not null and admin_id is not null,'fixture owners required';
  assert not has_function_privilege('authenticated','public.set_pc_registration(uuid,uuid,boolean)','execute');
  assert not has_function_privilege('anon','public.complete_pc_sync_job(uuid,uuid,uuid,jsonb,text)','execute');
  insert into public.nrc_sync_devices(id,owner_id,device_name,source_account_id) values
    (a,owner_id,'Codex test A',source_id),(b,owner_id,'Codex test B',source_id);
  insert into public.nrc_cloud_credentials(owner_id,source_account_id,encrypted_credentials)
    values(owner_id,source_id,'test-only-never-decrypted');
  insert into public.nrc_sync_jobs(id,owner_id,source_account_id,target_device_id,preferred_until,requested_at)
    values(job_id,owner_id,source_id,a,now()+interval '1 minute',timestamptz '1900-01-01');
  select * into claimed from public.claim_cloud_sync_job('pc-pool:'||owner_id||':'||b);
  assert claimed.id is distinct from job_id,'other PC bypassed preference window';
  select * into claimed from public.claim_cloud_sync_job('pc-pool:'||owner_id||':'||a);
  assert claimed.id=job_id,'own PC did not receive priority';
  perform public.start_pc_sync_job(owner_id,a,job_id);
  blocked:=false;
  begin perform public.set_pc_registration(gen_random_uuid(),a,false);
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked,'unrelated user could revoke';
  perform public.set_pc_registration(admin_id,a,false);
  assert (select revoked_at is not null from public.nrc_sync_devices where id=a),'admin revoke failed';
  assert (select status='CANCELLED' from public.nrc_sync_jobs where id=job_id),'lease was not cancelled';
  payload:=jsonb_build_object('sourceAccountId',source_id,'collectorVersion','test-current',
    'members',jsonb_build_array(jsonb_build_object('lineMetricsVersion',2,'realLines',5)));
  blocked:=false;
  begin perform public.complete_pc_sync_job(owner_id,a,job_id,payload,'');
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked,'revoked PC could upload';
  assert not exists(select 1 from public.nrc_sync_snapshots where source_account_id=source_id);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  blocked:=false;
  begin
    insert into public.nrc_sync_devices(id,owner_id,device_name,source_account_id,status)
      values(a,owner_id,'Old heartbeat',source_id,'ONLINE')
      on conflict(id) do update set status='ONLINE';
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked,'legacy heartbeat restored revoked PC';
  update public.nrc_sync_devices set revoked_at=null where id=a;
  assert (select revoked_at is not null from public.nrc_sync_devices where id=a),'client reset revocation';
  blocked:=false;
  begin delete from public.nrc_sync_devices where id=a;
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked,'client deleted revocation tombstone';
  execute 'reset role';
  perform public.set_pc_registration(owner_id,a,true);
  assert (select revoked_at is null from public.nrc_sync_devices where id=a),'owner restore failed';
  update public.nrc_sync_jobs set status='QUEUED',target_device_id=a,preferred_until=now()-interval '1 second' where id=job_id;
  select * into claimed from public.claim_cloud_sync_job('pc-pool:'||owner_id||':'||b);
  assert claimed.id=job_id,'shared fallback failed';
  perform public.start_pc_sync_job(owner_id,b,job_id);
  blocked:=false;
  begin perform public.complete_pc_sync_job(owner_id,b,job_id,payload-'collectorVersion','');
  exception when others then blocked:=true; end;
  assert blocked,'legacy result was stored';
  assert not exists(select 1 from public.nrc_sync_snapshots where source_account_id=source_id);
  perform public.complete_pc_sync_job(owner_id,b,job_id,payload,'');
  perform public.complete_pc_sync_job(owner_id,b,job_id,payload,'');
  assert (select count(*)=1 from public.nrc_sync_snapshots where source_account_id=source_id),'completion must be idempotent';
  raise notice 'PASS: owner/admin controls, RLS heartbeat/delete/reset blocks, revoked uploads, own-PC priority, shared fallback, legacy result rejection, idempotency';
end; $$;
rollback;
