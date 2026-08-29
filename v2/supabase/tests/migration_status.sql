-- 읽기 전용 점검: SQL Editor에서 실행 후 모두 true인지 확인한다.
-- migration 열은 해당 객체가 처음 만들어지는 파일을 뜻한다.

with required_objects(migration, object_name, object_regclass) as (
  values
    ('001', 'profiles', to_regclass('public.profiles')),
    ('001', 'teams', to_regclass('public.teams')),
    ('001', 'team_members', to_regclass('public.team_members')),
    ('001', 'management_relations', to_regclass('public.management_relations')),
    ('001', 'sharing_grants', to_regclass('public.sharing_grants')),
    ('002', 'customers', to_regclass('public.customers')),
    ('002', 'daily_activities', to_regclass('public.daily_activities')),
    ('002', 'checklist_progress', to_regclass('public.checklist_progress')),
    ('002', 'sales_snapshots', to_regclass('public.sales_snapshots')),
    ('002', 'commissions', to_regclass('public.commissions')),
    ('002', 'closing_sales', to_regclass('public.closing_sales')),
    ('005', 'nrc_sync_snapshots', to_regclass('public.nrc_sync_snapshots'))
)
select migration, object_name, object_regclass is not null as exists
from required_objects
order by migration, object_name;

select
  to_regprocedure('public.is_team_owner(uuid)') is not null as migration_001_owner_fn,
  to_regprocedure('public.can_access_owner(uuid,public.share_resource,boolean)') is not null as migration_001_access_fn,
  to_regprocedure('public.handle_new_auth_user()') is not null as migrations_003_004_signup_fn;

select
  count(*) filter (where column_name = 'contact_phone') = 1 as migration_007_contact_phone,
  count(*) filter (where column_name = 'subscription_type') = 1 as migration_007_subscription_type,
  count(*) filter (where column_name = 'manager') = 1 as migration_007_manager,
  count(*) filter (where column_name = 'process_no') = 1 as migration_007_process_no
from information_schema.columns
where table_schema = 'public' and table_name = 'customers';

with team_tables(table_name) as (
  values ('teams'), ('team_members'), ('management_relations'), ('sharing_grants')
)
select
  table_name,
  has_table_privilege('authenticated', 'public.' || table_name, 'select') as can_select,
  has_table_privilege('authenticated', 'public.' || table_name, 'insert') as can_insert,
  has_table_privilege('authenticated', 'public.' || table_name, 'update') as can_update,
  has_table_privilege('authenticated', 'public.' || table_name, 'delete') as can_delete
from team_tables
order by table_name;

select
  has_table_privilege('authenticated', 'public.profiles', 'select') as migration_008_profiles_select,
  has_table_privilege('authenticated', 'public.audit_logs', 'select') as migration_008_audit_logs_select;
