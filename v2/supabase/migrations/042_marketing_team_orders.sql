begin;

-- 마케팅 팀: 계보(실적 라인)와 상관없이 팀장이 초대코드로 모은 팀원에게도 마감 오더를 정하고
-- 마감 현황을 본다. (팀·초대코드는 기존 teams / team_members / team_invites 를 그대로 쓴다.)

-- 내 팀(내가 팀장)의 팀원 회원번호인가
create or replace function public.is_my_team_member_no(p_member_no text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teams t
    join public.team_members m on m.team_id = t.id and m.active
    join public.profiles p on p.id = m.user_id
    where t.owner_id = auth.uid()
      and t.active
      and m.user_id <> auth.uid()
      and p.member_no = p_member_no
  )
$$;

-- 오더 저장·삭제: 내 계보 아래이거나 내 마케팅 팀 팀원이면 가능
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
  if not (public.is_member_no_in_my_downline(p_member_no) or public.is_my_team_member_no(p_member_no)) then
    raise exception '내 계보 아래 사업자이거나 내 팀 팀원만 오더를 정할 수 있습니다.';
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
  if not (public.is_member_no_in_my_downline(p_member_no) or public.is_my_team_member_no(p_member_no)) then
    raise exception '내 계보 아래 사업자이거나 내 팀 팀원만 오더를 지울 수 있습니다.';
  end if;
  delete from public.nrc_closing_orders
  where period_id = p_period_id and member_no = p_member_no;
end
$$;

-- 내 마케팅 팀 팀원들의 이번 차수 오더·마감 현황 (소유가 확인된 계정만 마감 값 표시)
create or replace function public.get_team_closing_status(p_period_id text)
returns table(
  member_no text,
  member_name text,
  team_name text,
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
         t.name,
         o.major_target,
         o.minor_target,
         ob.name,
         case when v.ok then pl.status end,
         case when v.ok then pl.completion end,
         case when v.ok then pl.completed_at end,
         v.ok
  from public.teams t
  join public.team_members m on m.team_id = t.id and m.active and m.user_id <> auth.uid()
  join public.profiles pr on pr.id = m.user_id
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
  where t.owner_id = auth.uid()
    and t.active
    and pr.member_no is not null
  order by t.name, pr.member_no
$$;

revoke all on function public.is_my_team_member_no(text) from public;
revoke all on function public.set_closing_order(text, text, numeric, numeric) from public;
revoke all on function public.delete_closing_order(text, text) from public;
revoke all on function public.get_team_closing_status(text) from public;
grant execute on function public.is_my_team_member_no(text) to authenticated;
grant execute on function public.set_closing_order(text, text, numeric, numeric) to authenticated;
grant execute on function public.delete_closing_order(text, text) to authenticated;
grant execute on function public.get_team_closing_status(text) to authenticated;

commit;
