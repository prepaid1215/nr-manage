-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요. RUN_051을 먼저 적용한 뒤에 실행합니다.
-- 기록 탭에서 "NRC에서 찾기"로 찾아 "표에 등록"한 사람(10단계 계보 밖의 하위 회원)을 매일 기록에 포함하기 위한 변경입니다.
-- 새 표 하나와 함수 교체 하나만 합니다. 기존 표의 자료는 건드리지 않고, 여러 번 실행해도 안전합니다.
--
-- 동작
--  * nrc_tracked_members: 사용자가 등록한 사람의 회원번호 목록(본코드·서브1·서브2). 본인 것만 읽고 쓴다(RLS).
--  * 수집기가 수집할 때 이 목록을 함께 조회해 통합 스냅샷의 payload->'trackedMembers'에 넣는다.
--  * capture_daily_nrc_metrics가 payload->'members'와 payload->'trackedMembers'를 함께 기록하고,
--    이름·직급은 payload->'rstLst'와 payload->'trackedMembers'에서 찾는다.
--    계보 화면이 쓰는 members/rstLst는 바꾸지 않으므로 조직도에는 영향이 없다.
--  * 등록한 날의 기록은 없고, 등록 뒤 첫 수집이 끝난 다음 날 오전 9시 이후부터 쌓인다.

begin;

create table if not exists public.nrc_tracked_members (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  source_account_id text not null,
  user_id text not null,
  user_name text,
  rank_cd text,
  rank_name text,
  role text,
  group_id text,
  created_at timestamptz not null default now(),
  primary key (owner_id, source_account_id, user_id)
);

create index if not exists nrc_tracked_members_owner_account
  on public.nrc_tracked_members(owner_id, source_account_id);

-- 한 계정에 너무 많이 등록해 수집이 길어지는 것을 막는다.
create or replace function public.limit_nrc_tracked_members()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.nrc_tracked_members
      where owner_id = new.owner_id and source_account_id = new.source_account_id) >= 150 then
    raise exception '등록할 수 있는 회원번호는 계정당 150개까지입니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists nrc_tracked_members_limit on public.nrc_tracked_members;
create trigger nrc_tracked_members_limit
  before insert on public.nrc_tracked_members
  for each row execute function public.limit_nrc_tracked_members();

alter table public.nrc_tracked_members enable row level security;
drop policy if exists nrc_tracked_members_owner_all on public.nrc_tracked_members;
create policy nrc_tracked_members_owner_all on public.nrc_tracked_members
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, update, delete on public.nrc_tracked_members to authenticated;
-- Render 서버(service_role 키)가 수집 작업을 줄 때 등록 목록을 읽는다. 이 권한이 없으면 "permission denied"가 나고
-- 서버는 수집을 막지 않으려고 빈 목록으로 넘어가므로 등록한 사람이 조회되지 않는다. (RUN_016·RUN_023과 같은 실수)
grant select on public.nrc_tracked_members to service_role;

-- RUN_051의 함수와 같고, 등록 인원(trackedMembers)을 함께 기록하도록 두 곳만 바꿨다.
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
  v_tracked jsonb;
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
      -- 그날 24시 이후 다음 날 오전 9시 전에 수집한 값도 그날 마감 값으로 본다.
      and s.collected_at < v_cutoff + interval '9 hours'
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

    -- 등록 인원: 배열이 아니면 없는 것으로 본다.
    v_tracked := case when jsonb_typeof(v_snap.payload->'trackedMembers') = 'array'
                      then v_snap.payload->'trackedMembers' else '[]'::jsonb end;

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

  return v_total;
end;
$$;

revoke all on function public.capture_daily_nrc_metrics(date) from public, anon, authenticated;
grant execute on function public.capture_daily_nrc_metrics(date) to service_role;

notify pgrst, 'reload schema';
commit;
