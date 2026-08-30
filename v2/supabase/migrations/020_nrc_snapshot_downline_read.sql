begin;

-- 확인된 NRC 하위(is_nrc_downline)의 계보 수집 데이터(snapshot)를 읽을 수 있게
-- 허용한다. 이걸로 상위가 조직 화면에서 "이 사업자 계보 보기"로 하위 계정 본인의
-- 계보 트리(그 아래까지)를 그대로 열어볼 수 있다.
drop policy if exists nrc_sync_snapshots_downline_read on public.nrc_sync_snapshots;
create policy nrc_sync_snapshots_downline_read on public.nrc_sync_snapshots
  for select using (public.is_nrc_downline(owner_id));

commit;
