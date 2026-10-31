-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- (1) 앱 계정의 회원번호가 실제 수집한 NRC 계보와 같은지 확인(남의 번호로 가입한 가짜 마감 값 차단),
-- (2) 팀 가입 현황(내 계보 아래 누가 앱에 가입했는지)을 보는 함수를 추가합니다.
-- 먼저 RUN_037, RUN_038을 실행한 뒤에 실행하세요.

begin;

-- 1) 계정 소유 확인: 앱 계정의 회원번호가 그 계정이 실제로 수집한 NRC 계보 맨 위 회원번호와 같은가.
--    (남의 회원번호로 가입해서 위 계정에 가짜 마감 값·현황을 보내는 것을 막는다.)
create or replace function public.is_member_verified(p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles pr
    join public.nrc_sync_snapshots s
      on s.owner_id = pr.id and s.snapshot_type = 'combined'
    where pr.id = p_owner_id
      and pr.member_no is not null
      and (s.payload -> 'rstLst' -> 0 ->> 'userId') = pr.member_no
  )
$$;

-- 2) 아래 계정의 마감 완료 값: 소유가 확인된 계정만 인정한다.
create or replace function public.get_downline_period_closings(p_period_id text)
returns table(
  member_no text,
  major_target numeric,
  minor_target numeric,
  completion jsonb,
  completed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.top_member_id,
         p.top_major_target,
         p.top_minor_target,
         p.completions -> p.top_member_id,
         p.completed_at
  from public.nrc_closing_plans p
  join public.profiles pr on pr.id = p.owner_id
  where p.period_id = p_period_id
    and p.status = 'DONE'
    and p.completions ->> p.top_member_id is not null
    and pr.member_no = p.top_member_id
    and p.owner_id <> auth.uid()
    and public.is_nrc_downline(p.owner_id)
    and public.is_member_verified(p.owner_id)
$$;

-- 3) 팀 마감 현황: verified 열을 추가하고, 소유 확인 전 계정의 마감 상태는 감춘다.
drop function if exists public.get_downline_closing_status(text);
create function public.get_downline_closing_status(p_period_id text)
returns table(
  member_no text,
  member_name text,
  major_target numeric,
  minor_target numeric,
  ordered_by_name text,
  plan_status text,
  completion jsonb,
  completed_at timestamptz,
  verified boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select pr.member_no,
         pr.name,
         o.major_target,
         o.minor_target,
         ob.name,
         case when v.ok then pl.status end,
         case when v.ok then pl.completion end,
         case when v.ok then pl.completed_at end,
         v.ok
  from public.profiles pr
  cross join lateral (select public.is_member_verified(pr.id) as ok) v
  left join public.nrc_closing_orders o
         on o.member_no = pr.member_no and o.period_id = p_period_id
  left join public.profiles ob on ob.id = o.ordered_by
  left join lateral (
    select p.status,
           p.completions -> p.top_member_id as completion,
           p.completed_at
    from public.nrc_closing_plans p
    where p.owner_id = pr.id
      and p.period_id = p_period_id
      and p.top_member_id = pr.member_no
    order by p.updated_at desc
    limit 1
  ) pl on true
  where pr.id <> auth.uid()
    and pr.member_no is not null
    and public.is_nrc_downline(pr.id)
  order by pr.member_no
$$;

-- 4) 팀 가입 현황: 내 계보 아래 사람(박스 중복은 한 사람으로 묶음)과 앱 가입·소유 확인 여부.
create or replace function public.get_downline_signup_status()
returns table(
  member_no text,
  member_name text,
  rank_name text,
  lv int,
  has_account boolean,
  verified boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select payload from public.nrc_sync_snapshots
    where owner_id = auth.uid() and snapshot_type = 'combined'
    order by collected_at desc
    limit 1
  ),
  boxes as (
    select e->>'userId' as member_no,
           e->>'userName' as member_name,
           e->>'rankName' as rank_name,
           coalesce((e->>'lv')::int, 0) as lv,
           e->>'ppId' as pp_id
    from latest
    cross join lateral jsonb_array_elements(coalesce(latest.payload->'rstLst','[]'::jsonb)) e
  ),
  people as (
    select b.*
    from boxes b
    left join boxes p on p.member_no = b.pp_id
    where p.member_name is distinct from b.member_name
  )
  select pe.member_no,
         pe.member_name,
         pe.rank_name,
         pe.lv,
         (pr.id is not null),
         coalesce(public.is_member_verified(pr.id), false)
  from people pe
  left join public.profiles pr on pr.member_no = pe.member_no
  where pe.member_no is distinct from (select me.member_no from public.profiles me where me.id = auth.uid())
  order by pe.lv, pe.member_no
$$;

revoke all on function public.is_member_verified(uuid) from public;
revoke all on function public.get_downline_period_closings(text) from public;
revoke all on function public.get_downline_closing_status(text) from public;
revoke all on function public.get_downline_signup_status() from public;
grant execute on function public.is_member_verified(uuid) to authenticated;
grant execute on function public.get_downline_period_closings(text) to authenticated;
grant execute on function public.get_downline_closing_status(text) to authenticated;
grant execute on function public.get_downline_signup_status() to authenticated;

commit;
