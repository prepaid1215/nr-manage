-- Supabase SQL Editor에서 이 파일 하나만 실행하면 됩니다.
-- 내 정보 연락처 칼럼과 이름·회원번호 기반 신규 가입을 함께 적용합니다.

begin;

alter table public.profiles
  add column if not exists phone text,
  add column if not exists contact_email text,
  add column if not exists business_name text,
  add column if not exists address text;

grant select, update on table public.profiles to authenticated;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_username text:=lower(trim(new.raw_user_meta_data->>'username'));
  v_name text:=trim(new.raw_user_meta_data->>'name');
  v_member_no text:=trim(new.raw_user_meta_data->>'member_no');
begin
  if v_username is null or v_username !~ '^[a-z0-9._-]{4,30}$' then raise exception '아이디 형식을 확인하세요.'; end if;
  if v_name is null or length(v_name) < 2 then raise exception '이름은 두 글자 이상 입력하세요.'; end if;
  if v_member_no is null or v_member_no !~ '^[0-9]{4,20}$' then raise exception '회원번호는 숫자 4~20자로 입력하세요.'; end if;
  insert into public.profiles(id,username,member_no,name,status)
  values(new.id,v_username,v_member_no,v_name,'ACTIVE');
  return new;
end; $$;

commit;
