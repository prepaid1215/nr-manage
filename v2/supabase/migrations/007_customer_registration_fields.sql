begin;

alter table public.customers add column if not exists contact_phone text;
alter table public.customers add column if not exists subscription_type text;
alter table public.customers add column if not exists manager text;
alter table public.customers add column if not exists contract_months integer not null default 0;
alter table public.customers add column if not exists process_no text;
alter table public.customers add column if not exists seller text;
alter table public.customers add column if not exists status text not null default '사용중';
alter table public.customers add column if not exists last_reminder_sent_at date;

grant select, insert, update, delete on table public.customers to authenticated;

commit;
