-- NRC Management v2 권한 복구 실행 파일
-- Supabase Dashboard > SQL Editor에서 전체 선택 후 Run 하세요.
-- GRANT 문은 여러 번 실행해도 안전합니다.

begin;

grant usage on schema public to authenticated;

-- 006_authenticated_table_grants.sql
grant select, insert, update, delete on table public.customers to authenticated;
grant select, insert, update, delete on table public.daily_activities to authenticated;
grant select, insert, update, delete on table public.checklist_progress to authenticated;
grant select, insert, update, delete on table public.sales_snapshots to authenticated;
grant select, insert, update, delete on table public.commissions to authenticated;
grant select, insert, update, delete on table public.closing_sales to authenticated;

-- 005_local_sync_snapshots.sql에서 필요한 권한도 함께 복구
grant select, insert on table public.nrc_sync_snapshots to authenticated;
grant usage, select on sequence public.nrc_sync_snapshots_id_seq to authenticated;

-- 008_team_table_grants.sql
grant select, insert, update, delete on table public.teams to authenticated;
grant select, insert, update, delete on table public.team_members to authenticated;
grant select, insert, update, delete on table public.management_relations to authenticated;
grant select, insert, update, delete on table public.sharing_grants to authenticated;
grant select on table public.profiles to authenticated;
grant select on table public.audit_logs to authenticated;

-- 회원가입 후 본인 프로필 수정 권한
grant update on table public.profiles to authenticated;

-- RLS 정책에서 호출하는 함수 실행 권한
grant execute on function public.is_team_owner(uuid) to authenticated;
grant execute on function public.can_access_owner(
  uuid,
  public.share_resource,
  boolean
) to authenticated;
grant execute on function public.is_team_owner_of_member(uuid) to authenticated;

commit;

-- 아래 결과가 모두 true면 테이블 권한 연결 완료
select
  has_table_privilege('authenticated', 'public.customers', 'select') as customers_select,
  has_table_privilege('authenticated', 'public.daily_activities', 'select') as activities_select,
  has_table_privilege('authenticated', 'public.checklist_progress', 'select') as checklist_select,
  has_table_privilege('authenticated', 'public.checklist_progress', 'insert') as checklist_insert,
  has_table_privilege('authenticated', 'public.checklist_progress', 'update') as checklist_update,
  has_table_privilege('authenticated', 'public.commissions', 'select') as commissions_select,
  has_table_privilege('authenticated', 'public.closing_sales', 'select') as closing_select,
  has_table_privilege('authenticated', 'public.nrc_sync_snapshots', 'select') as snapshots_select,
  has_table_privilege('authenticated', 'public.nrc_sync_snapshots', 'insert') as snapshots_insert,
  has_table_privilege('authenticated', 'public.teams', 'select') as teams_select,
  has_table_privilege('authenticated', 'public.team_members', 'select') as team_members_select,
  has_table_privilege('authenticated', 'public.sharing_grants', 'select') as sharing_grants_select;
