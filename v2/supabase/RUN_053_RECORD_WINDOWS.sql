-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요. RUN_051, RUN_052를 먼저 적용한 뒤에 실행합니다.
-- 기록 탭의 일일 기록을 "예약 수집 시간대" 규칙으로 바꿉니다. 여러 번 실행해도 안전합니다.
--
-- 규칙 (모두 한국시간)
--  * 일반 기록(record_kind='daily'): D일의 기록 = D일 18:00 이상 24:00 미만에 수집된 마지막 통합 스냅샷.
--  * 최종마감 기록(record_kind='final'): 마감일(8일·15일·23일·말일) C의 최종 값 = C+1일 00:00 이상 06:00 미만의
--    마지막 통합 스냅샷. 마감일은 일반 기록(저녁)과 최종마감 기록(새벽) 두 가지가 모두 생긴다.
--  * 그 시간대에 수집이 하나도 없으면 그날(또는 그 최종마감)은 기록을 만들지 않는다. 다른 시간의 값으로 채우지 않는다.
--  * 기록은 C+1일 06:00이 지난 뒤에만 만들 수 있다(새벽 수집 시간대가 끝난 뒤). 같은 날짜·종류·계정은 한 번만 만든다.
--  * RUN_052의 등록 인원(trackedMembers)도 그대로 함께 기록한다.
--  * 이미 쌓인 기록은 모두 'daily'로 남는다. 기존 기록은 이전 규칙(다음 날 오전 9시 전 마지막 수집)으로 만들어진 값이다.

begin;

alter table public.nrc_daily_metrics add column if not exists record_kind text not null default 'daily';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'nrc_daily_metrics_kind_check') then
    alter table public.nrc_daily_metrics
      add constraint nrc_daily_metrics_kind_check check (record_kind in ('daily', 'final'));
  end if;
end
$$;

-- 기본 키에 record_kind를 넣어 같은 날짜의 일반 기록과 최종마감 기록이 함께 있을 수 있게 한다.
do $$
declare
  v_pk text;
begin
  select c.conname into v_pk
  from pg_constraint c
  where c.conrelid = 'public.nrc_daily_metrics'::regclass and c.contype = 'p';
  if v_pk is not null and not exists (
    select 1
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.nrc_daily_metrics'::regclass and c.contype = 'p' and a.attname = 'record_kind'
  ) then
    execute format('alter table public.nrc_daily_metrics drop constraint %I', v_pk);
    alter table public.nrc_daily_metrics
      add primary key (owner_id, source_account_id, metric_date, record_kind, user_id);
  end if;
end
$$;

create index if not exists nrc_daily_metrics_kind_date
  on public.nrc_daily_metrics(owner_id, source_account_id, record_kind, metric_date desc);

-- p_date를 생략하면 "어제(한국시간)"를 기록한다. 다음 날 06:00 이후에 호출한다.
create or replace function public.capture_daily_nrc_metrics(p_date date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date := coalesce(p_date, ((now() at time zone 'Asia/Seoul')::date - 1));
  v_end timestamptz := ((v_date + 1)::timestamp at time zone 'Asia/Seoul');  -- v_date 24:00
  v_closing boolean := extract(day from v_date) in (8, 15, 23)
                       or ((date_trunc('month', v_date::timestamp) + interval '1 month')::date - 1) = v_date;
  v_kind text;
  v_from timestamptz;
  v_to timestamptz;
  v_snap record;
  v_tracked jsonb;
  v_rows integer;
  v_total integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if v_end + interval '6 hours' > now() then
    raise exception '아직 기록할 수 없는 날짜입니다(다음 날 오전 6시 이후에 기록): %', v_date;
  end if;

  foreach v_kind in array array['daily', 'final'] loop
    if v_kind = 'final' and not v_closing then
      continue;
    end if;
    if v_kind = 'daily' then
      v_from := v_end - interval '6 hours';  -- v_date 18:00
      v_to := v_end;                         -- v_date 24:00
    else
      v_from := v_end;                       -- 다음 날 00:00
      v_to := v_end + interval '6 hours';    -- 다음 날 06:00
    end if;

    for v_snap in
      select distinct on (s.owner_id, s.source_account_id)
             s.id, s.owner_id, s.source_account_id, s.collected_at, s.payload
      from public.nrc_sync_snapshots s
      where s.snapshot_type = 'combined'
        and s.source_account_id is not null
        and s.collected_at >= v_from
        and s.collected_at < v_to
        and jsonb_typeof(s.payload->'members') = 'array'
      order by s.owner_id, s.source_account_id, s.collected_at desc, s.id desc
    loop
      if exists (
        select 1 from public.nrc_daily_metrics d
        where d.owner_id = v_snap.owner_id
          and d.source_account_id = v_snap.source_account_id
          and d.metric_date = v_date
          and d.record_kind = v_kind
      ) then
        continue;
      end if;

      -- 등록 인원: 배열이 아니면 없는 것으로 본다.
      v_tracked := case when jsonb_typeof(v_snap.payload->'trackedMembers') = 'array'
                        then v_snap.payload->'trackedMembers' else '[]'::jsonb end;

      insert into public.nrc_daily_metrics(
        owner_id, source_account_id, metric_date, record_kind, user_id, user_name, rank_name,
        max_pv, min_pv, ord_pv, real_lines, consumer_total_lines,
        snapshot_id, snapshot_collected_at)
      select
        v_snap.owner_id, v_snap.source_account_id, v_date, v_kind, m.value->>'userId',
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
      from jsonb_array_elements((v_snap.payload->'members') || v_tracked) m(value)
      left join (
        select distinct on (r.value->>'userId')
               r.value->>'userId' as user_id,
               r.value->>'userName' as user_name,
               r.value->>'rankName' as rank_name
        from jsonb_array_elements(coalesce(v_snap.payload->'rstLst', '[]'::jsonb) || v_tracked) r(value)
        order by r.value->>'userId'
      ) names on names.user_id = m.value->>'userId'
      where coalesce(m.value->>'userId', '') <> ''
      on conflict do nothing;

      get diagnostics v_rows = row_count;
      v_total := v_total + v_rows;
    end loop;
  end loop;

  return v_total;
end;
$$;

revoke all on function public.capture_daily_nrc_metrics(date) from public, anon, authenticated;
grant execute on function public.capture_daily_nrc_metrics(date) to service_role;

notify pgrst, 'reload schema';
commit;
