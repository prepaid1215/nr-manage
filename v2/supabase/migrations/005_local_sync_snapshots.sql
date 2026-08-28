begin;

create table if not exists public.nrc_sync_snapshots (
  id bigint generated always as identity primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  source_account_id text,
  snapshot_type text not null check (snapshot_type in ('combined','consumers','sales','closings')),
  payload jsonb not null,
  collected_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists nrc_sync_snapshots_owner_type_date
  on public.nrc_sync_snapshots(owner_id,snapshot_type,collected_at desc);

alter table public.nrc_sync_snapshots enable row level security;
drop policy if exists nrc_sync_snapshots_owner_read on public.nrc_sync_snapshots;
drop policy if exists nrc_sync_snapshots_owner_insert on public.nrc_sync_snapshots;
create policy nrc_sync_snapshots_owner_read on public.nrc_sync_snapshots
  for select using(owner_id=auth.uid());
create policy nrc_sync_snapshots_owner_insert on public.nrc_sync_snapshots
  for insert with check(owner_id=auth.uid());
grant select,insert on public.nrc_sync_snapshots to authenticated;
grant usage,select on sequence public.nrc_sync_snapshots_id_seq to authenticated;

commit;
