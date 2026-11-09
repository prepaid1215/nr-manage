import { memberLineMetrics } from "./line-metrics.js?v=20261108-2";
import { buildPersons } from "./custom-tree-logic.js?v=20261109-1";
import { planSelectiveSplit } from "./selective-split.js?v=20261109-1";
import { listSources, loadMergedModel } from "./closing-model.js?v=20261109-1";

// 실적 탭 > "추천·제외" 안쪽 탭.
// 먼저 전체로 균형 추천을 계산하고, 마음에 안 드는 곳을 누르면 그곳만 빼고 나머지로 다시 계산한다.
// 불을 켠(사업자로 표시한) 코드가 있으면 그곳에만 매출을 넣는다. 설정은 이 브라우저에 저장한다.
const UNIT_NV = 810;
const fmt = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const LABEL = ["본", "서브1", "서브2"];

export async function closingLabPage(root, me) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>추천·제외</h2><p class="help">먼저 전체로 균형 추천을 계산합니다. 매출을 넣고 싶지 않은 곳은 <b>이곳 제외</b>나 박스 누르기로 빼면, 그곳만 빼고 나머지로 다시 균형 계산합니다. 박스를 눌러 <b>불을 켜면</b> 그 코드에만 넣습니다.</p></div></div><div id="clSource" class="help">불러오는 중...</div><div id="clError" class="error"></div></section><div id="clBody"></div>`;
  const $ = (id) => root.querySelector(`#${id}`);

  const { rows: sources, error: listError } = await listSources(me);
  if (listError || !sources.length) {
    $("clSource").textContent = "";
    $("clError").textContent = listError?.message || "수집된 자료가 없습니다. 홈에서 매출 데이터 받기를 먼저 해 주세요.";
    return;
  }

  let snapshotId = sources[0].id;
  let model = null;
  let persons = null;
  let collectedAt = "";
  let rid = "";
  let depth = 5;
  let zoom = 1;
  let sales = {};
  let lit = new Set();
  let excl = new Set();
  let target = { major: 150, minor: 150 };
  let personOnly = false;
  let clickMode = "exclude";
  let preview = new Map(); // 코드 → 추천 원(아직 넣지 않은 값)
  let applyList = null;
  let recText = "";

  const storeKey = () => `closing-lab:${me.id}:${snapshotId}`;
  const load = () => {
    sales = {};
    lit = new Set();
    excl = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey()) || "null");
      if (saved) {
        sales = { ...(saved.sales || {}) };
        lit = new Set((saved.lit || []).map(String));
        excl = new Set((saved.excl || []).map(String));
        if (saved.rid) rid = String(saved.rid);
        depth = Number(saved.depth) || 5;
        target = { major: Number(saved.target?.major ?? 150), minor: Number(saved.target?.minor ?? 150) };
        personOnly = Boolean(saved.personOnly);
        clickMode = saved.clickMode === "lit" ? "lit" : "exclude";
      }
    } catch {}
  };
  const save = () => {
    try {
      localStorage.setItem(
        storeKey(),
        JSON.stringify({ sales, lit: [...lit], excl: [...excl], rid, depth, target, personOnly, clickMode }),
      );
    } catch {}
  };

  const kids = (id) => (model.children.get(id) || []).slice(0, 2).map((row) => String(row.userId));
  const rowOf = (id) => model.byId.get(id);
  const labelOf = (id) => {
    const key = persons.personOf.get(id);
    const list = key ? persons.codes.get(key) : null;
    return list && list.length === 3 ? LABEL[list.indexOf(id)] : "단독";
  };
  const nameOf = (id) => `${safe(rowOf(id)?.userName || "-")} *${safe(id)} ${labelOf(id)}`;
  const takeable = (id) => (lit.size === 0 || lit.has(id)) && !excl.has(id);

  const salesBelow = (id, store) => {
    let sum = Number(store[id] || 0);
    kids(id).forEach((kid) => {
      sum += salesBelow(kid, store);
    });
    return sum;
  };
  const lineTotal = (id, store) => {
    const row = rowOf(id);
    return Number(row.ordPv || 0) + Number(row.maxPv || 0) + Number(row.minPv || 0) + salesBelow(id, store);
  };
  const calc = (id, store) => {
    const row = rowOf(id);
    const k = kids(id);
    const lines = [k[0] ? lineTotal(k[0], store) : 0, k[1] ? lineTotal(k[1], store) : 0];
    const own = Number(row.ordPv || 0) + Number(store[id] || 0);
    const side = lines[0] < lines[1] ? 0 : 1;
    const sums = [lines[0] + (side === 0 ? own : 0), lines[1] + (side === 1 ? own : 0)];
    return { lines, own, sums, major: Math.max(...sums), minor: Math.min(...sums), minorLine: sums[0] < sums[1] ? 0 : 1 };
  };

  const cardHtml = (id, base) => {
    const row = rowOf(id);
    const now = calc(id, sales);
    const before = base[id];
    const changed = before.lines[0] !== now.lines[0] || before.lines[1] !== now.lines[1] || sales[id];
    const cell = (a, b) => (a === b ? fmt(b) : `<span class="cl-old">${fmt(a)}</span> → <span class="cl-new">${fmt(b)}</span>`);
    const real = memberLineMetrics(row).real;
    const pv = preview.get(id);
    return `<div class="box-node cl-card${lit.has(id) ? " lit" : ""}${excl.has(id) ? " ex" : ""}${changed ? " chg" : ""}" data-cl-card="${safe(id)}"><b>${safe(row.userName || "이름 없음")}</b><small>*${safe(id)} · ${labelOf(id)}</small><small>${safe(row.rankName || "회원")}/${safe(row.rankMaxName || "회원")}</small><em>본인 ${fmt(row.ordPv)} NV</em><div class="cl-g2"><span>서브1</span><span>서브2</span><b>${cell(before.lines[0], now.lines[0])}</b><b>${cell(before.lines[1], now.lines[1])}</b></div><div style="margin-top:4px">실회선 <b>${real == null ? "미수집" : `${fmt(real)}회선`}</b></div>${pv ? `<span class="cl-pv">추천 +${fmt(pv)}원</span>` : ""}${excl.has(id) ? '<span class="cl-exl">제외됨 (누르면 되돌림)</span>' : ""}<input type="number" min="0" step="1" placeholder="매출(NV)" data-cl-sale="${safe(id)}" value="${safe(sales[id] || "")}"><small>${sales[id] ? `≈ ${fmt(Math.ceil(sales[id] / UNIT_NV) * 1000)}원` : ""}</small></div>`;
  };
  const treeHtml = () => {
    const base = {};
    model.rows.forEach((row) => {
      base[String(row.userId)] = calc(String(row.userId), {});
    });
    const node = (id, level) => {
      const children = level < depth ? kids(id) : [];
      const more = level >= depth && kids(id).length ? '<div class="box-more">아래 더 있음</div>' : "";
      return `<li>${cardHtml(id, base)}${more}${children.length ? `<ul>${children.map((kid) => node(kid, level + 1)).join("")}</ul>` : ""}</li>`;
    };
    return `<ul>${node(rid, 1)}</ul>`;
  };

  const traceHtml = (plan) =>
    plan.trace
      .map((t) => {
        const pad = `padding-left:${Math.min(t.depth, 8) * 12}px;`;
        if (t.end) return `<div style="${pad}">└ ${nameOf(t.id)} ${fmt(t.units * 1000)}원 넣음</div>`;
        const parts = [0, 1]
          .map((i) => (t.kids[i] && t.split[i] > 0 ? `${nameOf(t.kids[i])} ${fmt(t.split[i] * 1000)}` : null))
          .filter(Boolean)
          .join(" / ");
        const kind = { balance: "균형 — 작은 쪽 먼저", "skip-even": "건너뜀 — 반반", "person-even": "사람 단위로만 — 반반" }[t.kind];
        const color = t.kind === "skip-even" ? "var(--muted)" : "inherit";
        return `<div style="${pad}color:${color}">▸ ${nameOf(t.id)} ${fmt(t.units * 1000)}원 → <b>${parts}</b> <span style="font-size:12px">(${kind})</span></div>`;
      })
      .join("");

  const buildRecommendation = () => {
    preview = new Map();
    applyList = null;
    const k = kids(rid);
    if (!k.length) {
      recText = "서브 박스가 없습니다.";
      return;
    }
    const state = calc(rid, sales);
    const wants = [];
    wants[state.minorLine] = { label: "소실적", target: Number(target.minor || 0) * 10000 };
    wants[1 - state.minorLine] = { label: "대실적", target: Number(target.major || 0) * 10000 };
    let html = "";
    const list = [];
    [0, 1].forEach((i) => {
      if (!k[i]) return;
      const deficit = Math.max(0, wants[i].target - state.sums[i]);
      const title = `서브${i + 1} ${nameOf(k[i])} · ${wants[i].label} 목표 ${fmt(wants[i].target)} / 현재 ${fmt(state.sums[i])}`;
      if (deficit <= 0) {
        html += `<div>${title} → <span style="color:var(--success)"><b>✅ 채웠음</b></span></div>`;
        return;
      }
      const plan = planSelectiveSplit(model, persons, { lineRootId: k[i], deficitNv: deficit, salesNv: sales, takeable, personOnly });
      if (!plan) {
        html += `<div>${title} → 부족 <b>${fmt(deficit)} NV</b> (제외하지 않은 코드가 이 라인 아래에 없습니다)</div>`;
        return;
      }
      plan.placed.forEach((units, code) => {
        list.push({ id: code, nv: units * UNIT_NV });
        preview.set(code, (preview.get(code) || 0) + units * 1000);
      });
      html += `<div>${title} → 부족 <b>${fmt(deficit)} NV</b> → 필요 <b>${fmt(plan.totalWon)}원</b></div>`;
      html += [...plan.placed.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([code, units]) => `<div style="margin-left:14px">↳ ${nameOf(code)} · <b>${fmt(units * UNIT_NV)} NV</b> (${fmt(units * 1000)}원) <button class="secondary compact cl-xbtn" data-cl-ex="${safe(code)}" type="button">이곳 제외</button></div>`)
        .join("");
      html += `<details style="margin-left:14px"><summary style="cursor:pointer;color:var(--muted)">내려간 과정 보기</summary>${traceHtml(plan)}</details>`;
    });
    applyList = list;
    const chips = excl.size
      ? `<div style="margin-top:6px">제외한 코드: ${[...excl].map((code) => `<span class="cl-chip">${nameOf(code)} <a href="#" data-cl-undo="${safe(code)}">되돌리기</a></span>`).join("")}</div>`
      : "";
    recText = `<div>${html}</div>${chips}${list.length ? '<button class="primary compact" id="clApply" style="margin-top:6px" type="button">이 추천 넣기</button>' : ""}<div class="help">추천 기준: 부족분을 1,000원 단위(최소 1만원)로 올려 계산하고, ${personOnly ? "사람 단위로만 균형(서브 코드 밑 두 사람은 반반)" : "각 박스에서 작은 쪽 라인부터 채워 두 라인이 같아지면 양쪽에 나눠"} 내려갑니다. 마음에 안 드는 곳은 <b>이곳 제외</b>(또는 박스 누르기)로 빼면 나머지로 다시 균형 계산합니다. 사업자로 표시(불 켠)한 코드가 있으면 그곳에만 넣습니다.</div>`;
  };

  const draw = () => {
    const row = rowOf(rid);
    $("clRootName").textContent = `${row.userName} *${rid} ${labelOf(rid)}`;
    $("clRootRank").textContent = `${row.rankName || ""}/${row.rankMaxName || ""}`;
    const stage = $("clStage");
    stage.innerHTML = treeHtml();
    stage.style.zoom = zoom;
    $("clZoom").textContent = `${Math.round(zoom * 100)}%`;
    $("clState").textContent = `${excl.size ? `제외 ${excl.size}개 코드 · ` : ""}${lit.size ? `불 켠 코드 ${lit.size}개` : "불 켠 코드 없음"}`;
    const total = Object.values(sales).reduce((sum, nv) => sum + Number(nv || 0), 0);
    $("clTotal").textContent = total
      ? `넣은 매출 합계 ${fmt(total)} NV (약 ${fmt(Math.ceil(total / UNIT_NV) * 1000)}원, 실제로는 박스별 1,000원 단위로 올려 넣습니다)`
      : "박스의 매출(NV) 칸에 숫자를 넣으면 위쪽 서브1·서브2가 바로 바뀝니다.";
    $("clRec").innerHTML = recText;
  };
  const recommend = () => {
    buildRecommendation();
    draw();
    save();
  };
  const refreshRec = () => {
    if (recText) buildRecommendation();
    draw();
    save();
  };

  const shell = () => {
    const sourceOptions = sources
      .map((row) => `<option value="${row.id}"${row.id === snapshotId ? " selected" : ""}>${safe(row.source_account_id || "?")} · ${new Date(row.collected_at).toLocaleString("ko-KR")}</option>`)
      .join("");
    $("clSource").innerHTML = `수집 자료 <select id="clSnap">${sourceOptions}</select> · 기준일 ${new Date(collectedAt).toLocaleString("ko-KR")}`;
    const depthOptions = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}"${n === depth ? " selected" : ""}>${n}단계</option>`).join("");
    const rootOptions = [...model.rows]
      .sort((a, b) => Number(a.userId) - Number(b.userId))
      .map((row) => `<option value="${safe(row.userId)}"${String(row.userId) === rid ? " selected" : ""}>${safe(row.userName)} ${labelOf(String(row.userId))} *${safe(row.userId)}</option>`)
      .join("");
    $("clBody").innerHTML = `<section class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>단계 <select id="clDepth">${depthOptions}</select></label><label style="display:flex;flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="clPerson" style="width:18px;height:18px;min-height:0;margin:0"${personOnly ? " checked" : ""}> 사람 단위로만 균형</label><label>박스를 누르면 <select id="clMode"><option value="exclude"${clickMode === "exclude" ? " selected" : ""}>제외하기(추천에서 빼기)</option><option value="lit"${clickMode === "lit" ? " selected" : ""}>불 켜기(그 코드에만 넣기)</option></select></label><button class="secondary compact" id="clExOff" type="button">제외·불 모두 풀기</button><button class="secondary compact" id="clReset" type="button">입력 초기화</button></div><div style="margin-top:8px"><label>맨 위 박스 <select id="clRoot" style="max-width:280px">${rootOptions}</select></label> <span id="clState" class="help"></span></div><div class="cl-sec"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><b id="clRootName" style="font-size:15px"></b> <small id="clRootRank" class="help"></small><span style="margin-left:auto"></span>마감 목표 대 <input type="number" id="clMaj" min="0" step="any" value="${target.major}" style="width:84px"> 만 / 소 <input type="number" id="clMin" min="0" step="any" value="${target.minor}" style="width:84px"> 만 <button class="secondary compact" id="clRecBtn" type="button">추천 보기</button><span class="box-zoom"><button class="secondary compact" data-cl-zoom="out" type="button" aria-label="축소">−</button><button class="secondary compact" data-cl-zoom="reset" id="clZoom" type="button">100%</button><button class="secondary compact" data-cl-zoom="in" type="button" aria-label="확대">＋</button></span></div><div id="clRec" style="margin-top:6px;line-height:1.75;font-size:13px"></div><div class="box-tree pannable-tree" style="margin-top:8px"><div class="tree-stage" id="clStage"></div></div><div id="clTotal" class="help" style="margin-top:6px"></div></div></section>`;
    draw();
  };

  const loadSnapshot = async () => {
    const merged = await loadMergedModel(snapshotId);
    model = merged.model;
    collectedAt = merged.collectedAt;
    persons = buildPersons(model);
    rid = "";
    load();
    if (!rid || !model.byId.has(rid)) {
      rid = model.byId.has(String(me.member_no)) ? String(me.member_no) : String(model.rows[0].userId);
    }
    lit = new Set([...lit].filter((id) => model.byId.has(id)));
    excl = new Set([...excl].filter((id) => model.byId.has(id)));
    sales = Object.fromEntries(Object.entries(sales).filter(([id]) => model.byId.has(id)));
    recText = "";
    preview = new Map();
    shell();
  };

  // 화면 영역(root)은 이 탭만 쓰므로 속성으로 덮어쓴다.
  root.onchange = async (event) => {
    if (event.target.id === "clSnap") {
      snapshotId = Number(event.target.value) || event.target.value;
      try {
        await loadSnapshot();
      } catch (error) {
        $("clError").textContent = error.message;
      }
      return;
    }
    if (event.target.id === "clDepth") {
      depth = Number(event.target.value) || 5;
      draw();
      save();
    } else if (event.target.id === "clRoot") {
      rid = event.target.value;
      recText = "";
      preview = new Map();
      draw();
      save();
    } else if (event.target.id === "clPerson") {
      personOnly = event.target.checked;
      refreshRec();
    } else if (event.target.id === "clMode") {
      clickMode = event.target.value === "lit" ? "lit" : "exclude";
      save();
    }
  };
  root.oninput = (event) => {
    if (event.target.id === "clMaj" || event.target.id === "clMin") {
      target = { major: Number($("clMaj").value || 0), minor: Number($("clMin").value || 0) };
      save();
      return;
    }
    const input = event.target.closest("[data-cl-sale]");
    if (!input) return;
    const id = input.dataset.clSale;
    const value = Math.max(0, Math.floor(Number(input.value || 0)));
    if (value > 0) sales[id] = value;
    else delete sales[id];
    preview = new Map();
    recText = "";
    draw();
    save();
    const again = root.querySelector(`[data-cl-sale="${CSS.escape(id)}"]`);
    if (again) {
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
  };
  root.onclick = (event) => {
    const zoomBtn = event.target.closest("[data-cl-zoom]");
    if (zoomBtn) {
      const kind = zoomBtn.dataset.clZoom;
      zoom = Math.min(1.6, Math.max(0.3, Number((kind === "out" ? zoom - 0.1 : kind === "in" ? zoom + 0.1 : 1).toFixed(2))));
      draw();
      return;
    }
    if (event.target.closest("#clRecBtn")) return recommend();
    if (event.target.closest("#clReset")) {
      sales = {};
      preview = new Map();
      recText = "";
      draw();
      save();
      return;
    }
    if (event.target.closest("#clExOff")) {
      excl.clear();
      lit.clear();
      return refreshRec();
    }
    if (event.target.closest("#clApply")) {
      (applyList || []).forEach(({ id, nv }) => {
        sales[id] = Number(sales[id] || 0) + nv;
      });
      applyList = null;
      preview = new Map();
      return recommend();
    }
    const exBtn = event.target.closest("[data-cl-ex]");
    if (exBtn) {
      excl.add(exBtn.dataset.clEx);
      return recommend();
    }
    const undo = event.target.closest("[data-cl-undo]");
    if (undo) {
      event.preventDefault();
      excl.delete(undo.dataset.clUndo);
      return recommend();
    }
    if (event.target.closest("input")) return;
    const card = event.target.closest("[data-cl-card]");
    if (!card) return;
    const id = card.dataset.clCard;
    const set = clickMode === "lit" ? lit : excl;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    refreshRec();
  };

  try {
    await loadSnapshot();
  } catch (error) {
    $("clSource").textContent = "";
    $("clError").textContent = error.message;
  }
}
