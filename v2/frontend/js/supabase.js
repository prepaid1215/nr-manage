import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { friendlyError } from "./errors.js?v=20260830-1";
const url = "https://ymagjzwebshfnjiisrao.supabase.co";
const key = "sb_publishable_odxxHbBufV-ZSFlVJ8xFiw_18hBVyJf";
const REMEMBER_KEY = "nrc-remember-login";
export function setRememberLogin(remember) {
  try {
    localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
  } catch {}
}
const rememberedNow = () => {
  try {
    return localStorage.getItem(REMEMBER_KEY) === "1";
  } catch {
    return true;
  }
};
const dynamicStorage = {
  getItem: (storageKey) => {
    try {
      return rememberedNow()
        ? localStorage.getItem(storageKey)
        : sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  },
  setItem: (storageKey, value) => {
    try {
      if (rememberedNow()) sessionStorage.removeItem(storageKey);
      else localStorage.removeItem(storageKey);
      (rememberedNow() ? localStorage : sessionStorage).setItem(
        storageKey,
        value,
      );
    } catch {}
  },
  removeItem: (storageKey) => {
    try {
      localStorage.removeItem(storageKey);
      sessionStorage.removeItem(storageKey);
    } catch {}
  },
};
export const supabase = key
  ? createClient(url, key, { auth: { storage: dynamicStorage } })
  : null;
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
  if (error) throw new Error(friendlyError(error, "회원가입하지 못했습니다. 입력 내용을 확인해 주세요."), { cause: error });
  return data;
}
export async function signIn({ username, password }) {
  if (!supabase) throw Error("Supabase publishable key가 설정되지 않았습니다.");
  const { data, error } = await supabase.auth.signInWithPassword({
    email: accountEmail(username),
    password,
  });
  if (error) throw new Error(friendlyError(error, "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요."), { cause: error });
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
