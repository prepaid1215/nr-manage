-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 마감 실적 계산기의 마감 계획(최상위 사업자·목표·자동 배분·완료값)을
-- 사용자별로 저장하는 nrc_closing_plans 테이블과 RLS 정책을 만듭니다.

begin;

create table if not exists public.nrc_closing_plans (
  id bigint generated always as identity primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  top_member_id text not null,
  top_major_target numeric not null check (top_major_target > 0),
  top_minor_target numeric not null check (top_minor_target > 0),
  closing_member_ids jsonb not null default '[]'::jsonb,
  allocation jsonb,
  placements jsonb,
  completions jsonb not null default '{}'::jsonb,
  top_major_nv numeric,
  top_minor_nv numeric,
  top_completed_nv numeric,
  verified boolean not null default false,
  status text not null default 'DRAFT' check (status in ('DRAFT','DONE')),
  completed_at timestamptz,
  snapshot_source_account_id text,
  snapshot_collected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, top_member_id)
);

create index if not exists nrc_closing_plans_owner_updated
  on public.nrc_closing_plans(owner_id, updated_at desc);

alter table public.nrc_closing_plans enable row level security;
drop policy if exists nrc_closing_plans_owner_select on public.nrc_closing_plans;
drop policy if exists nrc_closing_plans_owner_insert on public.nrc_closing_plans;
drop policy if exists nrc_closing_plans_owner_update on public.nrc_closing_plans;
drop policy if exists nrc_closing_plans_owner_delete on public.nrc_closing_plans;
create policy nrc_closing_plans_owner_select on public.nrc_closing_plans
  for select using(owner_id=auth.uid());
create policy nrc_closing_plans_owner_insert on public.nrc_closing_plans
  for insert with check(owner_id=auth.uid());
create policy nrc_closing_plans_owner_update on public.nrc_closing_plans
  for update using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create policy nrc_closing_plans_owner_delete on public.nrc_closing_plans
  for delete using(owner_id=auth.uid());
grant select,insert,update,delete on public.nrc_closing_plans to authenticated;
grant usage,select on sequence public.nrc_closing_plans_id_seq to authenticated;

commit;
