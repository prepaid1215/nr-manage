import { supabase } from "./supabase.js?v=20260829-34";
import {
  attachPerformanceSubtree,
  buildPerformanceModel,
} from "./performance-calculator.js?v=20261031-4";

// 직접계산: 추천은 하지 않는다. 수집 자료로 박스(동그라미)를 미리 채워 두고, 박스마다 넣을 매출(원)을
// 사람이 직접 입력하면 그 금액이 위로 올라가며 대실적·소실적이 어떻게 바뀌는지 계산 과정을 그대로 보여준다.
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
const nvOf = (won) => Math.floor(Number(won || 0) / 1000) * NV_PER_THOUSAND;
const ceilWon = (nv) => (nv > 0 ? Math.max(10000, Math.ceil(nv / NV_PER_THOUSAND) * 1000) : 0);
const RANKS = ["회원", "DT", "GD", "RD", "ED", "DD", "SDD", "CDD", "PM", "IM"];
const isGdUp = (row) =>
  RANKS.indexOf(String(row?.rankMaxName || row?.rankName || "회원").toUpperCase()) >= 2;

export async function manualClosePage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 직접 계산</h2><p class="help">수집 자료로 박스를 미리 채워 두었습니다. 박스마다 넣을 매출(원)을 직접 입력하면 바로 계산됩니다. 추천은 하지 않고, 계산 과정을 그대로 보여줍니다.</p></div></div><div id="mcSource" class="help">불러오는 중...</div><div id="mcError" class="error"></div></section><div id="mcBody"></div>`;
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
  let sales = {}; // 박스 회원번호 → 넣을 매출(원)
  let targets = { major: 40, minor: 40 }; // 만 단위
  let selectedId = "";
  let collectedAt = "";
  let sourceId = "";
  let entered = []; // 매출을 넣으려고 추가한 박스 회원번호 (몇 군데만 추가해서 쓴다)
  let marks = new Map(); // 박스 회원번호 → 'income'(수당매출자) | 'seller'(매출자)
  let canKind = false; // 수당매출자/매출자 구분 저장 칸이 DB에 있는지
  let ownBoxes = new Set(); // 사업자 본인 박스(수당 계산 대상)

  const storeKey = () => `manual-close:${me.id}:${snapshotId}`;
  const loadState = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey()) || "null");
      sales = saved?.sales || {};
      entered = [...new Set([...(saved?.entered || []), ...Object.keys(sales)])];
      targets = saved?.targets || { major: 40, minor: 40 };
      selectedId = saved?.selectedId || "";
    } catch {
      sales = {};
      entered = [];
      targets = { major: 40, minor: 40 };
      selectedId = "";
    }
  };
  const saveState = () => {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ sales, entered, targets, selectedId }));
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
    sourceId = data.source_account_id || "";
    loadState();
    if (!selectedId || !model.byId.has(selectedId)) {
      selectedId = model.byId.has(String(me.member_no)) ? String(me.member_no) : String(model.rows[0].userId);
    }
    // 사업자 본인 박스: 내 회원번호에서 시작해 같은 이름으로 이어지는 박스들
    ownBoxes = new Set();
    const startId = String(me.member_no);
    if (model.byId.has(startId)) {
      const queue = [startId];
      while (queue.length) {
        const id = queue.shift();
        if (ownBoxes.has(id)) continue;
        ownBoxes.add(id);
        const name = model.byId.get(id).userName;
        (model.children.get(id) || []).forEach((child) => {
          if (child.userName === name) queue.push(String(child.userId));
        });
      }
    }
  };

  // 수당매출자/매출자 표시 불러오기 (kind 칸이 없으면 모두 매출자로 보고 구분 칸은 숨긴다)
  const loadMarks = async () => {
    marks = new Map();
    canKind = false;
    const withKind = await supabase.from("nrc_seller_marks").select("member_no,kind");
    if (!withKind.error && Array.isArray(withKind.data)) {
      canKind = true;
      withKind.data.forEach((row) => marks.set(String(row.member_no), row.kind === "income" ? "income" : "seller"));
      return;
    }
    const plain = await supabase.from("nrc_seller_marks").select("member_no");
    if (!plain.error && Array.isArray(plain.data)) {
      plain.data.forEach((row) => marks.set(String(row.member_no), "seller"));
    }
  };

  // ── 계산 ───────────────────────────────────────────────────────────────
  const kids = (id) => model.children.get(id) || [];
  let subSalesNv = new Map();
  const subtreeSalesNv = (id) => {
    if (subSalesNv.has(id)) return subSalesNv.get(id);
    let sum = nvOf(sales[id]);
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
    const ownBase = Number(row.ordPv || 0);
    const ownSale = nvOf(sales[id]);
    const own = ownBase + ownSale;
    const ownSide = lines[0] < lines[1] ? 0 : 1; // 본인 매출은 더 작은 쪽(같으면 서브2)에 합산
    const sums = [lines[0] + (ownSide === 0 ? own : 0), lines[1] + (ownSide === 1 ? own : 0)];
    return {
      row,
      first,
      second,
      lines,
      ownBase,
      ownSale,
      ownSide,
      sums,
      minor: Math.min(...sums),
      major: Math.max(...sums),
    };
  };

  // ── 수당 추정 (소실적 × 지급율, 1NV=1원 가정 / 사업자 본인 박스 + 수당매출자만) ──────
  const rateOf = (minorNv, row) => {
    const gd = isGdUp(row);
    if (minorNv >= 800000) return gd ? 0.1 : 0.06;
    if (minorNv >= 400000) return gd ? 0.08 : 0.06;
    if (minorNv >= 60000 && gd) return 0.05;
    return 0;
  };
  const counts = (id) => ownBoxes.has(id) || marks.get(id) === "income";
  const incomeOf = (id) => {
    const c = calc(id);
    return Math.round(c.minor * rateOf(c.minor, model.byId.get(id)));
  };
  const badgeHtml = (id, row, c) => {
    if (marks.get(id) === "seller") return '<span style="color:#6b7280">매출자 · 수당 제외</span>';
    let text = "";
    if (isGdUp(row)) {
      text += c.minor >= 60000
        ? '<span style="color:#047857">6만 ✓</span>'
        : `<span style="color:#b45309">6만 -${fmt(60000 - c.minor)}</span>`;
    }
    if (counts(id)) text += ` <span style="color:#4338ca">수당 약 ${fmt(incomeOf(id))}원</span>`;
    return text;
  };
  const incomeTotal = () => {
    subSalesNv = new Map();
    let sum = 0;
    model.rows.forEach((row) => {
      const id = String(row.userId);
      if (counts(id)) sum += incomeOf(id);
    });
    return sum;
  };

  // ── 화면 ───────────────────────────────────────────────────────────────
  const explain = () => {
    const c = calc(selectedId);
    const name = (r) => (r ? `${safe(r.userName)} *${safe(String(r.userId).slice(-6))}` : "(없음)");
    const targetMajor = Number(targets.major || 0) * 10000;
    const targetMinor = Number(targets.minor || 0) * 10000;
    const lineText = (index, r) =>
      `<tr><td>서브${index + 1} ${name(r)}</td><td style="text-align:right">${fmt(c.lines[index])}</td><td style="text-align:right">${
        c.ownSide === index ? `+ 본인 ${fmt(c.ownBase)}${c.ownSale ? ` + 입력 ${fmt(c.ownSale)}` : ""}` : ""
      }</td><td style="text-align:right"><b>${fmt(c.sums[index])}</b></td></tr>`;
    const minorLine = c.sums[0] < c.sums[1] ? 0 : 1; // 같으면 서브2가 작은 쪽
    const majorLine = 1 - minorLine;
    const deficitMinor = Math.max(0, targetMinor - c.minor);
    const deficitMajor = Math.max(0, targetMajor - c.major);
    const needMinor = ceilWon(deficitMinor);
    const needMajor = ceilWon(deficitMajor);
    return `<section class="card"><h3 style="margin:0 0 6px">${name(c.row)} · ${safe(c.row.rankMaxName || c.row.rankName || "")}</h3><table style="width:100%;font-size:13px;border-collapse:collapse"><thead><tr><th style="text-align:left">라인</th><th style="text-align:right">라인 합계(NV)</th><th style="text-align:right">본인 매출 합산</th><th style="text-align:right">합계</th></tr></thead><tbody>${lineText(0, c.first)}${lineText(1, c.second)}</tbody></table><div style="margin-top:8px;line-height:1.7"><div>소실적 = 서브${minorLine + 1} <b>${fmt(c.minor)}</b> NV · 대실적 = 서브${majorLine + 1} <b>${fmt(c.major)}</b> NV</div><div>목표 대 ${fmt(targetMajor)} / 소 ${fmt(targetMinor)} → 부족 <b>대 ${fmt(deficitMajor)} / 소 ${fmt(deficitMinor)}</b> NV</div><div style="color:#4b5563">필요 금액 = 부족 NV ÷ 0.81 → 1,000원 단위 올림(최소 10,000원): 대 <b>${fmt(needMajor)}원</b> / 소 <b>${fmt(needMinor)}원</b> (합 ${fmt(needMajor + needMinor)}원)</div>${
      deficitMajor + deficitMinor === 0
        ? '<div style="color:#047857"><b>✅ 목표를 채웠습니다</b></div>'
        : '<div class="help">아래 박스에 매출을 입력하면 이 숫자가 바로 줄어듭니다. 금액은 1,000원 단위로만 반영됩니다.</div>'
    }</div></section>`;
  };

  const rowHtml = (row, depth) => {
    const id = String(row.userId);
    const c = calc(id);
    const sixty = badgeHtml(id, row, c);
    const kind = marks.get(id) || "";
    const kindSelect = ownBoxes.has(id)
      ? '<span style="font-size:12px;color:#4338ca">내 박스</span>'
      : canKind
        ? `<select data-mc-kind="${safe(id)}" style="height:26px;font-size:12px"><option value=""${kind === "" ? " selected" : ""}>표시 없음</option><option value="income"${kind === "income" ? " selected" : ""}>수당매출자</option><option value="seller"${kind === "seller" ? " selected" : ""}>매출자</option></select>`
        : "";
    const isSel = id === selectedId;
    return `<div data-mc-row="${safe(id)}" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:2px 6px;margin-left:${depth * 14}px;border-left:3px solid ${isSel ? "#5b4fc9" : "#e5e7eb"};background:${isSel ? "#f5f3ff" : "transparent"}"><button type="button" class="compact" data-mc-pick="${safe(id)}" style="min-width:0;height:24px;padding:0 8px">${isSel ? "●" : "○"}</button><b style="min-width:84px">${safe(row.userName)} <small>*${safe(id.slice(-6))}</small></b><small>${safe(row.rankMaxName || row.rankName || "")}</small><span style="font-size:12px">소 <b data-mc-minor="${safe(id)}">${fmt(c.minor)}</b> / 대 <b data-mc-major="${safe(id)}">${fmt(c.major)}</b></span> <span data-mc-sixty="${safe(id)}" style="font-size:12px">${sixty}</span><span style="margin-left:auto">${kindSelect}</span></div>`;
  };

  // 매출 넣기: 넣을 박스만 찾아서 추가한다 (전체 박스를 다 채우지 않는다)
  const renderSales = () => {
    const rows = entered
      .filter((id) => model.byId.has(id))
      .map((id) => {
        const row = model.byId.get(id);
        return `<div data-mc-srow="${safe(id)}" style="display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid #e5e7eb"><b>${safe(row.userName)} <small>*${safe(id.slice(-6))}</small></b><small>${safe(row.rankMaxName || row.rankName || "")}</small><span style="margin-left:auto"></span><input type="number" inputmode="numeric" min="0" step="1000" placeholder="금액" style="width:110px;height:28px;padding:2px 6px;font-size:13px" data-mc-sale="${safe(id)}" value="${safe(sales[id] || "")}"><span class="help">원</span><button type="button" class="compact" data-mc-remove="${safe(id)}" aria-label="삭제" style="min-width:0">×</button></div>`;
      })
      .join("");
    $("mcSales").innerHTML = rows || '<div class="help">아직 추가한 박스가 없습니다. 위 칸에 이름을 치고 매출을 넣을 박스를 골라 추가하세요.</div>';
  };
  const renderAddList = (query) => {
    const q = query.trim();
    if (!q) {
      $("mcAddList").innerHTML = "";
      return;
    }
    const matches = model.rows
      .filter((row) => !entered.includes(String(row.userId)) && `${row.userName} ${row.userId}`.includes(q))
      .slice(0, 10);
    $("mcAddList").innerHTML = matches.length
      ? matches
          .map(
            (row) =>
              `<button type="button" class="secondary compact" data-mc-add="${safe(row.userId)}" style="margin:2px 4px 2px 0">${safe(row.userName)} *${safe(String(row.userId).slice(-6))} · ${safe(row.rankMaxName || row.rankName || "")}</button>`,
          )
          .join("")
      : '<span class="help">찾는 박스가 없습니다.</span>';
  };

  const walk = (id, depth, out, seenIds) => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const row = model.byId.get(id);
    if (!row) return;
    out.push(rowHtml(row, depth));
    kids(id).forEach((child) => walk(String(child.userId), depth + 1, out, seenIds));
  };

  const renderTree = () => {
    const out = [];
    const seenIds = new Set();
    const roots = model.rows.filter((row) => !row.ppId || !model.byId.has(String(row.ppId)));
    roots.forEach((row) => walk(String(row.userId), 0, out, seenIds));
    $("mcTree").innerHTML = out.join("");
  };

  const refreshNumbers = () => {
    subSalesNv = new Map();
    $("mcExplain").innerHTML = explain();
    document.querySelectorAll("[data-mc-row]").forEach((rowEl) => {
      const id = rowEl.dataset.mcRow;
      const c = calc(id);
      rowEl.querySelector("[data-mc-minor]").textContent = fmt(c.minor);
      rowEl.querySelector("[data-mc-major]").textContent = fmt(c.major);
      const row = model.byId.get(id);
      rowEl.querySelector("[data-mc-sixty]").innerHTML = badgeHtml(id, row, c);
    });
    const total = Object.values(sales).reduce((sum, won) => sum + Math.floor(Number(won || 0) / 1000) * 1000, 0);
    $("mcTotal").textContent = `입력한 매출 합계 ${fmt(total)}원 (${fmt(nvOf(total))} NV)`;
    // 추정 수당: 입력 전과 입력 후를 나란히 (사업자 본인 박스 + 수당매출자만)
    const after = incomeTotal();
    const keep = sales;
    sales = {};
    const before = incomeTotal();
    sales = keep;
    subSalesNv = new Map();
    const incomeCount = model.rows.filter((row) => counts(String(row.userId))).length;
    $("mcIncome").innerHTML = `추정 수당(내 박스 + 수당매출자 ${fmt(incomeCount)}칸): 입력 전 <b>${fmt(before)}원</b> → 입력 후 <b>${fmt(after)}원</b> (<b>${after - before >= 0 ? "+" : ""}${fmt(after - before)}원</b>) <span style="color:#6b7280">· 소실적 × 지급율, 1NV=1원 가정</span>`;
  };

  const draw = () => {
    subSalesNv = new Map();
    const options = model.rows
      .map(
        (row) =>
          `<option value="${safe(row.userId)}"${String(row.userId) === selectedId ? " selected" : ""}>${safe(row.userName)} (${safe(row.userId)})</option>`,
      )
      .join("");
    const sourceOptions = latestBySource
      .map(
        (row) =>
          `<option value="${row.id}"${row.id === snapshotId ? " selected" : ""}>${safe(row.source_account_id || "?")} · ${new Date(row.collected_at).toLocaleString("ko-KR")}</option>`,
      )
      .join("");
    $("mcSource").innerHTML = `수집 자료 <select id="mcSnap">${sourceOptions}</select> · 기준일 ${new Date(collectedAt).toLocaleString("ko-KR")}`;
    $("mcBody").innerHTML = `<section class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>계산할 박스 <select id="mcSelect">${options}</select></label><label>목표 대 <input id="mcTargetMajor" type="number" min="0" step="1" style="width:64px" value="${targets.major}"> 만</label><label>소 <input id="mcTargetMinor" type="number" min="0" step="1" style="width:64px" value="${targets.minor}"> 만</label><button type="button" class="secondary compact" id="mcReset">입력 초기화</button></div><div id="mcTotal" class="help" style="margin-top:6px"></div><div id="mcIncome" style="margin-top:4px;font-size:13px"></div></section><div id="mcExplain"></div><section class="card"><h3 style="margin:0 0 6px">매출 넣기</h3><div class="help">매출을 넣을 박스만 찾아서 추가하세요. 금액(원)은 1,000원 단위로 반영되고 위쪽 박스까지 바로 올라갑니다.</div><label style="display:block;margin-top:6px">박스 추가 <input id="mcAdd" placeholder="이름 또는 회원번호를 치세요" style="width:220px"></label><div id="mcAddList" style="margin:4px 0"></div><div id="mcSales"></div></section><details class="card" style="margin:8px 0"><summary><b>전체 박스 보기 · 수당매출자/매출자 표시</b></summary><div class="help">박스마다 수당매출자·매출자를 표시하는 곳입니다. ○를 누르면 그 박스가 위 계산 과정에 나옵니다. 매출 입력은 위 "매출 넣기"에서 합니다.</div><label style="display:block;margin:6px 0">박스 찾기 <input id="mcFind" placeholder="이름·회원번호" style="width:140px"></label><div id="mcTree"></div></details>`;
    renderSales();
    renderTree();
    refreshNumbers();
  };

  // ── 이벤트 ─────────────────────────────────────────────────────────────
  // 화면 영역(root)은 다른 탭과 같이 쓰므로, 열 때마다 핸들러가 쌓이지 않게 속성으로 덮어쓴다.
  root.oninput = (event) => {
    const input = event.target.closest("[data-mc-sale]");
    if (input) {
      const id = input.dataset.mcSale;
      const won = Math.max(0, Number(input.value || 0));
      if (won > 0) sales[id] = won;
      else delete sales[id];
      saveState();
      refreshNumbers();
      return;
    }
    if (event.target.id === "mcAdd") {
      renderAddList(event.target.value);
      return;
    }
    if (event.target.id === "mcFind") {
      const query = event.target.value.trim();
      document.querySelectorAll("[data-mc-row]").forEach((rowEl) => {
        rowEl.style.display = !query || rowEl.textContent.includes(query) ? "" : "none";
      });
      return;
    }
    if (event.target.id === "mcTargetMajor" || event.target.id === "mcTargetMinor") {
      targets = {
        major: Number($("mcTargetMajor").value || 0),
        minor: Number($("mcTargetMinor").value || 0),
      };
      saveState();
      refreshNumbers();
    }
  };
  root.onchange = async (event) => {
    const kindSelect = event.target.closest("[data-mc-kind]");
    if (kindSelect) {
      const id = kindSelect.dataset.mcKind;
      const kind = kindSelect.value;
      const { error } = kind
        ? await supabase
            .from("nrc_seller_marks")
            .upsert({ owner_id: me.id, member_no: id, kind }, { onConflict: "owner_id,member_no" })
        : await supabase.from("nrc_seller_marks").delete().eq("owner_id", me.id).eq("member_no", id);
      if (error) {
        $("mcError").textContent = error.message;
        kindSelect.value = marks.get(id) || "";
        return;
      }
      $("mcError").textContent = "";
      if (kind) marks.set(id, kind);
      else marks.delete(id);
      refreshNumbers();
      return;
    }
    if (event.target.id === "mcSelect") {
      selectedId = event.target.value;
      saveState();
      renderTree();
      refreshNumbers();
    }
    if (event.target.id === "mcSnap") {
      snapshotId = Number(event.target.value) || event.target.value;
      try {
        await loadSnapshot();
        await loadMarks();
        draw();
      } catch (error) {
        $("mcError").textContent = error.message;
      }
    }
  };
  root.onclick = (event) => {
    const pick = event.target.closest("[data-mc-pick]");
    if (pick) {
      selectedId = pick.dataset.mcPick;
      $("mcSelect").value = selectedId;
      saveState();
      renderTree();
      refreshNumbers();
      return;
    }
    const add = event.target.closest("[data-mc-add]");
    if (add) {
      const id = add.dataset.mcAdd;
      if (!entered.includes(id)) entered.push(id);
      saveState();
      $("mcAdd").value = "";
      renderAddList("");
      renderSales();
      document.querySelector(`[data-mc-srow="${CSS.escape(id)}"] input`)?.focus();
      return;
    }
    const remove = event.target.closest("[data-mc-remove]");
    if (remove) {
      const id = remove.dataset.mcRemove;
      entered = entered.filter((value) => value !== id);
      delete sales[id];
      saveState();
      renderSales();
      refreshNumbers();
      return;
    }
    if (event.target.closest("#mcReset")) {
      sales = {};
      entered = [];
      saveState();
      draw();
    }
  };

  try {
    await loadSnapshot();
    await loadMarks();
    draw();
  } catch (error) {
    $("mcSource").textContent = "";
    $("mcError").textContent = error.message;
  }
}
