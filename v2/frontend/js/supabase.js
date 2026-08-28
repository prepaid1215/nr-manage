import{createClient}from'https://esm.sh/@supabase/supabase-js@2';
const url='https://ymagjzwebshfnjiisrao.supabase.co';
const key='sb_publishable_odxxHbBufV-ZSFlVJ8xFiw_18hBVyJf';
export const supabase=key?createClient(url,key):null;
export const memberEmail=n=>`${String(n).replace(/\D/g,'')}@nrc-members.invalid`;
export async function signUp({memberNo,name,password}){if(!supabase)throw Error('Supabase publishable key가 설정되지 않았습니다.');const{data,error}=await supabase.auth.signUp({email:memberEmail(memberNo),password,options:{data:{member_no:String(memberNo),name:String(name)}}});if(error)throw error;return data}
export async function signIn({memberNo,password}){if(!supabase)throw Error('Supabase publishable key가 설정되지 않았습니다.');const{data,error}=await supabase.auth.signInWithPassword({email:memberEmail(memberNo),password});if(error)throw error;return data}
export async function currentProfile(){if(!supabase)return null;const{data:{user}}=await supabase.auth.getUser();if(!user)return null;const{data,error}=await supabase.from('profiles').select('id,member_no,name,status').eq('id',user.id).single();if(error)throw error;return data}
