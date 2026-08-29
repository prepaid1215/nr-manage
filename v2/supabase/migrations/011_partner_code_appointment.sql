begin;

create or replace function public.can_manage_team(p_team_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.teams t
    where t.id=p_team_id and t.active and (
      t.owner_id=auth.uid() or exists(
        select 1 from public.team_members m
        where m.team_id=t.id and m.user_id=auth.uid() and m.active
          and m.role in ('OWNER','MANAGER')
      )
    )
  )
$$;

create or replace function public.find_partner_by_member_no(p_team_id uuid,p_member_no text)
returns table(user_id uuid,partner_name text,masked_member_no text,already_member boolean)
language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_team(p_team_id) then raise exception '팀 관리 권한이 없습니다.'; end if;
  return query
    select p.id,p.name,
      repeat('*',greatest(length(coalesce(p.member_no,''))-4,0))||right(coalesce(p.member_no,''),4),
      exists(select 1 from public.team_members m where m.team_id=p_team_id and m.user_id=p.id and m.active)
    from public.profiles p
    where p.member_no=trim(p_member_no) and p.status='ACTIVE' and p.id<>auth.uid()
    limit 1;
end; $$;

create or replace function public.appoint_partner_by_member_no(p_team_id uuid,p_member_no text)
returns table(user_id uuid,partner_name text,masked_member_no text)
language plpgsql security definer set search_path=public as $$
declare v_partner public.profiles%rowtype;
begin
  if not public.can_manage_team(p_team_id) then raise exception '팀 관리 권한이 없습니다.'; end if;
  select * into v_partner from public.profiles
   where member_no=trim(p_member_no) and status='ACTIVE' limit 1;
  if v_partner.id is null then raise exception '일치하는 회원코드를 찾지 못했습니다.'; end if;
  if v_partner.id=auth.uid() then raise exception '자기 자신은 파트너로 임명할 수 없습니다.'; end if;
  insert into public.team_members(team_id,user_id,role,active)
    values(p_team_id,v_partner.id,'MEMBER',true)
    on conflict(team_id,user_id) do update set active=true,role='MEMBER';
  insert into public.management_relations(team_id,manager_id,member_id,created_by)
    values(p_team_id,auth.uid(),v_partner.id,auth.uid())
    on conflict(team_id,manager_id,member_id) do nothing;
  insert into public.audit_logs(actor_id,team_id,action,target_type,target_id,result,detail)
    values(auth.uid(),p_team_id,'APPOINT_PARTNER','profile',v_partner.id::text,'SUCCESS',jsonb_build_object('member_no_masked',right(v_partner.member_no,4)));
  return query select v_partner.id,v_partner.name,
    repeat('*',greatest(length(coalesce(v_partner.member_no,''))-4,0))||right(coalesce(v_partner.member_no,''),4);
end; $$;

create or replace function public.list_team_partners(p_team_id uuid)
returns table(user_id uuid,partner_name text,masked_member_no text,partner_role public.team_role)
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.team_members m where m.team_id=p_team_id and m.user_id=auth.uid() and m.active)
     and not public.is_team_owner(p_team_id) then raise exception '팀 조회 권한이 없습니다.'; end if;
  return query
    select p.id,p.name,
      repeat('*',greatest(length(coalesce(p.member_no,''))-4,0))||right(coalesce(p.member_no,''),4),m.role
    from public.team_members m join public.profiles p on p.id=m.user_id
    where m.team_id=p_team_id and m.active order by m.joined_at;
end; $$;

revoke all on function public.can_manage_team(uuid) from public;
revoke all on function public.find_partner_by_member_no(uuid,text) from public;
revoke all on function public.appoint_partner_by_member_no(uuid,text) from public;
revoke all on function public.list_team_partners(uuid) from public;
grant execute on function public.can_manage_team(uuid) to authenticated;
grant execute on function public.find_partner_by_member_no(uuid,text) to authenticated;
grant execute on function public.appoint_partner_by_member_no(uuid,text) to authenticated;
grant execute on function public.list_team_partners(uuid) to authenticated;

commit;
