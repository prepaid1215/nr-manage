begin;

-- wndudehsim 계정만 자신의 관리자 권한을 스스로 켜고 끌 수 있게 한다.
-- 다른 계정이 이 함수를 호출해도 이메일이 일치하지 않으면 예외로 막힌다.
create or replace function public.toggle_self_admin()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_is_admin boolean;
begin
  select email into v_email from auth.users where id = auth.uid();
  if v_email is distinct from 'app-wndudehsim@nrc-members.com' then
    raise exception '권한이 없습니다.';
  end if;

  select exists(select 1 from public.app_admins where user_id = auth.uid()) into v_is_admin;
  if v_is_admin then
    delete from public.app_admins where user_id = auth.uid();
    return false;
  else
    insert into public.app_admins(user_id) values (auth.uid());
    return true;
  end if;
end;
$$;

revoke all on function public.toggle_self_admin() from public;
grant execute on function public.toggle_self_admin() to authenticated;

commit;
