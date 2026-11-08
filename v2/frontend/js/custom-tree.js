import { supabase } from "./supabase.js?v=20260829-34";
import { boxTreeHtml } from "./box-tree.js?v=20260831-60";
import { buildPerformanceModel } from "./performance-calculator.js?v=20261031-4";
import { visibleChildrenMap, activeExclusions } from "./custom-tree-logic.js?v=20261108-1";

const TABLE = "nrc_custom_tree_exclusions";
const number = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

// 저장된 제외 목록. 표가 아직 없거나 읽지 못하면 빈 목록으로 동작한다(기존 화면 그대로).
export async function loadExclusions(me) {
  const { data, error } = await supabase.from(TABLE).select("member_no").eq("owner_id", me.id);
  if (error) return { ids: new Set(), error };
  return { ids: new Set((data || []).map((row) => String(row.member_no))), error: null };
}

export async function customTreePage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>내 계보도</h2><p class="help" id="ctInfo">불러오는 중...</p></div></div><div id="ctError" class="error"></div><div id="ctBody"></div></section>`;
  const $ = (id) => document.getElementById(id);

  const { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("payload,collected_at,source_account_id")
    .eq("owner_id", me.id)
    .eq("snapshot_type", "combined")
    .order("collected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    $("ctInfo").textContent = "";
    $("ctError").textContent = error?.message || "수집된 자료가 없습니다. 홈에서 매출 데이터 받기를 먼저 해 주세요.";
    return;
  }
  const payload = typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
  const model = buildPerformanceModel(payload);
  const loaded = await loadExclusions(me);
  let excluded = activeExclusions(model, loaded.ids);
  if (loaded.error) {
    $("ctError").textContent =
      "제외 목록을 불러오지 못했습니다. RUN_048 SQL을 Supabase에서 실행했는지 확인해 주세요. (" + loaded.error.message + ")";
  }

  let rootId = model.byId.has(String(me.member_no)) ? String(me.member_no) : String(model.rows[0].userId);
  let depth = 5;
  let zoom = 1;
  let query = "";

  $("ctInfo").textContent = `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · NRC ${data.source_account_id || "-"} · 전체 ${number(model.rows.length)}명`;

  const rootOptions = () =>
    [...model.rows]
      .sort((a, b) => Number(a.userId) - Number(b.userId))
      .map((row) => `<option value="${safe(row.userId)}"${String(row.userId) === rootId ? " selected" : ""}>${safe(row.userId)} ${safe(row.userName)}</option>`)
      .join("");
  const listHtml = () => {
    const q = query.trim().toLowerCase();
    return [...model.rows]
      .sort((a, b) => Number(a.userId) - Number(b.userId))
      .filter((row) => !q || `${row.userId} ${row.userName}`.toLowerCase().includes(q))
      .slice(0, 300)
      .map((row) => {
        const id = String(row.userId);
        const isRoot = id === rootId;
        return `<label style="display:flex;flex-direction:row;gap:8px;align-items:center;justify-content:flex-start;text-align:left;padding:3px 6px;margin:0;width:auto;cursor:${isRoot ? "default" : "pointer"}"><input type="checkbox" data-ct-ex="${safe(id)}"${excluded.has(id) ? " checked" : ""}${isRoot ? " disabled" : ""} style="flex:none;width:18px;height:18px;min-height:0;margin:0;padding:0"><span style="flex:none;width:68px;font-size:13px">${safe(id)}</span><b style="flex:none;min-width:56px">${safe(row.userName)}</b><small style="color:#6b7280">${safe(row.rankName || "")}/${safe(row.rankMaxName || "")}</small>${isRoot ? '<small style="color:#6b7280">기준 회원</small>' : ""}</label>`;
      })
      .join("");
  };
  const treeHtml = () => {
    const ctx = { byId: model.byId, children: visibleChildrenMap(model, excluded, rootId) };
    return boxTreeHtml(ctx, rootId, { depth, clickable: false, hideDate: true });
  };
  const summary = () => `제외 ${number(excluded.size)}명 — 제외한 회원의 하위는 윗사람 밑에 그대로 보입니다.`;

  $("ctBody").innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>기준 회원 <select id="ctRoot">${rootOptions()}</select></label><label>단계 <select id="ctDepth">${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}"${n === depth ? " selected" : ""}>${n}단계</option>`).join("")}</select></label><span class="box-zoom"><button type="button" class="secondary compact" data-ct-zoom="out" aria-label="축소">−</button><button type="button" class="secondary compact" data-ct-zoom="reset" id="ctZoomLabel">100%</button><button type="button" class="secondary compact" data-ct-zoom="in" aria-label="확대">＋</button></span></div><details open style="margin-top:8px"><summary><b>제외할 회원 체크</b> <small id="ctSummary">${summary()}</small></summary><input id="ctSearch" type="search" placeholder="이름 또는 회원번호 검색" style="width:100%;margin:6px 0"><div id="ctList" style="max-height:220px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px;padding:4px">${listHtml()}</div></details><p class="help">여기서 제외한 회원은 마감 계산의 박스·추천에서도 빠집니다. 대실적·소실적 계산에는 그대로 포함됩니다. 계보도의 빈 곳을 끌면 화면이 움직입니다.</p><div class="box-tree pannable-tree"><div class="tree-stage" id="ctStage" style="zoom:${zoom}">${treeHtml()}</div></div>`;

  const redraw = () => {
    $("ctStage").innerHTML = treeHtml();
    $("ctSummary").textContent = summary();
  };
  const redrawList = () => {
    $("ctList").innerHTML = listHtml();
  };

  root.onchange = async (event) => {
    const box = event.target.closest("[data-ct-ex]");
    if (box) {
      const id = box.dataset.ctEx;
      const turnOn = box.checked;
      box.disabled = true;
      const result = turnOn
        ? await supabase.from(TABLE).upsert({ owner_id: me.id, member_no: id }, { onConflict: "owner_id,member_no", ignoreDuplicates: true })
        : await supabase.from(TABLE).delete().eq("owner_id", me.id).eq("member_no", id);
      box.disabled = false;
      if (result.error) {
        box.checked = !turnOn;
        $("ctError").textContent = "저장하지 못했습니다: " + result.error.message;
        return;
      }
      $("ctError").textContent = "";
      if (turnOn) excluded.add(id);
      else excluded.delete(id);
      redraw();
      return;
    }
    if (event.target.id === "ctRoot") {
      rootId = event.target.value;
      redraw();
      redrawList();
    } else if (event.target.id === "ctDepth") {
      depth = Number(event.target.value) || 5;
      redraw();
    }
  };
  root.oninput = (event) => {
    if (event.target.id !== "ctSearch") return;
    query = event.target.value;
    redrawList();
  };
  root.onclick = (event) => {
    const btn = event.target.closest("[data-ct-zoom]");
    if (!btn) return;
    const kind = btn.dataset.ctZoom;
    zoom = Math.min(1.6, Math.max(0.3, Number((kind === "out" ? zoom - 0.1 : kind === "in" ? zoom + 0.1 : 1).toFixed(2))));
    $("ctStage").style.zoom = zoom;
    $("ctZoomLabel").textContent = `${Math.round(zoom * 100)}%`;
  };

  // 빈 곳을 끌어 화면 이동
  const canvas = root.querySelector(".pannable-tree");
  let pan = null;
  canvas.onpointerdown = (event) => {
    if (event.button !== 0) return;
    pan = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop, moved: false };
  };
  canvas.onpointermove = (event) => {
    if (!pan) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 6) {
      pan.moved = true;
      canvas.classList.add("dragging");
      canvas.setPointerCapture(event.pointerId);
    }
    if (!pan.moved) return;
    canvas.scrollLeft = pan.left - dx;
    canvas.scrollTop = pan.top - dy;
  };
  const stop = (event) => {
    if (!pan) return;
    canvas.classList.remove("dragging");
    if (pan.moved && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pan = null;
  };
  canvas.onpointerup = stop;
  canvas.onpointercancel = stop;
}
