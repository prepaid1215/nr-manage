begin;

alter table public.profiles
  add column if not exists phone text,
  add column if not exists contact_email text,
  add column if not exists business_name text,
  add column if not exists address text;

commit;
