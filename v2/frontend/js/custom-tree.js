import { supabase } from "./supabase.js?v=20260829-34";
import { boxTreeHtml } from "./box-tree.js?v=20261109-1";
import { buildPerformanceModel } from "./performance-calculator.js?v=20261108-3";
import { buildPersons, litPersonTree } from "./custom-tree-logic.js?v=20261109-1";

const EXCLUDE_TABLE = "nrc_custom_tree_exclusions";
const PICK_TABLE = "nrc_custom_tree_picks";
const number = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

// 이전 방식(제외 목록). 선택한 사람이 없을 때만 쓴다. 표가 없거나 읽지 못하면 빈 목록.
export async function loadExclusions(me) {
  const { data, error } = await supabase.from(EXCLUDE_TABLE).select("member_no").eq("owner_id", me.id);
  if (error) return { ids: new Set(), error };
  return { ids: new Set((data || []).map((row) => String(row.member_no))), error: null };
}

// 클릭해서 불을 켠 사람(본코드 번호). 표가 없거나 읽지 못하면 빈 목록 = 선택 없음.
export async function loadPicks(me) {
  const { data, error } = await supabase.from(PICK_TABLE).select("member_no").eq("owner_id", me.id);
  if (error) return { ids: new Set(), error };
  return { ids: new Set((data || []).map((row) => String(row.member_no))), error: null };
}

let removeDragGuard = null;

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
  const persons = buildPersons(model);
  const loaded = await loadPicks(me);
  const picks = new Set([...loaded.ids].filter((key) => persons.byId.has(key)));
  if (loaded.error) {
    $("ctError").textContent =
      "선택한 사람을 불러오지 못했습니다. RUN_050 SQL을 Supabase에서 실행했는지 확인해 주세요. (" + loaded.error.message + ")";
  }

  const myKey = persons.personOf.get(String(me.member_no));
  let rootKey = myKey || persons.tops[0] || String(model.rows[0].userId);
  let depth = 7;
  let zoom = 1;

  $("ctInfo").textContent = `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · NRC ${data.source_account_id || "-"} · 전체 ${number(persons.byId.size)}명(코드 ${number(model.rows.length)}개)`;

  const rootOptions = () =>
    [...persons.byId.values()]
      .sort((a, b) => Number(a.userId) - Number(b.userId))
      .map((row) => `<option value="${safe(row.userId)}"${String(row.userId) === rootKey ? " selected" : ""}>${safe(row.userId)} ${safe(row.userName)}</option>`)
      .join("");
  const notes = {};
  persons.codes.forEach((list, key) => {
    notes[key] = list.length === 3 ? "본코드+서브1·2 한 몸" : "코드 1개";
  });

  const pickerHtml = () =>
    boxTreeHtml({ byId: persons.byId, children: persons.children }, rootKey, {
      depth,
      notes,
      litIds: picks,
      hideDate: true,
    });
  const composedHtml = () => {
    if (!picks.size) return '<p class="help">아직 켠 사람이 없습니다. 위 계보도에서 사람을 눌러 불을 켜 보세요.</p>';
    const lit = litPersonTree(persons, picks);
    const ctx = { byId: persons.byId, children: lit.children };
    return lit.tops
      .map((top) => `<div class="box-tree pannable-tree" style="margin-top:8px"><div class="tree-stage" style="zoom:${zoom}">${boxTreeHtml(ctx, top, { depth: 12, notes, litIds: lit.keep, hideDate: true, clickable: false })}</div></div>`)
      .join("");
  };
  const summary = () =>
    picks.size
      ? `불 켜진 사람 ${number(picks.size)}명 — 마감 계산에는 이 사람들만 나옵니다.`
      : "켠 사람이 없으면 마감 계산은 전체 계보를 그대로 씁니다.";

  $("ctBody").innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>기준 회원 <select id="ctRoot">${rootOptions()}</select></label><label>단계 <select id="ctDepth">${[3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}"${n === depth ? " selected" : ""}>${n}단계</option>`).join("")}</select></label><span class="box-zoom"><button type="button" class="secondary compact" data-ct-zoom="out" aria-label="축소">−</button><button type="button" class="secondary compact" data-ct-zoom="reset" id="ctZoomLabel">100%</button><button type="button" class="secondary compact" data-ct-zoom="in" aria-label="확대">＋</button></span><button type="button" class="secondary compact" id="ctLitAll">보이는 사람 모두 켜기</button><button type="button" class="secondary compact" id="ctLitNone">모두 끄기</button></div><p class="help" style="margin-top:8px">사람(박스)을 누르면 불이 켜지고, 다시 누르면 꺼집니다. 한 사람의 본코드·서브1·서브2는 한 몸이라 같이 켜지고 같이 꺼집니다. <b id="ctSummary">${summary()}</b></p><div class="box-tree pannable-tree"><div class="tree-stage" id="ctStage" style="zoom:${zoom}">${pickerHtml()}</div></div><h3 style="margin:18px 0 0">내가 구성한 계보도</h3><p class="help">불 켜진 사람만 모았습니다. 켜지 않은 사람은 빠지고, 그 아래 켜진 사람은 윗사람 밑에 붙습니다.</p><div id="ctComposed">${composedHtml()}</div>`;

  const redraw = () => {
    $("ctStage").innerHTML = pickerHtml();
    $("ctStage").style.zoom = zoom;
    $("ctComposed").innerHTML = composedHtml();
    $("ctSummary").textContent = summary();
  };
  const fail = (message) => {
    $("ctError").textContent = message;
  };
  const visibleKeys = () => {
    const seen = new Set();
    const walk = (key, level) => {
      if (seen.has(key) || level > depth) return;
      seen.add(key);
      (persons.children.get(key) || []).forEach((kid) => walk(String(kid.userId), level + 1));
    };
    walk(rootKey, 1);
    return [...seen];
  };

  const toggle = async (key) => {
    const turnOn = !picks.has(key);
    if (turnOn) picks.add(key);
    else picks.delete(key);
    redraw();
    const result = turnOn
      ? await supabase.from(PICK_TABLE).upsert({ owner_id: me.id, member_no: key }, { onConflict: "owner_id,member_no", ignoreDuplicates: true })
      : await supabase.from(PICK_TABLE).delete().eq("owner_id", me.id).eq("member_no", key);
    if (result.error) {
      if (turnOn) picks.delete(key);
      else picks.add(key);
      redraw();
      fail("저장하지 못했습니다: " + result.error.message);
    } else {
      fail("");
    }
  };

  root.onchange = (event) => {
    if (event.target.id === "ctRoot") {
      rootKey = event.target.value;
      redraw();
    } else if (event.target.id === "ctDepth") {
      depth = Number(event.target.value) || 7;
      redraw();
    }
  };
  root.onclick = async (event) => {
    const zoomBtn = event.target.closest("[data-ct-zoom]");
    if (zoomBtn) {
      const kind = zoomBtn.dataset.ctZoom;
      zoom = Math.min(1.6, Math.max(0.3, Number((kind === "out" ? zoom - 0.1 : kind === "in" ? zoom + 0.1 : 1).toFixed(2))));
      root.querySelectorAll(".tree-stage").forEach((stage) => {
        stage.style.zoom = zoom;
      });
      $("ctZoomLabel").textContent = `${Math.round(zoom * 100)}%`;
      return;
    }
    if (event.target.closest("#ctLitAll")) {
      const keys = visibleKeys().filter((key) => !picks.has(key));
      if (!keys.length) return;
      keys.forEach((key) => picks.add(key));
      redraw();
      const result = await supabase
        .from(PICK_TABLE)
        .upsert(keys.map((key) => ({ owner_id: me.id, member_no: key })), { onConflict: "owner_id,member_no", ignoreDuplicates: true });
      if (result.error) {
        keys.forEach((key) => picks.delete(key));
        redraw();
        fail("저장하지 못했습니다: " + result.error.message);
      } else fail("");
      return;
    }
    if (event.target.closest("#ctLitNone")) {
      if (!picks.size) return;
      const before = [...picks];
      picks.clear();
      redraw();
      const result = await supabase.from(PICK_TABLE).delete().eq("owner_id", me.id);
      if (result.error) {
        before.forEach((key) => picks.add(key));
        redraw();
        fail("저장하지 못했습니다: " + result.error.message);
      } else fail("");
      return;
    }
    const node = event.target.closest("#ctStage [data-member]");
    if (node) toggle(node.dataset.member);
  };

  // 빈 곳을 끌어 화면 이동 (끌었을 때는 박스가 눌리지 않게 한다)
  let pan = null;
  root.onpointerdown = (event) => {
    const canvas = event.target.closest(".pannable-tree");
    if (!canvas || event.button !== 0) return;
    pan = { canvas, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop, moved: false };
  };
  root.onpointermove = (event) => {
    if (!pan) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 6) {
      pan.moved = true;
      pan.canvas.classList.add("dragging");
      pan.canvas.setPointerCapture(event.pointerId);
    }
    if (!pan.moved) return;
    pan.canvas.scrollLeft = pan.left - dx;
    pan.canvas.scrollTop = pan.top - dy;
  };
  const stopPan = (event) => {
    if (!pan) return;
    pan.canvas.classList.remove("dragging");
    if (pan.moved && pan.canvas.hasPointerCapture(event.pointerId)) pan.canvas.releasePointerCapture(event.pointerId);
    setTimeout(() => {
      pan = null;
    }, 0);
  };
  root.onpointerup = stopPan;
  root.onpointercancel = stopPan;
  // 화면 영역(root)은 다른 탭과 같이 쓰므로, 열 때마다 이전 핸들러를 걷어낸다.
  if (removeDragGuard) removeDragGuard();
  const dragGuard = (event) => {
    if (!pan?.moved) return;
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener("click", dragGuard, true);
  removeDragGuard = () => root.removeEventListener("click", dragGuard, true);
}
