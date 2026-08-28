begin;

create table public.customers (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), team_id uuid references public.teams(id),
  activation_date date, member_no text, name text not null, phone text, network text, plan text, activation_type text, activation_method text, source text,
  attribution numeric not null default 0, memo text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.daily_activities (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), team_id uuid references public.teams(id), activity_date date not null,
  new_transfer numeric not null default 0, repurchase numeric not null default 0, balance numeric not null default 0, attendance integer not null default 0,
  a_sales numeric not null default 0, b_sales numeric not null default 0, tasks jsonb not null default '[]', content jsonb not null default '{}', updated_at timestamptz not null default now(), unique(owner_id,activity_date)
);
create table public.checklist_progress (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), team_id uuid references public.teams(id), item_key text not null,
  checked boolean not null default false, memo text, updated_at timestamptz not null default now(), unique(owner_id,item_key)
);
create table public.sales_snapshots (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), team_id uuid references public.teams(id),
  pay_date date not null, closing_round smallint check(closing_round between 1 and 4), own_nv numeric not null default 0, major_nv numeric not null default 0, minor_nv numeric not null default 0,
  source text not null default 'NRC_SYNC', raw jsonb, created_at timestamptz not null default now(), unique(owner_id,pay_date)
);
create table public.commissions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), team_id uuid references public.teams(id), year smallint not null, month smallint not null,
  round smallint not null check(round between 1 and 4), amount numeric not null default 0, updated_at timestamptz not null default now(), unique(owner_id,year,month,round)
);
create table public.closing_sales (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), team_id uuid references public.teams(id), year smallint not null, month smallint not null,
  round smallint not null check(round between 1 and 4), auto_sales numeric not null default 0, closing_sales numeric not null default 0, card_sales numeric not null default 0, rank_close text,
  updated_at timestamptz not null default now(), unique(owner_id,year,month,round)
);

alter table public.customers enable row level security; alter table public.daily_activities enable row level security; alter table public.checklist_progress enable row level security;
alter table public.sales_snapshots enable row level security; alter table public.commissions enable row level security; alter table public.closing_sales enable row level security;

create policy customers_read on public.customers for select using(public.can_access_owner(owner_id,'customers',false));
create policy customers_insert on public.customers for insert with check(owner_id=auth.uid());
create policy customers_update on public.customers for update using(public.can_access_owner(owner_id,'customers',true)) with check(public.can_access_owner(owner_id,'customers',true));
create policy customers_delete on public.customers for delete using(public.can_access_owner(owner_id,'customers',true));
create policy activities_access on public.daily_activities for select using(public.can_access_owner(owner_id,'activity',false));
create policy activities_own_write on public.daily_activities for all using(public.can_access_owner(owner_id,'activity',true)) with check(public.can_access_owner(owner_id,'activity',true));
create policy checklist_access on public.checklist_progress for select using(public.can_access_owner(owner_id,'checklist',false));
create policy checklist_write on public.checklist_progress for all using(public.can_access_owner(owner_id,'checklist',true)) with check(public.can_access_owner(owner_id,'checklist',true));
create policy sales_access on public.sales_snapshots for select using(public.can_access_owner(owner_id,'performance',false));
create policy sales_own_write on public.sales_snapshots for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create policy commission_private on public.commissions for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create policy closing_access on public.closing_sales for select using(public.can_access_owner(owner_id,'closing_sales',false));
create policy closing_write on public.closing_sales for all using(public.can_access_owner(owner_id,'closing_sales',true)) with check(public.can_access_owner(owner_id,'closing_sales',true));

commit;
