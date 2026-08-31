import { supabase } from "./supabase.js?v=20260829-34";

export async function loadManualLinks(ownerId) {
  if (!ownerId) return [];
  const { data, error } = await supabase
    .from("genealogy_manual_links")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at");
  if (error) return [];
  return data || [];
}

export function mergeManualLinks(payload, links) {
  if (!links?.length) return payload;
  const rstLst = Array.isArray(payload?.rstLst) ? payload.rstLst : [];
  const byId = new Map(rstLst.map((row) => [String(row.userId), row]));
  const extra = links
    .filter((link) => !byId.has(String(link.member_id)))
    .map((link) => {
      const parent = byId.get(String(link.parent_id));
      return {
        userId: String(link.member_id),
        userName: link.member_name,
        ppId: String(link.parent_id),
        lv: parent ? Number(parent.lv || 0) + 1 : 0,
        manualLink: true,
      };
    });
  if (!extra.length) return payload;
  return { ...payload, rstLst: [...rstLst, ...extra] };
}

export async function addManualLink(ownerId, { memberId, memberName, parentId, note }) {
  return supabase.from("genealogy_manual_links").insert({
    owner_id: ownerId,
    member_id: String(memberId).trim(),
    member_name: String(memberName).trim(),
    parent_id: String(parentId).trim(),
    note: note || null,
  });
}

export async function removeManualLink(id) {
  return supabase.from("genealogy_manual_links").delete().eq("id", id);
}
