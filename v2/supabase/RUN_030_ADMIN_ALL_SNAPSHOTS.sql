-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 관리자가 마감 실적 계산기에서 "다른 계정 자동 연결"을 누르면, 모든 가입자의
-- 최신 계보 JSON을 한 번에 불러와 프런트에서 겹치는 회원 기준으로 이어붙입니다.

begin;

create or replace function public.admin_all_latest_snapshots()
returns table(
  user_id uuid,
  username text,
  name text,
  source_account_id text,
  payload jsonb,
  collected_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    raise exception 'admin access required';
  end if;
  return query
  select distinct on (s.owner_id)
    s.owner_id, p.username, p.name, s.source_account_id, s.payload, s.collected_at
  from public.nrc_sync_snapshots s
  join public.profiles p on p.id = s.owner_id
  where s.snapshot_type = 'combined'
  order by s.owner_id, s.collected_at desc;
end
$$;

revoke all on function public.admin_all_latest_snapshots() from public;
grant execute on function public.admin_all_latest_snapshots() to authenticated;

commit;
