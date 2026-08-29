-- Supabase SQL Editor에서 한 번만 실행하세요.
-- 설정 > 내 정보의 전화번호, 이메일, 상호명, 주소 저장에 필요합니다.

begin;

alter table public.profiles
  add column if not exists phone text,
  add column if not exists contact_email text,
  add column if not exists business_name text,
  add column if not exists address text;

grant select, update on table public.profiles to authenticated;

commit;
