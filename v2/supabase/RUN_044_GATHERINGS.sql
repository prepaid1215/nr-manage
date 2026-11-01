-- Supabase SQL Editor에서 이 파일 전체를 복사해 한 번 실행하세요.
-- 마케팅 모임: 계보와 상관없이 사람을 한 묶음으로 묶어 서로 뭘 했는지 확인하는 모임입니다.
-- 만든 사람은 팀장이 아니라 초대코드만 보내는 사람이고, 합류해도 누구에게도 실적·계보 읽기 권한이 생기지 않습니다.
-- (RUN_036 팀장 초대코드는 실행하지 않아도 됩니다. 먼저 RUN_043까지 실행된 상태여야 합니다.)

begin;

create extension if not exists pgcrypto;

-- 마케팅 모임: 계보와 상관없이 사람을 한 묶음으로 묶어 서로 뭘 했는지 확인하는 용도.
-- 모임을 만든 사람은 팀장이 아니라 초대코드를 보내는 사람일 뿐이고, 합류해도 누구에게도
-- 실적·계보를 읽는 권한이 생기지 않는다. (관리·오더는 항상 NRC 계보의 상위 계정이 한다.)
alter table public.teams add column if not exists flat boolean not null default false;

create table if not exists public.nrc_gathering_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null default now() + interval '7 days',
  max_uses int not null default 20,
  uses int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.nrc_gathering_invites enable row level security;
revoke all on public.nrc_gathering_invites from anon, authenticated;

create or replace function public.create_gathering(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  if p_name is null or length(trim(p_name)) < 2 then
    raise exception '모임 이름은 두 글자 이상 입력하세요.';
  end if;
  insert into public.teams(name, owner_id, flat)
    values (trim(p_name), auth.uid(), true)
    returning id into v_id;
  insert into public.team_members(team_id, user_id, role, active)
    values (v_id, auth.uid(), 'MEMBER', true);
  return v_id;
end
$$;

-- 모임을 만든 사람만 초대코드를 만든다 (코드는 이때 한 번만 돌려준다).
create or replace function public.create_gathering_invite(p_team_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_code text;
begin
  if not exists (
    select 1 from public.teams t
    where t.id = p_team_id and t.owner_id = auth.uid() and t.flat and t.active
  ) then
    raise exception '모임을 만든 사람만 초대코드를 만들 수 있습니다.';
  end if;
  v_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
  insert into public.nrc_gathering_invites(team_id, created_by, code_hash)
    values (p_team_id, auth.uid(), encode(digest(v_code, 'sha256'), 'hex'));
  return v_code;
end
$$;

-- 초대코드로 합류: 팀원으로만 들어가고, 실적·계보 읽기 권한은 아무에게도 생기지 않는다.
create or replace function public.join_gathering(p_code text)
returns table(team_name text, inviter_name text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inv public.nrc_gathering_invites%rowtype;
  v_team public.teams%rowtype;
  v_inviter public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  select * into v_inv from public.nrc_gathering_invites
   where code_hash = encode(digest(upper(trim(p_code)), 'sha256'), 'hex')
     and active and expires_at > now() and uses < max_uses
   limit 1;
  if v_inv.id is null then raise exception '초대코드가 올바르지 않거나 만료되었습니다.'; end if;
  select * into v_team from public.teams where id = v_inv.team_id and active and flat;
  if v_team.id is null then raise exception '모임을 찾을 수 없습니다.'; end if;
  select * into v_inviter from public.profiles where id = v_inv.created_by;
  insert into public.team_members(team_id, user_id, role, active)
    values (v_inv.team_id, auth.uid(), 'MEMBER', true)
    on conflict (team_id, user_id) do update set active = true;
  update public.nrc_gathering_invites set uses = uses + 1 where id = v_inv.id;
  return query select v_team.name, v_inviter.name;
end
$$;

-- 내가 속한 모임 목록
create or replace function public.get_my_gatherings()
returns table(
  team_id uuid,
  team_name text,
  made_by_me boolean,
  member_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id,
         t.name,
         (t.owner_id = auth.uid()),
         (select count(*)::int from public.team_members x where x.team_id = t.id and x.active)
  from public.teams t
  join public.team_members m on m.team_id = t.id and m.user_id = auth.uid() and m.active
  where t.active and t.flat
  order by t.created_at
$$;

revoke all on function public.create_gathering(text) from public;
revoke all on function public.create_gathering_invite(uuid) from public;
revoke all on function public.join_gathering(text) from public;
revoke all on function public.get_my_gatherings() from public;
grant execute on function public.create_gathering(text) to authenticated;
grant execute on function public.create_gathering_invite(uuid) to authenticated;
grant execute on function public.join_gathering(text) to authenticated;
grant execute on function public.get_my_gatherings() to authenticated;

commit;
