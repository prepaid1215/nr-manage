import { supabase } from "./supabase.js?v=20260829-34";
import { attachPerformanceSubtree, buildPerformanceModel } from "./performance-calculator.js?v=20261108-3";

// 마감 계산과 같은 방식으로 수집 자료를 고르고, 깊이 제한으로 잘린 아래쪽은 읽을 수 있는 다른 계정의 자료로 이어 붙인다.
export async function listSources(me) {
  const { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("id,source_account_id,collected_at")
    .eq("owner_id", me.id)
    .eq("snapshot_type", "combined")
    .order("collected_at", { ascending: false })
    .limit(60);
  if (error || !data?.length) return { rows: [], error };
  const seen = new Set();
  const rows = [];
  data.forEach((row) => {
    const key = String(row.source_account_id || "");
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  });
  return { rows, error: null };
}

export async function loadMergedModel(snapshotId) {
  const { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("payload,collected_at,source_account_id")
    .eq("id", snapshotId)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || "수집 자료를 불러오지 못했습니다.");
  const payload = typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
  const model = buildPerformanceModel(payload);
  try {
    const { data: allMeta } = await supabase
      .from("nrc_sync_snapshots")
      .select("id,source_account_id,collected_at")
      .eq("snapshot_type", "combined")
      .order("collected_at", { ascending: false })
      .limit(100);
    const latest = [];
    const seenSources = new Set();
    (allMeta || []).forEach((meta) => {
      const key = String(meta.source_account_id || "");
      if (seenSources.has(key)) return;
      seenSources.add(key);
      latest.push(meta);
    });
    const parts = [{ collectedAt: data.collected_at, model }];
    for (const meta of latest) {
      if (meta.id === snapshotId || String(meta.source_account_id || "") === String(data.source_account_id || "")) continue;
      const { data: other } = await supabase.from("nrc_sync_snapshots").select("payload,collected_at").eq("id", meta.id).maybeSingle();
      if (!other) continue;
      const otherPayload = typeof other.payload === "string" ? JSON.parse(other.payload) : other.payload;
      parts.push({ collectedAt: other.collected_at, model: buildPerformanceModel(otherPayload) });
    }
    parts.sort((a, b) => new Date(a.collectedAt) - new Date(b.collectedAt));
    let changed = true;
    let passes = 0;
    while (changed && passes <= parts.length) {
      changed = false;
      passes += 1;
      parts.forEach(({ model: source }) => {
        if (source === model) return;
        [...model.byId.keys()]
          .filter((id) => source.byId.has(id))
          .forEach((id) => {
            if (attachPerformanceSubtree(model, source, id) > 0) changed = true;
          });
      });
    }
  } catch {}
  return { model, collectedAt: data.collected_at, sourceAccountId: data.source_account_id };
}
