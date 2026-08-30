-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 확인된 NRC 하위의 계보 수집 데이터(nrc_sync_snapshots)를 상위가 읽을 수 있게
-- 허용합니다. 이걸로 조직 화면에서 "이 사업자 계보 보기"로 그 사람 본인 트리를
-- 그대로 열어볼 수 있습니다.

begin;

drop policy if exists nrc_sync_snapshots_downline_read on public.nrc_sync_snapshots;
create policy nrc_sync_snapshots_downline_read on public.nrc_sync_snapshots
  for select using (public.is_nrc_downline(owner_id));

commit;
