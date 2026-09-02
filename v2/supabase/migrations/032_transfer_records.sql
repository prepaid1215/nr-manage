begin;

-- 신규개통양도/재구매양도는 지금까지 daily_activities에 하루 총액만
-- 쌓여서 "누구 건인지"를 알 수 없었다. 건별로 고객(customer_id, 이름
-- 스냅샷)과 금액을 남겨서 나중에 누구에게 양도했는지 확인하고, 개별
-- 건 단위로 취소(삭제)할 수 있게 한다.
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
