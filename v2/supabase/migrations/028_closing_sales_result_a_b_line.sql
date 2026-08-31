begin;

alter table public.closing_sales
  add column if not exists closing_sales_a numeric not null default 0,
  add column if not exists closing_sales_b numeric not null default 0;

-- 기존에 저장돼 있던 마감매출 합계는 A라인(대실적)으로 옮겨두고, B라인(소실적)은 0부터 새로 입력한다.
update public.closing_sales
set closing_sales_a = closing_sales
where closing_sales_a = 0 and closing_sales <> 0;

commit;
