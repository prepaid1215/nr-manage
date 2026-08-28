begin;

alter table public.profiles add column if not exists username text;
alter table public.profiles alter column member_no drop not null;

update public.profiles
set username=lower(member_no)
where username is null and member_no is not null;

create unique index if not exists profiles_username_unique
  on public.profiles(lower(username)) where username is not null;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_username text:=lower(trim(new.raw_user_meta_data->>'username'));
begin
  if v_username is null or v_username !~ '^[a-z0-9._-]{4,30}$' then
    raise exception '아이디는 영문, 숫자, 점, 밑줄, 하이픈으로 4~30자 입력하세요.';
  end if;
  insert into public.profiles(id,username,name,status)
  values(new.id,v_username,v_username,'ACTIVE');
  return new;
end; $$;

commit;
