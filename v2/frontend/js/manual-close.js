import { supabase } from "./supabase.js?v=20260829-34";
import {
  attachPerformanceSubtree,
  buildPerformanceModel,
  planSixtyKSplit,
} from "./performance-calculator.js?v=20261031-4";

// 직접계산: 추천은 하지 않는다. NRC 계보도처럼 박스 그림을 그리고, 박스에 매출(원)을 직접 넣으면
// 그 금액이 위쪽 박스의 서브·대실적·소실적에 어떻게 반영되는지 바로 보여준다.
const NV_PER_THOUSAND = 810; // 1,000원 = 810 NV
const fmt = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const wonOfNv = (nv) => (nv > 0 ? Math.ceil(nv / NV_PER_THOUSAND) * 1000 : 0); // 그 NV를 채우는 데 드는 매출(원), 1,000원 단위 올림

export async function manualClosePage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 계산</h2><p class="help">박스에 넣을 매출(NV)을 적으면 위쪽 박스의 서브·대실적·소실적이 바로 바뀝니다. 바뀐 숫자는 <b>이전 → 이후</b>로 보입니다. (대실적·소실적에는 본인 NV가 작은 쪽에 더해져 있습니다)</p></div></div><div id="mcSource" class="help">불러오는 중...</div><div id="mcError" class="error"></div></section><div id="mcBody"></div>`;
  const $ = (id) => document.getElementById(id);

  // ── 수집 자료 고르기 (계정별 가장 최근 것) ─────────────────────────────
  const { data: metaRows, error: metaError } = await supabase
    .from("nrc_sync_snapshots")
    .select("id,source_account_id,collected_at")
    .eq("owner_id", me.id)
    .eq("snapshot_type", "combined")
    .order("collected_at", { ascending: false })
    .limit(60);
  if (metaError || !metaRows?.length) {
    $("mcSource").textContent = "";
    $("mcError").textContent = metaError?.message || "수집된 자료가 없습니다. 홈에서 매출 데이터 받기를 먼저 해 주세요.";
    return;
  }
  const latestBySource = [];
  const seen = new Set();
  metaRows.forEach((row) => {
    const key = String(row.source_account_id || "");
    if (seen.has(key)) return;
    seen.add(key);
    latestBySource.push(row);
  });
  let snapshotId = latestBySource[0].id;

  let model = null;
  let sales = {}; // 박스 회원번호 → 넣을 매출(NV)
  let targets = { major: 40, minor: 40 }; // 만 단위
  let rootId = "";
  let applyList = []; // 추천으로 계산된 (박스, NV) 목록
  let depth = 5;
  let collectedAt = "";

  const storeKey = () => `manual-close-nv:${me.id}:${snapshotId}`;
  const loadState = () => {
    sales = {};
    rootId = "";
    depth = 5;
    targets = { major: 40, minor: 40 };
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey()) || "null");
      if (saved?.sales) sales = { ...saved.sales };
      rootId = saved?.rootId || "";
      depth = Number(saved?.depth) || 5;
      if (saved?.targets) targets = saved.targets;
    } catch {}
  };
  const saveState = () => {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ sales, rootId, depth, targets }));
    } catch {}
  };

  const loadSnapshot = async () => {
    const { data, error } = await supabase
      .from("nrc_sync_snapshots")
      .select("payload,collected_at,source_account_id")
      .eq("id", snapshotId)
      .maybeSingle();
    if (error || !data) throw new Error(error?.message || "수집 자료를 불러오지 못했습니다.");
    const payload = typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
    model = buildPerformanceModel(payload);
    // 수집 깊이 제한으로 아래쪽이 잘린 계보는, 내가 읽을 수 있는 다른 계정의 수집 자료로 이어붙인다.
    // 같은 회원이 겹치면 최신 자료가 이기도록 오래된 것부터 붙인다.
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
        const { data: other } = await supabase
          .from("nrc_sync_snapshots")
          .select("payload,collected_at")
          .eq("id", meta.id)
          .maybeSingle();
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
    collectedAt = data.collected_at;
    loadState();
    if (!rootId || !model.byId.has(rootId)) {
      rootId = model.byId.has(String(me.member_no)) ? String(me.member_no) : String(model.rows[0].userId);
    }
  };

  // ── 계산 ───────────────────────────────────────────────────────────────
  const kids = (id) => model.children.get(id) || [];
  let subSalesNv = new Map();
  const subtreeSalesNv = (id) => {
    if (subSalesNv.has(id)) return subSalesNv.get(id);
    let sum = Number(sales[id] || 0);
    kids(id).forEach((child) => {
      sum += subtreeSalesNv(String(child.userId));
    });
    subSalesNv.set(id, sum);
    return sum;
  };
  const lineTotal = (row) =>
    Number(row.ordPv || 0) + Number(row.maxPv || 0) + Number(row.minPv || 0) + subtreeSalesNv(String(row.userId));
  const calc = (id) => {
    const row = model.byId.get(id);
    const [first, second] = kids(id);
    const lines = [first ? lineTotal(first) : 0, second ? lineTotal(second) : 0];
    const own = Number(row.ordPv || 0) + Number(sales[id] || 0);
    const ownSide = lines[0] < lines[1] ? 0 : 1; // 본인 매출은 더 작은 쪽(같으면 서브2)에 합산
    const sums = [lines[0] + (ownSide === 0 ? own : 0), lines[1] + (ownSide === 1 ? own : 0)];
    return { lines, minor: Math.min(...sums), major: Math.max(...sums) };
  };
  const compute = (store) => {
    const keep = sales;
    sales = store;
    subSalesNv = new Map();
    const out = new Map();
    model.rows.forEach((row) => out.set(String(row.userId), calc(String(row.userId))));
    sales = keep;
    subSalesNv = new Map();
    return out;
  };

  // ── 화면 ───────────────────────────────────────────────────────────────
  const val = (id, field) => `<b data-mc-v="${safe(id)}:${field}"></b>`;
  const cardHtml = (row) => {
    const id = String(row.userId);
    return `<div class="box-node" data-mc-card="${safe(id)}" style="min-width:150px"><b>${safe(row.userName || "이름 없음")}</b><small>*${safe(id)}</small><small>${safe(row.rankName || "회원")}/${safe(row.rankMaxName || "회원")}</small><em>본인 ${fmt(row.ordPv)} NV</em><div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 6px;margin-top:4px;text-align:center"><span>서브1</span><span>서브2</span>${val(id, "l0")}${val(id, "l1")}<span>대실적</span><span>소실적</span>${val(id, "major")}${val(id, "minor")}</div><div style="margin-top:6px"><input type="number" inputmode="numeric" min="0" step="1" placeholder="매출(NV)" data-mc-sale="${safe(id)}" value="${safe(sales[id] || "")}" style="width:96px;height:26px;padding:2px 6px;font-size:12px"><small data-mc-won="${safe(id)}" style="display:block"></small></div></div>`;
  };
  const treeHtml = () => {
    const node = (row, level, path) => {
      const id = String(row.userId);
      if (path.has(id)) return "";
      const next = new Set(path).add(id);
      const children = level < depth ? kids(id) : [];
      const more = level >= depth && kids(id).length ? `<div class="box-more">아래 더 있음</div>` : "";
      return `<li>${cardHtml(row)}${more}${children.length ? `<ul>${children.map((child) => node(child, level + 1, next)).join("")}</ul>` : ""}</li>`;
    };
    const top = model.byId.get(rootId);
    return top ? `<ul>${node(top, 1, new Set())}</ul>` : "";
  };

  const refreshNumbers = () => {
    const base = compute({});
    const now = compute(sales);
    const cell = (before, after) =>
      before === after
        ? fmt(after)
        : `<span style="color:#9ca3af;text-decoration:line-through;font-weight:400">${fmt(before)}</span> → <span style="color:#b91c1c">${fmt(after)}</span>`;
    document.querySelectorAll("[data-mc-card]").forEach((card) => {
      const id = card.dataset.mcCard;
      const b = base.get(id);
      const n = now.get(id);
      const set = (field, before, after) => {
        card.querySelector(`[data-mc-v="${CSS.escape(`${id}:${field}`)}"]`).innerHTML = cell(before, after);
      };
      set("l0", b.lines[0], n.lines[0]);
      set("l1", b.lines[1], n.lines[1]);
      set("major", b.major, n.major);
      set("minor", b.minor, n.minor);
      const changed = b.major !== n.major || b.minor !== n.minor || b.lines[0] !== n.lines[0] || b.lines[1] !== n.lines[1];
      card.style.borderColor = changed || sales[id] ? "#dc2626" : "";
      card.querySelector("[data-mc-won]").textContent = sales[id] ? `≈ ${fmt(wonOfNv(sales[id]))}원` : "";
    });
    const totalNv = Object.values(sales).reduce((sum, nv) => sum + Number(nv || 0), 0);
    $("mcTotal").textContent = totalNv
      ? `넣은 매출 합계 ${fmt(totalNv)} NV (≈ ${fmt(wonOfNv(totalNv))}원, 실제로는 박스별 1,000원 단위로 올려 넣습니다)`
      : "아직 넣은 매출이 없습니다. 박스의 칸에 NV를 적어 보세요.";
  };

  // ── 추천: 목표까지 부족한 만큼을 어디에 넣을지 보여준다 (버튼을 눌렀을 때만 계산) ──
  const recommend = () => {
    const top = model.byId.get(rootId);
    const topKids = kids(rootId);
    subSalesNv = new Map();
    const lines = [topKids[0] ? lineTotal(topKids[0]) : 0, topKids[1] ? lineTotal(topKids[1]) : 0];
    const own = Number(top.ordPv || 0) + Number(sales[rootId] || 0);
    const side = lines[0] < lines[1] ? 0 : 1; // 본인 NV는 작은 쪽(같으면 서브2)에 합산
    const sums = [lines[0] + (side === 0 ? own : 0), lines[1] + (side === 1 ? own : 0)];
    const minorLine = sums[0] < sums[1] ? 0 : 1;
    const wants = [];
    wants[minorLine] = { label: "소실적", target: Number(targets.minor || 0) * 10000 };
    wants[1 - minorLine] = { label: "대실적", target: Number(targets.major || 0) * 10000 };
    const name = (id) => `${safe(model.byId.get(id)?.userName || "-")} *${safe(id)}`;
    const blocks = [];
    applyList = [];
    [0, 1].forEach((index) => {
      const lineRoot = topKids[index];
      if (!lineRoot) return;
      const deficit = Math.max(0, wants[index].target - sums[index]);
      const title = `서브${index + 1} ${name(String(lineRoot.userId))} · ${wants[index].label} 목표 ${fmt(wants[index].target)} / 현재 ${fmt(sums[index])}`;
      if (deficit <= 0) {
        blocks.push(`<div>${title} → <span style="color:#047857"><b>✅ 채웠음</b></span></div>`);
        return;
      }
      const plan = planSixtyKSplit(model, String(lineRoot.userId), deficit);
      if (!plan) {
        blocks.push(`<div>${title} → 부족 <b>${fmt(deficit)} NV</b> (추천 계산 불가)</div>`);
        return;
      }
      plan.placements.forEach((p) => applyList.push({ id: String(p.memberId), nv: p.addedNv }));
      const placed = plan.placements
        .map((p) => `<div style="margin-left:14px">↳ ${name(String(p.memberId))} · <b>${fmt(p.addedNv)} NV</b> (${fmt(p.salesWon)}원)</div>`)
        .join("");
      const sixty = plan.qualified.length
        ? `<div style="margin-left:14px;color:#047857">소실적 6만 NV를 새로 넘는 박스: ${plan.qualified.map((id) => name(String(id))).join(", ")}</div>`
        : "";
      blocks.push(`<div>${title} → 부족 <b>${fmt(deficit)} NV</b> → 필요 <b>${fmt(plan.totalWon)}원</b></div>${placed}${sixty}`);
    });
    $("mcRec").innerHTML = `<div style="line-height:1.7;font-size:13px">${blocks.join("") || "서브 박스가 없습니다."}</div>${
      applyList.length ? '<button type="button" class="primary compact" id="mcApply" style="margin-top:6px">이 추천 넣기</button>' : ""
    }<div class="help">추천 기준: 부족분을 1,000원 단위(최소 1만원)로 올려 계산하고, 소실적 6만 NV를 새로 넘는 박스가 가장 많아지는 곳을 고릅니다. 마음에 안 들면 박스의 NV를 직접 바꿔도 됩니다.</div>`;
  };

  const draw = () => {
    const sourceOptions = latestBySource
      .map(
        (row) =>
          `<option value="${row.id}"${row.id === snapshotId ? " selected" : ""}>${safe(row.source_account_id || "?")} · ${new Date(row.collected_at).toLocaleString("ko-KR")}</option>`,
      )
      .join("");
    $("mcSource").innerHTML = `수집 자료 <select id="mcSnap">${sourceOptions}</select> · 기준일 ${new Date(collectedAt).toLocaleString("ko-KR")}`;
    const rootOptions = model.rows
      .map(
        (row) =>
          `<option value="${safe(row.userId)}"${String(row.userId) === rootId ? " selected" : ""}>${safe(row.userName)} *${safe(row.userId)}</option>`,
      )
      .join("");
    const depthOptions = [2, 3, 4, 5, 6, 7, 8, 9, 10]
      .map((n) => `<option value="${n}"${n === depth ? " selected" : ""}>${n}단계</option>`)
      .join("");
    $("mcBody").innerHTML = `<section class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>맨 위 박스 <select id="mcRoot">${rootOptions}</select></label><label>단계 <select id="mcDepth">${depthOptions}</select></label><button type="button" class="secondary compact" id="mcReset">입력 초기화</button></div><div id="mcTotal" class="help" style="margin-top:6px"></div><div style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb"><b>${safe(model.byId.get(rootId)?.userName || "")} 마감 목표</b> 대 <input id="mcTargetMajor" type="number" min="0" step="1" style="width:56px" value="${targets.major}"> 만 / 소 <input id="mcTargetMinor" type="number" min="0" step="1" style="width:56px" value="${targets.minor}"> 만 <button type="button" class="secondary compact" id="mcRecBtn">추천 보기</button><div id="mcRec" style="margin-top:6px"></div></div><div class="box-tree" style="touch-action:pan-x pan-y;margin-top:8px"><div class="tree-stage" id="mcStage">${treeHtml()}</div></div></section>`;
    refreshNumbers();
  };

  // ── 이벤트 ─────────────────────────────────────────────────────────────
  // 화면 영역(root)은 다른 탭과 같이 쓰므로, 열 때마다 핸들러가 쌓이지 않게 속성으로 덮어쓴다.
  root.oninput = (event) => {
    if (event.target.id === "mcTargetMajor" || event.target.id === "mcTargetMinor") {
      targets = { major: Number($("mcTargetMajor").value || 0), minor: Number($("mcTargetMinor").value || 0) };
      saveState();
      return;
    }
    const input = event.target.closest("[data-mc-sale]");
    if (!input) return;
    const nv = Math.max(0, Math.floor(Number(input.value || 0)));
    if (nv > 0) sales[input.dataset.mcSale] = nv;
    else delete sales[input.dataset.mcSale];
    saveState();
    refreshNumbers();
  };
  root.onchange = async (event) => {
    if (event.target.id === "mcRoot") {
      rootId = event.target.value;
      saveState();
      $("mcStage").innerHTML = treeHtml();
      refreshNumbers();
    }
    if (event.target.id === "mcDepth") {
      depth = Number(event.target.value) || 5;
      saveState();
      $("mcStage").innerHTML = treeHtml();
      refreshNumbers();
    }
    if (event.target.id === "mcSnap") {
      snapshotId = Number(event.target.value) || event.target.value;
      try {
        await loadSnapshot();
        draw();
      } catch (error) {
        $("mcError").textContent = error.message;
      }
    }
  };
  root.onclick = (event) => {
    if (event.target.closest("#mcRecBtn")) {
      recommend();
      return;
    }
    if (event.target.closest("#mcApply")) {
      (applyList || []).forEach(({ id, nv }) => {
        sales[id] = Number(sales[id] || 0) + nv;
      });
      saveState();
      draw();
      recommend();
      return;
    }
    if (event.target.closest("#mcReset")) {
      sales = {};
      saveState();
      draw();
    }
  };

  try {
    await loadSnapshot();
    draw();
  } catch (error) {
    $("mcSource").textContent = "";
    $("mcError").textContent = error.message;
  }
}
