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
  let targetsBy = {}; // 맨 위 박스 회원번호 → { major, minor } 마감 목표 (만 단위)
  let rootIds = []; // 계보도로 그릴 맨 위 박스들 (여러 개를 체크하면 아래로 차례로 그린다)
  let applyBy = {}; // 맨 위 박스 회원번호 → 추천으로 계산된 (박스, NV) 목록
  let depth = 5;
  let unit = "nv"; // 박스 칸에 적는 단위: "nv" | "won"
  let zoom = 1; // 계보도 확대·축소 (저장하지 않는다)
  let collectedAt = "";

  const storeKey = () => `manual-close-nv:${me.id}:${snapshotId}`;
  const loadState = () => {
    sales = {};
    rootIds = [];
    depth = 5;
    unit = "nv";
    targetsBy = {};
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey()) || "null");
      if (saved?.sales) sales = { ...saved.sales };
      rootIds = (saved?.rootIds || (saved?.rootId ? [saved.rootId] : [])).map(String);
      depth = Number(saved?.depth) || 5;
      unit = saved?.unit === "won" ? "won" : "nv";
      targetsBy = saved?.targetsBy || {};
    } catch {}
  };
  const saveState = () => {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ sales, rootIds, depth, targetsBy, unit }));
    } catch {}
  };
  const targetOf = (rid) => ({ major: 40, minor: 40, follow: true, ...(targetsBy[rid] || {}) });

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
    rootIds = rootIds.filter((id) => model.byId.has(id));
    if (!rootIds.length) {
      rootIds = [model.byId.has(String(me.member_no)) ? String(me.member_no) : String(model.rows[0].userId)];
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
  // 저장은 항상 NV. 칸에는 고른 단위로 보여준다 (원은 1,000원 단위 올림).
  const shown = (id) => (sales[id] ? (unit === "won" ? wonOfNv(sales[id]) : sales[id]) : "");
  const val = (id, field) => `<b data-mc-v="${safe(id)}:${field}"></b>`;
  const cardHtml = (row) => {
    const id = String(row.userId);
    return `<div class="box-node" data-mc-card="${safe(id)}" style="min-width:150px"><b>${safe(row.userName || "이름 없음")}</b><small>*${safe(id)}</small><small>${safe(row.rankName || "회원")}/${safe(row.rankMaxName || "회원")}</small><em>본인 ${fmt(row.ordPv)} NV</em><div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 6px;margin-top:4px;text-align:center"><span>서브1</span><span>서브2</span>${val(id, "l0")}${val(id, "l1")}<span>대실적</span><span>소실적</span>${val(id, "major")}${val(id, "minor")}</div><div style="margin-top:6px"><input type="number" inputmode="numeric" min="0" step="1" placeholder="${unit === "won" ? "매출(원)" : "매출(NV)"}" data-mc-sale="${safe(id)}" value="${safe(shown(id))}" style="width:96px;height:26px;padding:2px 6px;font-size:12px"><small data-mc-won="${safe(id)}" style="display:block"></small></div></div>`;
  };
  const treeHtml = (rid) => {
    const node = (row, level, path) => {
      const id = String(row.userId);
      if (path.has(id)) return "";
      const next = new Set(path).add(id);
      const children = level < depth ? kids(id) : [];
      const more = level >= depth && kids(id).length ? `<div class="box-more">아래 더 있음</div>` : "";
      return `<li>${cardHtml(row)}${more}${children.length ? `<ul>${children.map((child) => node(child, level + 1, next)).join("")}</ul>` : ""}</li>`;
    };
    const top = model.byId.get(rid);
    return top ? `<ul>${node(top, 1, new Set())}</ul>` : "";
  };
  // 선택한 맨 위 박스마다 목표 입력 + 추천 + 계보도를 한 덩어리로 만들어 아래로 차례로 놓는다.
  const sortedRootIds = () => [...rootIds].sort((a, b) => Number(a) - Number(b));
  const treesHtml = () =>
    sortedRootIds()
      .map((rid) => {
        const top = model.byId.get(rid);
        const t = targetOf(rid);
        return `<section data-mc-section="${safe(rid)}" style="margin-top:14px;padding-top:10px;border-top:2px solid #c3cede"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><b style="font-size:15px">${safe(top.userName)} *${safe(rid)}</b> <small>${safe(top.rankName || "")}/${safe(top.rankMaxName || "")}</small><span style="margin-left:auto"></span>${ancestorRoot(rid) ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:13px"><input type="checkbox" data-mc-follow="${safe(rid)}"${followsAbove(rid) ? " checked" : ""} style="width:18px;height:18px;min-height:0;margin:0;padding:0"> 위에서 따라가기</span>` : ""}마감 목표 대 <input type="number" min="0" step="any" style="width:84px" data-mc-tmaj="${safe(rid)}" value="${followsAbove(rid) ? "" : t.major}" placeholder="${followsAbove(rid) ? "자동" : ""}"${followsAbove(rid) ? " readonly" : ""}> 만 / 소 <input type="number" min="0" step="any" style="width:84px" data-mc-tmin="${safe(rid)}" value="${followsAbove(rid) ? "" : t.minor}" placeholder="${followsAbove(rid) ? "자동" : ""}"${followsAbove(rid) ? " readonly" : ""}> 만 <button type="button" class="secondary compact" data-mc-rec-btn="${safe(rid)}">추천 보기</button> <span class="box-zoom"><button type="button" class="secondary compact" data-mc-zoom="out" aria-label="축소">−</button><button type="button" class="secondary compact" data-mc-zoom="reset" data-mc-zoomlabel>${Math.round(zoom * 100)}%</button><button type="button" class="secondary compact" data-mc-zoom="in" aria-label="확대">＋</button></span> <button type="button" class="secondary compact" data-mc-print="${safe(rid)}">🖨 인쇄</button> <button type="button" class="compact" data-mc-unroot="${safe(rid)}" aria-label="이 계보도 닫기" style="min-width:0">×</button></div><div data-mc-rec="${safe(rid)}" style="margin-top:6px"></div><div class="box-tree pannable-tree" style="margin-top:8px"><div class="tree-stage" style="zoom:${zoom}">${treeHtml(rid)}</div></div></section>`;
      })
      .join("");
  const drawTrees = () => {
    $("mcTrees").innerHTML = treesHtml();
    refreshNumbers();
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
      const saleInput = card.querySelector("[data-mc-sale]");
      if (document.activeElement !== saleInput) saleInput.value = shown(id);
      card.querySelector("[data-mc-won]").textContent = sales[id]
        ? unit === "won"
          ? `≈ ${fmt(sales[id])} NV`
          : `≈ ${fmt(wonOfNv(sales[id]))}원`
        : "";
    });
    const totalNv = Object.values(sales).reduce((sum, nv) => sum + Number(nv || 0), 0);
    $("mcTotal").textContent = totalNv
      ? `넣은 매출 합계 ${fmt(totalNv)} NV (≈ ${fmt(wonOfNv(totalNv))}원, 실제로는 박스별 1,000원 단위로 올려 넣습니다)`
      : "아직 넣은 매출이 없습니다. 박스의 칸에 NV를 적어 보세요.";
    // 지금 어디에 얼마가 들어가 있는지 한눈에 보이게 하고, 하나씩 뺄 수 있게 한다.
    const list = Object.entries(sales).sort((a, b) => Number(a[0]) - Number(b[0]));
    $("mcEntered").innerHTML = list.length
      ? `<b>넣은 곳</b> ` +
        list
          .map(
            ([id, nv]) =>
              `<span style="display:inline-block;margin:2px 6px 2px 0;padding:1px 8px;border:1px solid #e5e7eb;border-radius:12px">${safe(model.byId.get(id)?.userName || "")} *${safe(id)} <b>${fmt(nv)} NV</b> <button type="button" class="compact" data-mc-clear="${safe(id)}" aria-label="빼기" style="min-width:0;height:20px;padding:0 6px">×</button></span>`,
          )
          .join("")
      : "";
  };

  // ── 추천: 목표까지 부족한 만큼을 어디에 넣을지 보여준다 (버튼을 눌렀을 때만 계산) ──
  // 위쪽 박스가 먼저 정해지면, 그 아래 박스의 목표는 위에서 필요한 만큼을 받아 내려온다.
  const ancestorRoot = (rid) => {
    let cursor = model.byId.get(rid);
    let guard = 0;
    while (cursor && cursor.ppId && model.byId.has(String(cursor.ppId)) && guard++ < 30) {
      const parent = String(cursor.ppId);
      if (rootIds.includes(parent)) return parent;
      cursor = model.byId.get(parent);
    }
    return "";
  };
  const followsAbove = (rid) => Boolean(ancestorRoot(rid)) && targetOf(rid).follow !== false;
  const stateOf = (rid) => {
    const top = model.byId.get(rid);
    const topKids = kids(rid);
    subSalesNv = new Map();
    const lines = [topKids[0] ? lineTotal(topKids[0]) : 0, topKids[1] ? lineTotal(topKids[1]) : 0];
    const own = Number(top.ordPv || 0) + Number(sales[rid] || 0);
    const side = lines[0] < lines[1] ? 0 : 1; // 본인 NV는 작은 쪽(같으면 서브2)에 합산
    const sums = [lines[0] + (side === 0 ? own : 0), lines[1] + (side === 1 ? own : 0)];
    return { topKids, sums, minorLine: sums[0] < sums[1] ? 0 : 1 };
  };
  // 이 계보도의 목표(NV). 위에서 따라가면: 위 박스가 이 박스 라인에서 더 필요로 하는 만큼을 지금 실적에 더한
  // 값을 합계 목표로 잡고, 대/소로는 최대한 고르게 나눈다(이미 한쪽이 더 크면 모자란 쪽에 몰아서 채운다).
  const targetNvOf = (rid) => {
    const manual = targetOf(rid);
    if (!followsAbove(rid)) {
      return { majorNv: Number(manual.major || 0) * 10000, minorNv: Number(manual.minor || 0) * 10000, from: "", need: 0 };
    }
    const anc = ancestorRoot(rid);
    const st = stateOf(anc);
    const above = targetNvOf(anc);
    const want = [];
    want[st.minorLine] = above.minorNv;
    want[1 - st.minorLine] = above.majorNv;
    let cursor = rid;
    while (String(model.byId.get(cursor).ppId) !== anc) cursor = String(model.byId.get(cursor).ppId);
    const index = st.topKids.findIndex((kid) => String(kid.userId) === cursor);
    const need = Math.max(0, (want[index] || 0) - (st.sums[index] || 0));
    const now = calc(rid);
    const total = now.major + now.minor + need;
    let minorNv = now.minor;
    let majorNv = now.major;
    if (need > 0) {
      if (now.minor + need <= now.major) {
        minorNv = now.minor + need;
      } else {
        majorNv = Math.ceil(total / 2);
        minorNv = total - majorNv;
      }
    }
    return { majorNv, minorNv, from: anc, need };
  };
  const manText = (nv) => String(Math.round((nv / 10000) * 10000) / 10000);

  const recommend = (rid) => {
    const pair = targetNvOf(rid);
    const { topKids, sums, minorLine } = stateOf(rid);
    const wants = [];
    wants[minorLine] = { label: "소실적", target: pair.minorNv };
    wants[1 - minorLine] = { label: "대실적", target: pair.majorNv };
    if (followsAbove(rid)) {
      const sec = document.querySelector(`[data-mc-section="${CSS.escape(rid)}"]`);
      const majInput = sec?.querySelector("[data-mc-tmaj]");
      const minInput = sec?.querySelector("[data-mc-tmin]");
      if (majInput) majInput.value = manText(pair.majorNv);
      if (minInput) minInput.value = manText(pair.minorNv);
    }
    const name = (id) => `${safe(model.byId.get(id)?.userName || "-")} *${safe(id)}`;
    const blocks = [];
    const list = [];
    if (pair.from) {
      blocks.push(
        `<div style="color:#4338ca">위(${name(pair.from)})에서 내려온 목표 → 이 박스 라인에 <b>${fmt(pair.need)} NV</b> 더 필요 · 목표 대 ${fmt(pair.majorNv)} / 소 ${fmt(pair.minorNv)} NV</div>`,
      );
    }
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
      plan.placements.forEach((p) => list.push({ id: String(p.memberId), nv: p.addedNv }));
      const placed = plan.placements
        .map((p) => `<div style="margin-left:14px">↳ ${name(String(p.memberId))} · <b>${fmt(p.addedNv)} NV</b> (${fmt(p.salesWon)}원)</div>`)
        .join("");
      const sixty = plan.qualified.length
        ? `<div style="margin-left:14px;color:#047857">소실적 6만 NV를 새로 넘는 박스: ${plan.qualified.map((id) => name(String(id))).join(", ")}</div>`
        : "";
      blocks.push(`<div>${title} → 부족 <b>${fmt(deficit)} NV</b> → 필요 <b>${fmt(plan.totalWon)}원</b></div>${placed}${sixty}`);
    });
    applyBy[rid] = list;
    const box = document.querySelector(`[data-mc-rec="${CSS.escape(rid)}"]`);
    if (box) {
      box.innerHTML = `<div style="line-height:1.7;font-size:13px">${blocks.join("") || "서브 박스가 없습니다."}</div>${
        list.length ? `<button type="button" class="primary compact" data-mc-apply="${safe(rid)}" style="margin-top:6px">이 추천 넣기</button>` : ""
      }<div class="help">추천 기준: 부족분을 1,000원 단위(최소 1만원)로 올려 계산하고, 소실적 6만 NV를 새로 넘는 박스가 가장 많아지는 곳을 고릅니다. 마음에 안 들면 박스의 NV를 직접 바꿔도 됩니다.</div>`;
    }
  };

  const setZoom = (value) => {
    zoom = Math.min(1.6, Math.max(0.3, Number(value.toFixed(2))));
    document.querySelectorAll("#mcTrees .tree-stage").forEach((stage) => {
      stage.style.zoom = zoom;
    });
    document.querySelectorAll("[data-mc-zoomlabel]").forEach((label) => {
      label.textContent = `${Math.round(zoom * 100)}%`;
    });
  };

  // 인쇄할 때는 계보도 영역만 남긴다 (다른 화면 요소는 숨김)
  if (!document.getElementById("mcPrintStyle")) {
    const style = document.createElement("style");
    style.id = "mcPrintStyle";
    style.textContent =
      "@media print{body.mc-printing *{visibility:hidden}body.mc-printing #mcTrees,body.mc-printing #mcTrees *{visibility:visible}body.mc-printing #mcTrees{position:absolute;left:0;top:0;width:100%}body.mc-printing #mcTrees section:not(.mc-print-this){display:none!important}body.mc-printing #mcTrees .box-tree{overflow:visible!important;max-height:none!important;border:0}body.mc-printing #mcTrees .tree-stage{zoom:.6!important}body.mc-printing #mcTrees button,body.mc-printing #mcTrees [data-mc-rec]{display:none!important}body.mc-printing #mcTrees input{border:0;background:transparent}}";
    document.head.appendChild(style);
  }

  const draw = () => {
    const sourceOptions = latestBySource
      .map(
        (row) =>
          `<option value="${row.id}"${row.id === snapshotId ? " selected" : ""}>${safe(row.source_account_id || "?")} · ${new Date(row.collected_at).toLocaleString("ko-KR")}</option>`,
      )
      .join("");
    $("mcSource").innerHTML = `수집 자료 <select id="mcSnap">${sourceOptions}</select> · 기준일 ${new Date(collectedAt).toLocaleString("ko-KR")}`;
    const depthOptions = [2, 3, 4, 5, 6, 7, 8, 9, 10]
      .map((n) => `<option value="${n}"${n === depth ? " selected" : ""}>${n}단계</option>`)
      .join("");
    // 맨 위 박스 목록: 회원번호 숫자 순서. 검색창으로 거르고, 여러 개를 체크하면 계보도가 아래로 차례로 나온다.
    const numbered = [...model.rows].sort((a, b) => Number(a.userId) - Number(b.userId));
    const pickList = numbered
      .map(
        (row) =>
          `<label data-mc-pickrow="${safe(row.userId)}" style="display:flex;flex-direction:row;flex-wrap:nowrap;gap:8px;align-items:center;justify-content:flex-start;text-align:left;padding:3px 6px;margin:0;width:auto;cursor:pointer"><input type="checkbox" data-mc-root="${safe(row.userId)}"${rootIds.includes(String(row.userId)) ? " checked" : ""} style="flex:none;width:18px;height:18px;min-height:0;margin:0;padding:0"><span style="flex:none;width:68px;font-size:13px">${safe(row.userId)}</span><b style="flex:none;min-width:56px">${safe(row.userName)}</b><small style="flex:none;color:#6b7280">${safe(row.rankName || "")}/${safe(row.rankMaxName || "")}</small></label>`,
      )
      .join("");
    $("mcBody").innerHTML = `<section class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>단계 <select id="mcDepth">${depthOptions}</select></label><label>입력 단위 <select id="mcUnit"><option value="nv"${unit === "nv" ? " selected" : ""}>NV</option><option value="won"${unit === "won" ? " selected" : ""}>원</option></select></label><button type="button" class="secondary compact" id="mcReset">입력 초기화</button></div><div class="help" style="margin-top:4px">계보도의 빈 곳을 끌면 화면이 움직입니다. 칸·버튼 위에서는 움직이지 않습니다.</div><details open style="margin-top:8px"><summary><b>맨 위 박스 고르기</b> (여러 개 체크하면 아래로 차례로 나옵니다)</summary><input id="mcSearch" type="search" placeholder="이름 또는 회원번호 검색" style="width:100%;margin:6px 0"><div id="mcPickList" style="max-height:220px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px;padding:4px">${pickList}</div></details><div id="mcTotal" class="help" style="margin-top:6px"></div><div id="mcEntered" style="margin-top:4px;font-size:13px;line-height:1.9"></div><details style="margin-top:6px"><summary><b>다른 계정으로 가져가기</b> (주영돈에서 넣은 가상 매출을 한수진 화면에서 이어 쓰기)</summary><div class="help">여기서 "복사"를 누르면 지금 넣은 NV가 글자로 복사됩니다. 다른 계정 화면에서 아래 칸에 붙여넣고 "불러오기"를 누르면 같은 박스에 같은 NV가 들어가서, 위쪽 계산에 그대로 반영됩니다.</div><textarea id="mcShare" rows="2" style="width:100%;font-size:12px" placeholder="여기에 붙여넣기"></textarea><div><button type="button" class="secondary compact" id="mcCopy">복사</button> <button type="button" class="secondary compact" id="mcLoad">불러오기</button> <span id="mcShareMsg" class="help"></span></div></details><div id="mcTrees">${treesHtml()}</div></section>`;
    refreshNumbers();
  };

  // ── 이벤트 ─────────────────────────────────────────────────────────────
  // 화면 영역(root)은 다른 탭과 같이 쓰므로, 열 때마다 핸들러가 쌓이지 않게 속성으로 덮어쓴다.
  root.oninput = (event) => {
    if (event.target.id === "mcSearch") {
      const query = event.target.value.trim().toLowerCase();
      document.querySelectorAll("[data-mc-pickrow]").forEach((rowEl) => {
        rowEl.style.display = !query || rowEl.textContent.toLowerCase().includes(query) ? "" : "none";
      });
      return;
    }
    const tMaj = event.target.closest("[data-mc-tmaj]");
    const tMin = event.target.closest("[data-mc-tmin]");
    if (tMaj || tMin) {
      const rid = (tMaj || tMin).dataset.mcTmaj || (tMaj || tMin).dataset.mcTmin;
      targetsBy[rid] = { ...targetOf(rid), [tMaj ? "major" : "minor"]: Number(event.target.value || 0) };
      saveState();
      return;
    }
    const input = event.target.closest("[data-mc-sale]");
    if (!input) return;
    const typed = Math.max(0, Math.floor(Number(input.value || 0)));
    const nv = unit === "won" ? Math.floor(typed / 1000) * NV_PER_THOUSAND : typed;
    if (nv > 0) sales[input.dataset.mcSale] = nv;
    else delete sales[input.dataset.mcSale];
    saveState();
    refreshNumbers();
  };
  root.onchange = async (event) => {
    const follow = event.target.closest("[data-mc-follow]");
    if (follow) {
      const rid = follow.dataset.mcFollow;
      targetsBy[rid] = { ...targetOf(rid), follow: follow.checked };
      saveState();
      drawTrees();
      return;
    }
    const pick = event.target.closest("[data-mc-root]");
    if (pick) {
      const id = pick.dataset.mcRoot;
      rootIds = pick.checked ? [...new Set([...rootIds, id])] : rootIds.filter((value) => value !== id);
      saveState();
      drawTrees();
      return;
    }
    if (event.target.id === "mcUnit") {
      unit = event.target.value === "won" ? "won" : "nv";
      saveState();
      drawTrees();
      return;
    }
    if (event.target.id === "mcDepth") {
      depth = Number(event.target.value) || 5;
      saveState();
      drawTrees();
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
  let pan = null;
  root.onpointerdown = (event) => {
    const canvas = event.target.closest(".pannable-tree");
    if (!canvas || event.button !== 0 || event.target.closest("input,button,select,textarea,label")) return;
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
    pan = null;
  };
  root.onpointerup = stopPan;
  root.onpointercancel = stopPan;

  root.onclick = async (event) => {
    if (event.target.closest("#mcCopy")) {
      const text = `NVSALES:${JSON.stringify(sales)}`;
      $("mcShare").value = text;
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {}
      $("mcShareMsg").textContent = copied ? "복사했습니다." : "위 칸의 글자를 직접 복사해 주세요.";
      return;
    }
    if (event.target.closest("#mcLoad")) {
      try {
        const raw = $("mcShare").value.trim().replace(/^NVSALES:/, "");
        const loaded = JSON.parse(raw);
        let count = 0;
        Object.entries(loaded).forEach(([id, nv]) => {
          const value = Math.floor(Number(nv || 0));
          if (value > 0) {
            sales[id] = value;
            count += 1;
          }
        });
        saveState();
        draw();
        $("mcShareMsg").textContent = `${count}칸을 불러왔습니다.`;
      } catch {
        $("mcShareMsg").textContent = "읽을 수 없는 글자입니다. 복사한 글자를 그대로 붙여넣어 주세요.";
      }
      return;
    }
    const clearBtn = event.target.closest("[data-mc-clear]");
    if (clearBtn) {
      delete sales[clearBtn.dataset.mcClear];
      saveState();
      refreshNumbers();
      return;
    }
    const zoomBtn = event.target.closest("[data-mc-zoom]");
    if (zoomBtn) {
      const kind = zoomBtn.dataset.mcZoom;
      setZoom(kind === "out" ? zoom - 0.1 : kind === "in" ? zoom + 0.1 : 1);
      return;
    }
    const printBtn = event.target.closest("[data-mc-print]");
    if (printBtn) {
      // 누른 계보도 하나만 인쇄한다
      const section = printBtn.closest("[data-mc-section]");
      section?.classList.add("mc-print-this");
      document.body.classList.add("mc-printing");
      window.print();
      setTimeout(() => {
        document.body.classList.remove("mc-printing");
        section?.classList.remove("mc-print-this");
      }, 500);
      return;
    }
    const recBtn = event.target.closest("[data-mc-rec-btn]");
    if (recBtn) {
      recommend(recBtn.dataset.mcRecBtn);
      return;
    }
    const applyBtn = event.target.closest("[data-mc-apply]");
    if (applyBtn) {
      const rid = applyBtn.dataset.mcApply;
      (applyBy[rid] || []).forEach(({ id, nv }) => {
        sales[id] = Number(sales[id] || 0) + nv;
      });
      saveState();
      refreshNumbers();
      recommend(rid);
      return;
    }
    const unroot = event.target.closest("[data-mc-unroot]");
    if (unroot) {
      rootIds = rootIds.filter((value) => value !== unroot.dataset.mcUnroot);
      const checkbox = document.querySelector(`[data-mc-root="${CSS.escape(unroot.dataset.mcUnroot)}"]`);
      if (checkbox) checkbox.checked = false;
      saveState();
      drawTrees();
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
