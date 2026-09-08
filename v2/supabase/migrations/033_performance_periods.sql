begin;

alter table public.nrc_closing_plans
  add column if not exists period_id text;
alter table public.nrc_closing_plans
  add column if not exists period_year smallint;
alter table public.nrc_closing_plans
  add column if not exists period_month smallint;
alter table public.nrc_closing_plans
  add column if not exists closing_round smallint;

update public.nrc_closing_plans
set period_id = coalesce(period_id, 'legacy')
where period_id is null;

alter table public.nrc_closing_plans
  alter column period_id set default 'legacy';
alter table public.nrc_closing_plans
  alter column period_id set not null;

alter table public.nrc_closing_plans
  drop constraint if exists nrc_closing_plans_owner_id_top_member_id_key;
alter table public.nrc_closing_plans
  drop constraint if exists nrc_closing_plans_owner_id_period_id_top_member_id_key;
alter table public.nrc_closing_plans
  add constraint nrc_closing_plans_owner_id_period_id_top_member_id_key
  unique (owner_id, period_id, top_member_id);

alter table public.nrc_closing_plans
  drop constraint if exists nrc_closing_plans_period_month_check;
alter table public.nrc_closing_plans
  add constraint nrc_closing_plans_period_month_check
  check (period_month is null or period_month between 1 and 12);
alter table public.nrc_closing_plans
  drop constraint if exists nrc_closing_plans_closing_round_check;
alter table public.nrc_closing_plans
  add constraint nrc_closing_plans_closing_round_check
  check (closing_round is null or closing_round between 1 and 4);

create index if not exists nrc_closing_plans_owner_period
  on public.nrc_closing_plans(owner_id, period_id, updated_at desc);

commit;
