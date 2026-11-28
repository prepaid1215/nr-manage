-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요. 여러 번 실행해도 안전합니다.
-- 고객 등록에서 개통방법이 "지점방문"일 때 어느 지점을 방문했는지 적는 칸(visit_branch)을 저장하는 열을 더합니다.
-- 기존 고객 자료와 권한(RLS)은 바꾸지 않고, 열 하나만 추가합니다.
--
-- 이 SQL을 실행하기 전에도 고객 등록은 동작합니다. 그때는 방문 지점이 열 대신 메모 끝에 "방문 지점: ○○점"으로 남습니다.

alter table public.customers add column if not exists visit_branch text;

notify pgrst, 'reload schema';

-- 확인: visit_branch 한 줄이 나오면 적용된 것입니다.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'customers' and column_name = 'visit_branch';
