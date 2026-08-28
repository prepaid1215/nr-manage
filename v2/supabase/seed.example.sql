-- Supabase Auth에서 네 사용자를 만든 뒤 UUID를 아래 값에 대입해 실행한다.
-- :im_uuid, :han_uuid, :joo_uuid, :lee_uuid

insert into public.profiles(id,member_no,name) values
  (':im_uuid','2884741','임영은'),(':han_uuid','한수진회원번호','한수진'),(':joo_uuid','주영돈회원번호','주영돈'),(':lee_uuid','이호정회원번호','이호정');

insert into public.teams(id,name,owner_id) values(':team_uuid','임영은 팀',':im_uuid');
insert into public.team_members(team_id,user_id,role) values
  (':team_uuid',':im_uuid','OWNER'),(':team_uuid',':han_uuid','MEMBER'),(':team_uuid',':joo_uuid','MEMBER'),(':team_uuid',':lee_uuid','MEMBER');

insert into public.management_relations(team_id,manager_id,member_id,created_by) values
  (':team_uuid',':im_uuid',':han_uuid',':im_uuid'),(':team_uuid',':han_uuid',':joo_uuid',':im_uuid'),(':team_uuid',':im_uuid',':lee_uuid',':im_uuid');

-- 임영은은 세 사람의 업무 요약을, 한수진은 주영돈만 볼 수 있다. 주영돈과 이호정은 타인 권한이 없다.
insert into public.sharing_grants(team_id,viewer_id,owner_id,resource,can_read,can_write,created_by)
select ':team_uuid',v,o,resource::public.share_resource,true,false,':im_uuid'
from (values(':im_uuid',':han_uuid'),(':im_uuid',':joo_uuid'),(':im_uuid',':lee_uuid'),(':han_uuid',':joo_uuid')) x(v,o)
cross join unnest(array['customers','activity','checklist','sales_summary','performance','organization_summary','closing_sales']) as resources(resource);
