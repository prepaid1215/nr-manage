begin;

grant usage on schema public to authenticated;

grant select, insert, update, delete on table public.customers to authenticated;
grant select, insert, update, delete on table public.daily_activities to authenticated;
grant select, insert, update, delete on table public.checklist_progress to authenticated;
grant select, insert, update, delete on table public.sales_snapshots to authenticated;
grant select, insert, update, delete on table public.commissions to authenticated;
grant select, insert, update, delete on table public.closing_sales to authenticated;

commit;
