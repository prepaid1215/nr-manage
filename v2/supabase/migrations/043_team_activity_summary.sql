begin;

-- 방향 정리: 관리(오더·마감 지시)는 항상 NRC 계보의 상위 계정이 한다. 팀은 사람을 한 묶음으로 묶어서
-- 서로 뭘 했는지 확인하는 용도다. 그래서 042에서 열어 둔 "팀 팀원에게 오더" 권한은 되돌린다.

-- 1) 오더 저장·삭제: 계보 아래 사람에게만 (041까지의 규칙과 같음)
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

drop function if exists public.get_team_closing_status(text);
drop function if exists public.is_my_team_member_no(text);

-- 2) 팀 활동 요약: 내가 속한 팀(팀장이든 팀원이든)의 모든 팀원이 서로의 이번 달 활동을 본다.
--    개수만 보여주고 고객 이름·전화번호 같은 내용은 보여주지 않는다.
create or replace function public.get_team_activity_summary(
  p_from date,
  p_to date,
  p_period_id text
)
returns table(
  member_no text,
  member_name text,
  team_name text,
  is_me boolean,
  last_activity date,
  activity_days int,
  activation_count int,
  posting_count int,
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
  with my_teams as (
    select t.id, t.name
    from public.teams t
    join public.team_members m on m.team_id = t.id and m.active and m.user_id = auth.uid()
    where t.active
  ),
  peers as (
    select distinct on (m2.user_id) m2.user_id, mt.name as team_name
    from my_teams mt
    join public.team_members m2 on m2.team_id = mt.id and m2.active
    order by m2.user_id, mt.name
  )
  select pr.member_no,
         pr.name,
         pe.team_name,
         (pr.id = auth.uid()),
         (select max(a.activity_date) from public.daily_activities a where a.owner_id = pr.id),
         (select count(*)::int from public.daily_activities a
           where a.owner_id = pr.id
             and a.activity_date between p_from and p_to
             and (a.new_transfer > 0 or a.repurchase > 0 or a.attendance > 0
                  or a.content::text <> '{}' or a.tasks::text <> '[]')),
         (select count(*)::int from public.customers c
           where c.owner_id = pr.id
             and c.activation_date between p_from and p_to),
         (select coalesce(sum(case when kv.value ~ '^[0-9]+(\.[0-9]+)?$' then kv.value::numeric else 0 end), 0)::int
            from public.daily_activities a
            cross join lateral jsonb_each_text(
              case when jsonb_typeof(a.content -> 'postings') = 'object'
                   then a.content -> 'postings' else '{}'::jsonb end
            ) kv
           where a.owner_id = pr.id
             and a.activity_date between p_from and p_to),
         case when v.ok then pl.status end,
         case when v.ok then pl.completion end,
         case when v.ok then pl.completed_at end,
         v.ok
  from peers pe
  join public.profiles pr on pr.id = pe.user_id
  cross join lateral (select public.is_member_verified(pr.id) as ok) v
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
  where pr.member_no is not null
  order by (pr.id = auth.uid()) desc, pr.name
$$;

revoke all on function public.get_team_activity_summary(date, date, text) from public;
grant execute on function public.get_team_activity_summary(date, date, text) to authenticated;
revoke all on function public.set_closing_order(text, text, numeric, numeric) from public;
revoke all on function public.delete_closing_order(text, text) from public;
grant execute on function public.set_closing_order(text, text, numeric, numeric) to authenticated;
grant execute on function public.delete_closing_order(text, text) to authenticated;

commit;
