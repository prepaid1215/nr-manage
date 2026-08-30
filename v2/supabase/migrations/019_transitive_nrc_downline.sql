begin;

-- is_nrc_downline을 재귀적으로 확장한다: 뷰어 본인 계보에 없어도, 뷰어의
-- 하위가 앱 계정을 가지고 있고 그 사람 본인 계보에 대상이 있으면 연쇄로 인정한다.
-- (NRC 수집이 계층 깊이 제한이 있어, 뷰어 본인 계보엔 안 잡혀도 중간 하위 기준으론
-- 잡히는 경우를 위함. 중간 사람이 앱 미가입/미수집이면 그 지점에서 연결이 끊긴다.)
create or replace function public.is_nrc_downline(p_owner_id uuid)
returns boolean
language sql stable security definer set search_path=public as $$
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
  select exists(
    select 1
    from downline_member_no d
    join public.profiles target on target.id = p_owner_id
    where d.member_no = target.member_no
  )
$$;

commit;
