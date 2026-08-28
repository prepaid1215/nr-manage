begin;
grant select, insert, update, delete on public.teams, public.team_members, public.management_relations, public.sharing_grants to authenticated;
grant select on public.profiles, public.audit_logs to authenticated;
commit;
