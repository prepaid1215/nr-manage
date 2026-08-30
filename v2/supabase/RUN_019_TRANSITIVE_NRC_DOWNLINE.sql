-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- "내 계보엔 안 보이지만, 내 하위의 계보엔 보이는" 사람도 자동 공유 대상으로
-- 인정하도록 is_nrc_downline()을 재귀적으로 확장합니다. 중간 하위가 앱 계정으로
-- 가입해서 본인 계보를 한 번이라도 수집해둔 경우에만 연결됩니다.

begin;

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
