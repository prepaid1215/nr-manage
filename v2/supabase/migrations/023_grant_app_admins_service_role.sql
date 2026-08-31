begin;

-- cloud_service.py의 /devices 엔드포인트가 관리자만 전체 수집 PC 목록을 보게
-- app_admins를 service_role 키로 조회하도록 바뀌었는데, 021 마이그레이션에서
-- authenticated 역할에만 GRANT하고 service_role은 빠뜨려서
-- "permission denied for table app_admins" (42501) 오류가 발생한다.

grant select on public.app_admins to service_role;

commit;
