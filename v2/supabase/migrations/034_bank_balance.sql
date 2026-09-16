begin;

alter table public.profiles
  add column if not exists bank_balance_base numeric not null default 0,
  add column if not exists bank_balance_anchor numeric not null default 0;

commit;
