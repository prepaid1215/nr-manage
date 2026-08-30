-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- cloud_service.py의 /devices 엔드포인트(service_role 키 사용)가 nrc_sync_devices를
-- 조회할 수 있도록 권한을 부여합니다. 013 마이그레이션에서 authenticated 역할에만
-- GRANT하고 service_role은 빠뜨려서 "permission denied for table nrc_sync_devices"
-- (42501) 오류가 발생했습니다.

begin;

grant select on public.nrc_sync_devices to service_role;

commit;
