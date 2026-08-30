begin;

create or replace function public.get_self_closings(p_member_ids text[])
returns table(
  member_no text,
  major_nv numeric,
  minor_nv numeric,
  completed_nv numeric,
  completed_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select p.top_member_id, p.top_major_nv, p.top_minor_nv, p.top_completed_nv, p.completed_at
  from public.nrc_closing_plans p
  join public.profiles pr on pr.id = p.owner_id
  where p.top_member_id = any(p_member_ids)
    and p.status = 'DONE'
    and p.completed_at is not null
    and pr.member_no = p.top_member_id
$$;

revoke all on function public.get_self_closings(text[]) from public;
grant execute on function public.get_self_closings(text[]) to authenticated;

commit;
