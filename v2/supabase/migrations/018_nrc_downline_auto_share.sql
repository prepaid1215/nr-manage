begin;

-- 뷰어(auth.uid())의 가장 최근 계보 수집 데이터(rstLst)에 p_owner_id의 회원번호가
-- 하위 회원으로 들어있는지 확인한다. NRC 자체가 이미 보여주는 계보 관계만 사용하므로
-- 별도 동의 없이도 안전하게 자동 공유할 수 있는 범위다.
create or replace function public.is_nrc_downline(p_owner_id uuid)
returns boolean
language sql stable security definer set search_path=public as $$
  select exists(
    select 1
    from public.profiles target
    cross join lateral (
      select payload from public.nrc_sync_snapshots
      where owner_id = auth.uid() and snapshot_type = 'combined'
      order by collected_at desc
      limit 1
    ) latest
    cross join lateral jsonb_array_elements(coalesce(latest.payload->'rstLst','[]'::jsonb)) as elem
    where target.id = p_owner_id
      and elem->>'userId' = target.member_no
  )
$$;

revoke all on function public.is_nrc_downline(uuid) from public;
grant execute on function public.is_nrc_downline(uuid) to authenticated;

-- can_access_owner에 "NRC 계보상 실제 하위면 읽기 권한 자동 부여" 조건을 추가한다.
-- 팀/공유권한(sharing_grants) 경로는 그대로 남아있어, 계보에 안 잡히는 관계는
-- 지금처럼 수동으로 파트너 임명해서 공유할 수 있다.
-- 고객(customers)·수당(commission)처럼 더 민감한 항목은 자동 공유 대상에서 제외했다.
create or replace function public.can_access_owner(p_owner_id uuid,p_resource public.share_resource,p_write boolean default false)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid()=p_owner_id
    or exists(
      select 1
        from public.sharing_grants g
        join public.team_members viewer on viewer.team_id=g.team_id and viewer.user_id=auth.uid() and viewer.active
        join public.team_members owner_m on owner_m.team_id=g.team_id and owner_m.user_id=p_owner_id and owner_m.active
       where g.viewer_id=auth.uid() and g.owner_id=p_owner_id and g.resource=p_resource
         and g.can_read and (not p_write or g.can_write)
         and g.valid_from<=now() and (g.valid_until is null or g.valid_until>now())
    )
    or (
      not p_write
      and p_resource in ('activity','checklist','performance','organization_summary')
      and public.is_nrc_downline(p_owner_id)
    )
$$;

commit;
