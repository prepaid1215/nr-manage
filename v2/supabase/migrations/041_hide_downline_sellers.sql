begin;

-- 매출자 표시 규칙:
--  1) 매출자 표시는 내 계보 아래 사람에게만 할 수 있다(남의 회원번호를 마음대로 숨기는 것을 막는다).
--  2) 아래 사업자(예: 주영돈)가 매출자로 표시한 사람은 위 계정(예: 한수진, 임영은)의 팀 화면에서 보이지 않는다.
--     내가 직접 표시한 사람은 내 화면에 그대로 보인다(체크를 풀 수 있게).
drop policy if exists nrc_seller_marks_owner_all on public.nrc_seller_marks;
create policy nrc_seller_marks_owner_all on public.nrc_seller_marks
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and public.is_member_no_in_my_downline(member_no));

-- 아래 사업자가 매출자로 표시한 회원번호인가 (내가 직접 표시한 것은 제외)
create or replace function public.is_hidden_by_downline_seller(p_member_no text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.nrc_seller_marks m
    where m.member_no = p_member_no
      and m.owner_id <> auth.uid()
      and public.is_nrc_downline(m.owner_id)
  )
$$;

revoke all on function public.is_hidden_by_downline_seller(text) from public;
grant execute on function public.is_hidden_by_downline_seller(text) to authenticated;

-- 팀 마감 현황: 아래 사업자가 매출자로 표시한 계정은 제외
create or replace function public.get_downline_closing_status(p_period_id text)
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
    and not public.is_hidden_by_downline_seller(pr.member_no)
  order by pr.member_no
$$;

-- 팀 가입 현황: 아래 사업자가 매출자로 표시한 사람은 제외
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
    and not public.is_hidden_by_downline_seller(pe.member_no)
  order by pe.lv, pe.member_no
$$;

revoke all on function public.get_downline_closing_status(text) from public;
revoke all on function public.get_downline_signup_status() from public;
grant execute on function public.get_downline_closing_status(text) to authenticated;
grant execute on function public.get_downline_signup_status() to authenticated;

commit;
