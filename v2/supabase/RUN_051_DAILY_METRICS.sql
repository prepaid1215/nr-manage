-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 매일 밤 12시(한국시간) 기준으로 회원별 대실적·소실적·회선수를 날짜별로 남기는 기록표입니다.
-- 새 표 하나와 함수 하나만 추가하며 기존 표는 건드리지 않습니다. 여러 번 실행해도 안전합니다.
--
-- 저장 규칙
--  * metric_date = 그날(한국시간). 그날 24시 이전에 마지막으로 수집된 통합 스냅샷 값을 쓴다.
--  * 실회선·소비자총회선은 수집기 v2 이상에서 실제로 읽은 값만 저장하고, 못 읽었으면 NULL로 둔다.
--    (실제 0과 미수집을 구분한다.)
--  * 기록일 24시 기준 2일 넘게 수집되지 않은 계정의 스냅샷은 건너뛴다(그날 기록 없음).
--  * 같은 날짜·계정은 한 번만 기록한다. 다시 호출해도 덮어쓰지 않는다.

begin;

create table if not exists public.nrc_daily_metrics (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  source_account_id text not null,
  metric_date date not null,
  user_id text not null,
  user_name text,
  rank_name text,
  max_pv bigint not null default 0,
  min_pv bigint not null default 0,
  ord_pv bigint not null default 0,
  real_lines integer,
  consumer_total_lines integer,
  snapshot_id bigint references public.nrc_sync_snapshots(id) on delete set null,
  snapshot_collected_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (owner_id, source_account_id, metric_date, user_id)
);

create index if not exists nrc_daily_metrics_user_date
  on public.nrc_daily_metrics(owner_id, user_id, metric_date desc);

alter table public.nrc_daily_metrics enable row level security;
drop policy if exists nrc_daily_metrics_owner_read on public.nrc_daily_metrics;
create policy nrc_daily_metrics_owner_read on public.nrc_daily_metrics
  for select using (owner_id = auth.uid());
grant select on public.nrc_daily_metrics to authenticated;

-- p_date를 생략하면 "어제(한국시간)"를 기록한다. 자정 직후 호출하면 방금 끝난 하루가 저장된다.
create or replace function public.capture_daily_nrc_metrics(p_date date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date := coalesce(p_date, ((now() at time zone 'Asia/Seoul')::date - 1));
  v_cutoff timestamptz := ((v_date + 1)::timestamp at time zone 'Asia/Seoul');
  v_snap record;
  v_rows integer;
  v_total integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if v_cutoff > now() then
    raise exception '아직 끝나지 않은 날짜는 기록할 수 없습니다: %', v_date;
  end if;

  for v_snap in
    select distinct on (s.owner_id, s.source_account_id)
           s.id, s.owner_id, s.source_account_id, s.collected_at, s.payload
    from public.nrc_sync_snapshots s
    where s.snapshot_type = 'combined'
      and s.source_account_id is not null
      and s.collected_at < v_cutoff
      -- 며칠째 수집되지 않은 옛 계정의 오래된 값은 그날 기록으로 쓰지 않는다.
      and s.collected_at >= v_cutoff - interval '2 days'
      and jsonb_typeof(s.payload->'members') = 'array'
    order by s.owner_id, s.source_account_id, s.collected_at desc, s.id desc
  loop
    if exists (
      select 1 from public.nrc_daily_metrics d
      where d.owner_id = v_snap.owner_id
        and d.source_account_id = v_snap.source_account_id
        and d.metric_date = v_date
    ) then
      continue;
    end if;

    insert into public.nrc_daily_metrics(
      owner_id, source_account_id, metric_date, user_id, user_name, rank_name,
      max_pv, min_pv, ord_pv, real_lines, consumer_total_lines,
      snapshot_id, snapshot_collected_at)
    select
      v_snap.owner_id, v_snap.source_account_id, v_date, m.value->>'userId',
      names.user_name,
      coalesce(nullif(m.value->>'rankNewName', ''), names.rank_name),
      coalesce(nullif(m.value->>'maxPv', '')::numeric, 0)::bigint,
      coalesce(nullif(m.value->>'minPv', '')::numeric, 0)::bigint,
      coalesce(nullif(m.value->>'ordPv', '')::numeric, 0)::bigint,
      case when coalesce((m.value->>'lineMetricsVersion')::integer, 0) >= 2
            and (m.value->'lineMetricsAvailable'->>'realLines') = 'true'
           then nullif(m.value->>'realLines', '')::numeric::integer end,
      case when coalesce((m.value->>'lineMetricsVersion')::integer, 0) >= 2
            and (m.value->'lineMetricsAvailable'->>'consumerTotalLines') = 'true'
           then nullif(m.value->>'consumerTotalLines', '')::numeric::integer end,
      v_snap.id, v_snap.collected_at
    from jsonb_array_elements(v_snap.payload->'members') m(value)
    left join (
      select distinct on (r.value->>'userId')
             r.value->>'userId' as user_id,
             r.value->>'userName' as user_name,
             r.value->>'rankName' as rank_name
      from jsonb_array_elements(coalesce(v_snap.payload->'rstLst', '[]'::jsonb)) r(value)
      order by r.value->>'userId'
    ) names on names.user_id = m.value->>'userId'
    where coalesce(m.value->>'userId', '') <> ''
    on conflict do nothing;

    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;

  return v_total;
end;
$$;

revoke all on function public.capture_daily_nrc_metrics(date) from public, anon, authenticated;
grant execute on function public.capture_daily_nrc_metrics(date) to service_role;

notify pgrst, 'reload schema';
commit;
