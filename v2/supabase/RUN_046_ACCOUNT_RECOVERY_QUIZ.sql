begin;

-- No client can read answer hashes, even the owner or an application administrator.
create table public.account_recovery_quizzes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  question text not null check (question in ('secret_word', 'memory_place', 'nickname')),
  answer_salt text not null check (answer_salt ~ '^[0-9a-f]{32}$'),
  answer_hash text not null check (answer_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);
create table public.account_recovery_attempts (
  key text primary key,
  attempts integer not null default 1,
  expires_at timestamptz not null default (now() + interval '15 minutes')
);
alter table public.account_recovery_quizzes enable row level security;
alter table public.account_recovery_attempts enable row level security;
revoke all on public.account_recovery_quizzes, public.account_recovery_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.account_recovery_quizzes, public.account_recovery_attempts to service_role;
-- Existing NRC schemas do not automatically grant this server role access to these tables.
grant select (id, username, member_no, name, status) on public.profiles to service_role;
grant insert (actor_id, action, target_type, target_id, result, detail) on public.audit_logs to service_role;
grant usage on sequence public.audit_logs_id_seq to service_role;

-- Atomic across gunicorn threads, workers and restarts. Both modes share the member counter.
create function public.consume_account_recovery_attempt(p_account_key text, p_client_key text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_key text;
  v_count integer;
  v_allowed boolean := true;
begin
  if p_account_key !~ '^[0-9a-f]{64}$' or p_client_key !~ '^[0-9a-f]{64}$'
     or p_account_key is null or p_client_key is null then
    return false;
  end if;
  -- Sorted keys prevent concurrent requests from taking locks in opposite order.
  for v_key in select k from unnest(array['account:' || p_account_key, 'client:' || p_client_key]) k order by k loop
    insert into public.account_recovery_attempts as a (key, attempts, expires_at)
      values (v_key, 1, now() + interval '15 minutes')
    on conflict (key) do update set
      attempts = case when a.expires_at <= now() then 1 else least(a.attempts + 1, 1000000) end,
      expires_at = case when a.expires_at <= now() then now() + interval '15 minutes' else a.expires_at end
    returning attempts into v_count;
    if v_count > (case when v_key like 'account:%' then 5 else 30 end) then
      v_allowed := false;
    end if;
  end loop;
  delete from public.account_recovery_attempts where key in (
    select a.key from public.account_recovery_attempts a
    where a.expires_at < now() - interval '1 day'
    limit 100 for update skip locked
  );
  return v_allowed;
end;
$$;
revoke all on function public.consume_account_recovery_attempt(text, text) from public, anon, authenticated;
grant execute on function public.consume_account_recovery_attempt(text, text) to service_role;

commit;
