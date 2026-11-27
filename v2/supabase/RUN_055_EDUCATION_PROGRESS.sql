-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 교육 탭의 완료 체크를 계정에 저장하고, NRC 계보 위쪽 계정이 아래 사람의 진행 상황을 볼 수 있게 한다.
-- 새 표 하나와 함수 하나만 추가한다. 기존 표는 건드리지 않고, 여러 번 실행해도 안전하다.
--
-- 규칙
--  * 체크 저장·삭제는 본인 것만 가능하다.
--  * 위에서 아래로만 읽힌다. 읽는 쪽은 get_downline_education_progress() 함수뿐이고, 호출한 사람의
--    가장 최근 계보 수집(rstLst)에 들어 있는 아래 회원만 돌려준다. 아래에서 위, 옆 라인은 읽을 수 없다.
--  * 표 자체에는 본인 행만 읽는 정책을 둔다(다른 사람이 표를 직접 조회하지 못함).

begin;

create table if not exists public.nrc_education_progress (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null,
  done_at timestamptz not null default now(),
  primary key (owner_id, item_id)
);

alter table public.nrc_education_progress enable row level security;

drop policy if exists education_progress_own_read on public.nrc_education_progress;
create policy education_progress_own_read on public.nrc_education_progress
  for select using (owner_id = auth.uid());

drop policy if exists education_progress_own_insert on public.nrc_education_progress;
create policy education_progress_own_insert on public.nrc_education_progress
  for insert with check (owner_id = auth.uid());

drop policy if exists education_progress_own_delete on public.nrc_education_progress;
create policy education_progress_own_delete on public.nrc_education_progress
  for delete using (owner_id = auth.uid());

-- 새 표는 authenticated뿐 아니라 Render 서버가 쓰는 service_role에도 권한을 준다.
grant select, insert, delete on public.nrc_education_progress to authenticated;
grant select, insert, update, delete on public.nrc_education_progress to service_role;

-- 내 NRC 계보 아래에 있는 앱 사용자의 교육 완료 항목.
create or replace function public.get_downline_education_progress()
returns table(
  member_no text,
  member_name text,
  done_count int,
  last_done_at timestamptz,
  done_ids text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select s.payload
    from public.nrc_sync_snapshots s
    where s.owner_id = auth.uid() and s.snapshot_type = 'combined'
    order by s.collected_at desc
    limit 1
  ),
  members as (
    select distinct elem ->> 'userId' as uid
    from latest
    cross join lateral jsonb_array_elements(coalesce(latest.payload -> 'rstLst', '[]'::jsonb)) as elem
  )
  select pr.member_no,
         pr.name,
         count(e.item_id)::int,
         max(e.done_at),
         coalesce(array_agg(e.item_id order by e.item_id) filter (where e.item_id is not null), '{}')
  from members m
  join public.profiles pr on pr.member_no = m.uid and pr.id <> auth.uid()
  left join public.nrc_education_progress e on e.owner_id = pr.id
  where auth.uid() is not null
  group by pr.member_no, pr.name
  order by pr.name
$$;

revoke all on function public.get_downline_education_progress() from public;
grant execute on function public.get_downline_education_progress() to authenticated;

commit;

notify pgrst, 'reload schema';

-- 확인: 두 값 모두 true가 나와야 한다.
select has_table_privilege('authenticated', 'public.nrc_education_progress', 'insert') as authenticated_can_write,
       has_table_privilege('service_role', 'public.nrc_education_progress', 'select') as service_role_can_read;
