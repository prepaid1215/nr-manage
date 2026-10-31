-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 하위 사업자(예: 주영돈 계정)가 이번 차수 "마감 완료"로 확정한 본인 마감 값을,
-- 상위 사업자(예: 한수진 계정)의 마감 실적 계산기가 자동으로 읽어와 반영하게 합니다.
-- (이 함수가 없으면 앱은 조용히 기존 방식 그대로 동작합니다)

begin;

-- 하위(NRC 계보상 아래) 계정이 이번 차수에 "마감 완료"로 확정한 본인 마감 값을 상위가 읽는다.
-- 상위 계정의 마감 실적 계산기가 이 값을 그 하위의 마감 완료로 자동 반영한다.
-- 읽기 범위는 nrc_sync_snapshots 하위 읽기와 같다(public.is_nrc_downline).
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
$$;

revoke all on function public.get_downline_period_closings(text) from public;
grant execute on function public.get_downline_period_closings(text) to authenticated;

commit;
