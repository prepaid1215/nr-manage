begin;

alter table public.nrc_sync_schedules
  add column if not exists frequency text not null default 'daily'
    check (frequency in ('daily','weekly','monthly')),
  add column if not exists weekday smallint check (weekday between 0 and 6),
  add column if not exists month_days smallint[] not null default '{}';

-- weekday: 0=일 ~ 6=토. month_days: 1~31, -1은 "말일"을 뜻한다(달마다 실제
-- 마지막 날짜로 계산). frequency='daily'면 둘 다 무시하고 매일 실행한다.
create or replace function public.schedule_is_due_today(
  p_frequency text, p_weekday smallint, p_month_days smallint[], p_timezone text
)
returns boolean
language sql
stable
as $$
  select case p_frequency
    when 'weekly' then
      extract(dow from (now() at time zone p_timezone))::smallint = p_weekday
    when 'monthly' then
      (p_month_days @> array[(extract(day from (now() at time zone p_timezone))::smallint)])
      or (
        p_month_days @> array[(-1)::smallint]
        and (now() at time zone p_timezone)::date
          = (date_trunc('month', (now() at time zone p_timezone)::date) + interval '1 month - 1 day')::date
      )
    else true
  end
$$;

revoke all on function public.schedule_is_due_today(text,smallint,smallint[],text) from public;
grant execute on function public.schedule_is_due_today(text,smallint,smallint[],text) to authenticated, service_role;

create or replace function public.enqueue_due_nrc_sync_schedules(p_device_id uuid)
returns integer
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_owner_id uuid;
  v_source_account_id text;
  v_schedule record;
  v_job_id uuid;
  v_count integer:=0;
begin
  select owner_id,source_account_id into v_owner_id,v_source_account_id
  from public.nrc_sync_devices
  where id=p_device_id and owner_id=auth.uid();
  if v_owner_id is null then return 0; end if;

  for v_schedule in
    select * from public.nrc_sync_schedules
    where owner_id=v_owner_id and source_account_id=v_source_account_id and enabled
      and coalesce(last_enqueued_on,date '1900-01-01') < (now() at time zone timezone)::date
      and run_time <= (now() at time zone timezone)::time
      and public.schedule_is_due_today(frequency, weekday, month_days, timezone)
    order by run_time
    for update skip locked
  loop
    insert into public.nrc_sync_jobs(owner_id,source_account_id,status,message)
    values(v_owner_id,v_schedule.source_account_id,'QUEUED',v_schedule.label || ' 자동수집 대기 중...')
    returning id into v_job_id;
    update public.nrc_sync_schedules
    set last_enqueued_on=(now() at time zone timezone)::date,last_job_id=v_job_id,updated_at=now()
    where id=v_schedule.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.enqueue_due_nrc_sync_schedules(uuid) to authenticated;

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
      and public.schedule_is_due_today(s.frequency, s.weekday, s.month_days, s.timezone)
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

grant execute on function public.enqueue_due_cloud_schedules() to service_role;

commit;
