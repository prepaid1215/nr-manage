-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요. 이미 RUN_052를 적용한 DB에 빠진 권한만 더합니다.
-- Render 서버(service_role 키)가 수집 작업을 줄 때 nrc_tracked_members(등록한 하위 회원)를 읽을 수 있게 한다.
-- 이 권한이 없으면 "permission denied for table nrc_tracked_members"가 나고, 서버는 수집을 막지 않으려고 빈 목록을
-- 돌려줘서 등록한 사람이 수집에 들어가지 않는다. 여러 번 실행해도 안전하다.

grant select on public.nrc_tracked_members to service_role;
notify pgrst, 'reload schema';

-- 확인: true가 나와야 한다.
select has_table_privilege('service_role', 'public.nrc_tracked_members', 'select') as service_role_can_read;
