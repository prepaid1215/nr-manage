-- Supabase SQL Editor에서 각 사용자를 impersonate하거나 JWT sub를 바꿔 검증할 권한표.
-- 기대값: 임영은 -> 한수진/주영돈/이호정 true, 한수진 -> 주영돈 true,
-- 한수진 -> 이호정 false, 주영돈 -> 모두 false.

select public.can_access_owner(':han_uuid','customers',false) as can_see_han,
       public.can_access_owner(':joo_uuid','customers',false) as can_see_joo,
       public.can_access_owner(':lee_uuid','customers',false) as can_see_lee;
