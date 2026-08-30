begin;

alter table public.nrc_cloud_credentials drop constraint nrc_cloud_credentials_pkey;
alter table public.nrc_cloud_credentials add primary key (owner_id, source_account_id);

commit;
