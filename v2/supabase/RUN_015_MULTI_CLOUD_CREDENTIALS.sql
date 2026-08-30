-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 사업자 1명이 NRC 계정을 여러 개 동시에 공유 수집 승인·저장할 수 있게 합니다.

begin;

alter table public.nrc_cloud_credentials drop constraint nrc_cloud_credentials_pkey;
alter table public.nrc_cloud_credentials add primary key (owner_id, source_account_id);

commit;
