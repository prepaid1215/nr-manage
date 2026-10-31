-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 최상위(위 계정)가 아래 사업자의 이번 차수 마감 목표(오더)를 앱에서 정하고, 아래 전체의 마감 현황을 한 화면에서 보게 합니다.
-- (이 함수들이 없으면 앱은 조용히 기존 방식 그대로 동작합니다)

begin;

-- 최상위(또는 위 계정)가 아래 사업자의 이번 차수 마감 목표(오더)를 앱에서 정해 두면,
-- 아래 사업자의 마감 계산기가 그 목표를 불러오고, 위 계정은 아래 전체의 마감 현황을 한 화면에서 본다.
-- 테이블은 직접 접근을 막고(RLS, 정책 없음), 아래 함수로만 읽고 쓴다.

create table if not exists public.nrc_closing_orders (
  period_id text not null,
  member_no text not null,
  major_target numeric not null check (major_target > 0),
  minor_target numeric not null check (minor_target > 0),
  ordered_by uuid not null references public.profiles(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (period_id, member_no)
);

alter table public.nrc_closing_orders enable row level security;
revoke all on public.nrc_closing_orders from anon, authenticated;

-- 이 회원번호가 내 계보 아래(연쇄 포함)에 있는가. is_nrc_downline(019)과 같은 방식.
create or replace function public.is_member_no_in_my_downline(p_member_no text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive downline_member_no as (
    select elem->>'userId' as member_no
    from (
      select payload from public.nrc_sync_snapshots
      where owner_id = auth.uid() and snapshot_type = 'combined'
      order by collected_at desc
      limit 1
    ) latest
    cross join lateral jsonb_array_elements(coalesce(latest.payload->'rstLst','[]'::jsonb)) as elem

    union

    select elem2->>'userId'
    from downline_member_no d
    join public.profiles pr on pr.member_no = d.member_no
    cross join lateral (
      select payload from public.nrc_sync_snapshots
      where owner_id = pr.id and snapshot_type = 'combined'
      order by collected_at desc
      limit 1
    ) latest2
    cross join lateral jsonb_array_elements(coalesce(latest2.payload->'rstLst','[]'::jsonb)) as elem2
  )
  select exists(select 1 from downline_member_no where member_no = p_member_no)
$$;

create or replace function public.set_closing_order(
  p_period_id text,
  p_member_no text,
  p_major numeric,
  p_minor numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  if p_major is null or p_minor is null or p_major <= 0 or p_minor <= 0 then
    raise exception '목표는 0보다 커야 합니다.';
  end if;
  if not public.is_member_no_in_my_downline(p_member_no) then
    raise exception '내 계보 아래 사업자만 오더를 정할 수 있습니다.';
  end if;
  insert into public.nrc_closing_orders(period_id, member_no, major_target, minor_target, ordered_by, updated_at)
  values (p_period_id, p_member_no, p_major, p_minor, auth.uid(), now())
  on conflict (period_id, member_no) do update
    set major_target = excluded.major_target,
        minor_target = excluded.minor_target,
        ordered_by = excluded.ordered_by,
        updated_at = now();
end
$$;

create or replace function public.delete_closing_order(p_period_id text, p_member_no text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  if not public.is_member_no_in_my_downline(p_member_no) then
    raise exception '내 계보 아래 사업자만 오더를 지울 수 있습니다.';
  end if;
  delete from public.nrc_closing_orders
  where period_id = p_period_id and member_no = p_member_no;
end
$$;

-- 내가 받은 이번 차수 오더 (내 회원번호 기준)
create or replace function public.get_my_closing_order(p_period_id text)
returns table(
  member_no text,
  major_target numeric,
  minor_target numeric,
  ordered_by_name text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select o.member_no, o.major_target, o.minor_target, ob.name, o.updated_at
  from public.profiles me
  join public.nrc_closing_orders o on o.member_no = me.member_no and o.period_id = p_period_id
  left join public.profiles ob on ob.id = o.ordered_by
  where me.id = auth.uid()
$$;

-- 내 아래 앱 계정들의 이번 차수 오더·마감 현황
create or replace function public.get_downline_closing_status(p_period_id text)
returns table(
  member_no text,
  member_name text,
  major_target numeric,
  minor_target numeric,
  ordered_by_name text,
  plan_status text,
  completion jsonb,
  completed_at timestamptz
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
         pl.status,
         pl.completion,
         pl.completed_at
  from public.profiles pr
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

revoke all on function public.is_member_no_in_my_downline(text) from public;
revoke all on function public.set_closing_order(text, text, numeric, numeric) from public;
revoke all on function public.delete_closing_order(text, text) from public;
revoke all on function public.get_my_closing_order(text) from public;
revoke all on function public.get_downline_closing_status(text) from public;
grant execute on function public.is_member_no_in_my_downline(text) to authenticated;
grant execute on function public.set_closing_order(text, text, numeric, numeric) to authenticated;
grant execute on function public.delete_closing_order(text, text) to authenticated;
grant execute on function public.get_my_closing_order(text) to authenticated;
grant execute on function public.get_downline_closing_status(text) to authenticated;

commit;
