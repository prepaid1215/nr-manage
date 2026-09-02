-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 신규개통양도/재구매양도를 건별로(누구에게 얼마) 남기는 테이블을 추가합니다.
-- 지금까지는 daily_activities에 하루 총액만 쌓여서 누구 건인지 알 수
-- 없었습니다. 이제부터 추가하는 건은 고객(또는 이름 없이)과 금액이
-- 같이 저장되고, 목록에서 확인하거나 건별로 취소(삭제)할 수 있습니다.
-- (지금까지 쌓인 과거 총액은 그대로 두고 건드리지 않습니다.)

begin;

create table if not exists public.transfer_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  team_id uuid references public.teams(id),
  activity_date date not null,
  field text not null check(field in ('new_transfer','repurchase')),
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  amount numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists transfer_records_owner_date_idx
  on public.transfer_records(owner_id, activity_date);

alter table public.transfer_records enable row level security;

drop policy if exists transfer_records_access on public.transfer_records;
create policy transfer_records_access on public.transfer_records
  for select using(public.can_access_owner(owner_id,'activity',false));

drop policy if exists transfer_records_write on public.transfer_records;
create policy transfer_records_write on public.transfer_records
  for all using(public.can_access_owner(owner_id,'activity',true))
  with check(public.can_access_owner(owner_id,'activity',true));

grant select, insert, update, delete on public.transfer_records to authenticated;

commit;
