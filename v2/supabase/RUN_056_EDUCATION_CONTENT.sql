-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요. (RUN_055와 따로 실행해도 됩니다.)
-- 교육 탭의 내용(제목·본문·참고·사진)을 관리자가 앱에서 고쳐 저장할 수 있게 한다.
-- 새 표 하나와 사진 보관함(Storage) 하나만 추가한다. 기존 표는 건드리지 않고, 여러 번 실행해도 안전하다.
--
-- 규칙
--  * 교육 내용은 한 줄(id='main')에 통째로 저장한다. 읽기는 로그인한 모두, 쓰기는 관리자(app_admins)만 가능하다.
--  * 이 줄이 없으면 앱은 기본 교육 내용(코드에 들어 있는 값)을 그대로 보여 준다.
--  * 사진은 'education' 보관함에 저장한다. 주소를 아는 사람은 누구나 볼 수 있는 공개 보관함이고,
--    올리기·바꾸기·지우기는 관리자만 가능하다. 사진에는 개인정보나 계정 정보를 올리지 않는다.

begin;

create table if not exists public.nrc_education_content (
  id text primary key,
  content jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.nrc_education_content enable row level security;

drop policy if exists education_content_read on public.nrc_education_content;
create policy education_content_read on public.nrc_education_content
  for select using (auth.uid() is not null);

drop policy if exists education_content_admin_insert on public.nrc_education_content;
create policy education_content_admin_insert on public.nrc_education_content
  for insert with check (public.is_app_admin());

drop policy if exists education_content_admin_update on public.nrc_education_content;
create policy education_content_admin_update on public.nrc_education_content
  for update using (public.is_app_admin()) with check (public.is_app_admin());

grant select, insert, update on public.nrc_education_content to authenticated;
grant select, insert, update, delete on public.nrc_education_content to service_role;

-- 사진 보관함
insert into storage.buckets (id, name, public)
values ('education', 'education', true)
on conflict (id) do update set public = true;

drop policy if exists education_photos_admin_insert on storage.objects;
create policy education_photos_admin_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'education' and public.is_app_admin());

drop policy if exists education_photos_admin_update on storage.objects;
create policy education_photos_admin_update on storage.objects
  for update to authenticated using (bucket_id = 'education' and public.is_app_admin());

drop policy if exists education_photos_admin_delete on storage.objects;
create policy education_photos_admin_delete on storage.objects
  for delete to authenticated using (bucket_id = 'education' and public.is_app_admin());

commit;

notify pgrst, 'reload schema';

-- 확인: 두 값 모두 true가 나와야 한다.
select has_table_privilege('authenticated', 'public.nrc_education_content', 'select') as authenticated_can_read,
       exists(select 1 from storage.buckets where id = 'education' and public) as photo_bucket_ready;
