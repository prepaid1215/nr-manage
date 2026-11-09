-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- "내 계보도" 탭에서 클릭해서 불을 켠(선택한) 사람의 본코드 번호를 저장하는 표입니다.
-- 한 사람은 본코드·서브1·서브2 3개 코드가 한 몸이라 본코드 번호 하나로 사람을 저장합니다.
-- 켜진 사람이 하나라도 있으면 그 사람들만으로 계보도를 구성합니다. 내 계정에서만 보이고 쓸 수 있습니다.
-- 여러 번 실행해도 안전합니다.

begin;

create table if not exists public.nrc_custom_tree_picks (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  member_no text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, member_no)
);

alter table public.nrc_custom_tree_picks enable row level security;
drop policy if exists nrc_custom_tree_picks_owner_all on public.nrc_custom_tree_picks;
create policy nrc_custom_tree_picks_owner_all on public.nrc_custom_tree_picks
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, delete on public.nrc_custom_tree_picks to authenticated;

commit;
