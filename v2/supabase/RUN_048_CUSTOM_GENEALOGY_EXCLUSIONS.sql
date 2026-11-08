-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- "내 계보도" 탭에서 내가 직접 '제외'한 회원번호를 저장하는 표입니다.
-- 제외는 화면 표시용입니다. 제외한 회원의 하위는 그대로 남고, 실적 계산에는 영향이 없습니다.
-- 내 계정에서만 보이고 쓸 수 있습니다. 여러 번 실행해도 안전합니다.
-- (이 표가 없으면 앱은 제외 없이 기존 방식 그대로 동작합니다)

begin;

create table if not exists public.nrc_custom_tree_exclusions (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  member_no text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, member_no)
);

alter table public.nrc_custom_tree_exclusions enable row level security;
drop policy if exists nrc_custom_tree_exclusions_owner_all on public.nrc_custom_tree_exclusions;
create policy nrc_custom_tree_exclusions_owner_all on public.nrc_custom_tree_exclusions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, delete on public.nrc_custom_tree_exclusions to authenticated;

commit;
