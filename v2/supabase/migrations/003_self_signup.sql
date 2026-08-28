begin;
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_member_no text:=trim(new.raw_user_meta_data->>'member_no'); v_name text:=trim(new.raw_user_meta_data->>'name');
begin
  if v_member_no is null or v_member_no !~ '^[0-9]{4,20}$' then raise exception '올바른 회원번호가 필요합니다.'; end if;
  if v_name is null or length(v_name)<2 then raise exception '이름은 두 글자 이상이어야 합니다.'; end if;
  insert into public.profiles(id,member_no,name,status) values(new.id,v_member_no,v_name,'ACTIVE');
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_auth_user();
revoke all on public.profiles from anon;
grant select,update on public.profiles to authenticated;
commit;
