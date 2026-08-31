-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 마감매출의 자동매출을 A라인/B라인으로 나눠 저장하기 위한 컬럼을 추가합니다.

begin;

alter table public.closing_sales
  add column if not exists auto_sales_a numeric not null default 0,
  add column if not exists auto_sales_b numeric not null default 0;

-- 기존에 저장돼 있던 자동매출 합계는 A라인으로 옮겨두고, B라인은 0부터 새로 입력한다.
update public.closing_sales
set auto_sales_a = auto_sales
where auto_sales_a = 0 and auto_sales <> 0;

commit;
