import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const url = "https://ymagjzwebshfnjiisrao.supabase.co";
const key = "sb_publishable_odxxHbBufV-ZSFlVJ8xFiw_18hBVyJf";
export const supabase = key ? createClient(url, key) : null;
const normalizeUsername = (value) => String(value).trim().toLowerCase();
export const accountEmail = (value) =>
  `app-${normalizeUsername(value)}@nrc-members.com`;
export async function signUp({ username, password, name, memberNo }) {
  if (!supabase) throw Error("Supabase publishable key가 설정되지 않았습니다.");
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9._-]{4,30}$/.test(normalized))
    throw Error("아이디는 영문, 숫자, 점, 밑줄, 하이픈으로 4~30자 입력하세요.");
  const { data, error } = await supabase.auth.signUp({
    email: accountEmail(normalized),
    password,
    options: {
      data: {
        username: normalized,
        name: String(name || "").trim(),
        member_no: String(memberNo || "").trim(),
      },
    },
  });
  if (error) throw error;
  return data;
}
export async function signIn({ username, password }) {
  if (!supabase) throw Error("Supabase publishable key가 설정되지 않았습니다.");
  const { data, error } = await supabase.auth.signInWithPassword({
    email: accountEmail(username),
    password,
  });
  if (error) throw error;
  return data;
}
export async function currentProfile() {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;
  return {
    id: user.id,
    member_no: null,
    name: user.user_metadata?.name || user.user_metadata?.username || "사용자",
    status: "ACTIVE",
  };
}
