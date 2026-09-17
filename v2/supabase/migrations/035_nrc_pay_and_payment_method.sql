begin;

alter table public.profiles
  add column if not exists nrc_pay_balance numeric not null default 0;

alter table public.customers
  add column if not exists payment_method text;

commit;
