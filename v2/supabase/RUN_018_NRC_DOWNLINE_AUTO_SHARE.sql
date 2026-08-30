-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- NRC 계보상 실제 하위 회원이면, 팀/파트너 임명 없이도 고객·활동·체크리스트·실적·조직
-- 자료를 자동으로 읽을 수 있게 합니다(읽기 전용). 수당처럼 더 민감한 항목과
-- 계보에 안 잡히는 관계는 지금처럼 "팀" 메뉴에서 수동으로 공유해야 합니다.

begin;

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
      and p_resource in ('customers','activity','checklist','performance','organization_summary')
      and public.is_nrc_downline(p_owner_id)
    )
$$;

commit;
