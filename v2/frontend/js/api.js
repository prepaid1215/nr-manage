const API_URL = localStorage.getItem('nrc-api-url') || '';
let sessionToken = localStorage.getItem('nrc-session') || sessionStorage.getItem('nrc-session') || '';
export function setSession(token,remember){sessionToken=token;(remember?localStorage:sessionStorage).setItem('nrc-session',token)}
export function clearSession(){sessionToken='';localStorage.removeItem('nrc-session');sessionStorage.removeItem('nrc-session')}
export async function api(action,payload={}){if(!API_URL)throw new Error('설정에서 Apps Script API 주소를 먼저 등록하세요.');const res=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,sessionToken,payload})});const data=await res.json();if(!data.ok)throw new Error(data.message||'요청에 실패했습니다.');return data.data}
export const hasSession=()=>Boolean(sessionToken);
