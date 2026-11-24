import { memberLineMetrics } from "./line-metrics.js?v=20261108-2";
import { buildPersons } from "./custom-tree-logic.js?v=20261123-1";
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

const dragGuards = new WeakMap();

// options.mode === "sum": 목표를 대/소 따로가 아니라 서브1 + 서브2 합(목표합)으로 입력한다. 예) 80 마감 → 37 / 43
export async function closingLabPage(root, me, options = {}) {
  const sumMode = options.mode === "sum";
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>${sumMode ? "목표합 추천" : "추천·제외"}</h2><p class="help">${sumMode ? "목표를 <b>서브1 + 서브2 합</b>으로 입력합니다. 예를 들어 80 마감이면 두 라인의 합이 80이 되게 작은 쪽부터 채워서 <b>37 / 43</b>처럼 나눕니다. " : "먼저 전체로 균형 추천을 계산합니다. "}매출을 넣고 싶지 않은 곳은 <b>이곳 제외</b>나 박스 누르기로 빼면, 그곳만 빼고 나머지로 다시 균형 계산합니다. 박스를 눌러 <b>불을 켜면</b> 그 코드에만 넣습니다.</p></div></div><div id="clSource" class="help">불러오는 중...</div><div id="clError" class="error"></div></section><div id="clBody"></div>`;
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
  let rids = []; // 계보도로 펼친 맨 위 박스들 (여러 개를 체크하면 아래로 차례로 나온다)
  let depth = 5;
  let zoom = 1;
  let sales = {};
  let lit = new Set();
  let excl = new Set();
  let target = { major: 150, minor: 150, total: 300 };
  let personOnly = false;
  let clickMode = "exclude";
  let targetsBy = {}; // 맨 위 박스 → { major, minor, total } 목표(만 단위)
  let recBy = {}; // 맨 위 박스 → { html, apply } 추천 결과
  let previewBy = {}; // 맨 위 박스 → Map(코드 → 추천 원, 아직 넣지 않은 값)
  let appliedBy = {}; // 맨 위 박스 → '이 추천 넣기'로 넣은 매출(코드별 NV). 제외·되돌리기로 계산 조건이 바뀌면 이 몫만 빼고 다시 계산한다.
  let notice = "";
  const previewOf = (id) => Object.values(previewBy).reduce((sum, map) => sum + (map.get(id) || 0), 0);

  const storeKey = () => `${sumMode ? "closing-lab-sum" : "closing-lab"}:${me.id}:${snapshotId}`;
  const load = () => {
    sales = {};
    lit = new Set();
    excl = new Set();
    targetsBy = {};
    appliedBy = {};
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey()) || "null");
      if (saved) {
        sales = { ...(saved.sales || {}) };
        lit = new Set((saved.lit || []).map(String));
        excl = new Set((saved.excl || []).map(String));
        rids = (saved.rids || (saved.rid ? [saved.rid] : [])).map(String);
        targetsBy = { ...(saved.targetsBy || {}) };
        appliedBy = { ...(saved.appliedBy || {}) };
        depth = Number(saved.depth) || 5;
        target = { major: Number(saved.target?.major ?? 150), minor: Number(saved.target?.minor ?? 150), total: Number(saved.target?.total ?? 300) };
        personOnly = Boolean(saved.personOnly);
        clickMode = saved.clickMode === "lit" ? "lit" : "exclude";
      }
    } catch {}
  };
  const save = () => {
    try {
      localStorage.setItem(
        storeKey(),
        JSON.stringify({ sales, lit: [...lit], excl: [...excl], rids, targetsBy, appliedBy, depth, target, personOnly, clickMode }),
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
  const nameOf = (id) => `${safe(rowOf(id)?.userName || "-")} ${safe(id)} ${labelOf(id)}`;
  // 제외하면 그 코드에 넣어 둔 매출도 뺀다(빠진 몫은 다시 계산해서 다른 곳으로 나뉜다).
  const excludeCode = (id) => {
    excl.add(id);
    const removed = Number(sales[id] || 0);
    if (removed > 0) {
      delete sales[id];
      notice = `${nameOf(id)}를 제외하면서 넣어 둔 매출 ${fmt(removed)} NV(약 ${fmt(Math.ceil(removed / UNIT_NV) * 1000)}원)를 뺐습니다.`;
    }
    return removed;
  };
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
    const pv = previewOf(id);
    return `<div class="box-node cl-card${lit.has(id) ? " lit" : ""}${excl.has(id) ? " ex" : ""}${changed ? " chg" : ""}" data-cl-card="${safe(id)}"><b>${safe(row.userName || "이름 없음")}</b><small>${safe(id)} · ${labelOf(id)}</small><small>${safe(row.rankName || "회원")}/${safe(row.rankMaxName || "회원")}</small><em>본인 ${fmt(row.ordPv)} NV</em><div class="cl-g2"><span>서브1</span><span>서브2</span><b>${cell(before.lines[0], now.lines[0])}</b><b>${cell(before.lines[1], now.lines[1])}</b></div><div style="margin-top:4px">실회선 <b>${real == null ? "미수집" : `${fmt(real)}회선`}</b></div>${pv ? `<span class="cl-pv">추천 +${fmt(pv)}원</span>` : ""}${excl.has(id) ? '<span class="cl-exl">제외됨 (누르면 되돌림)</span>' : ""}<input type="number" min="0" step="1" placeholder="매출(NV)" data-cl-sale="${safe(id)}" value="${safe(sales[id] || "")}"><small>${sales[id] ? `≈ ${fmt(Math.ceil(sales[id] / UNIT_NV) * 1000)}원` : ""}</small></div>`;
  };
  const treeHtml = (rid) => {
    const base = {};
    model.rows.forEach((row) => {
      base[String(row.userId)] = calc(String(row.userId), {});
    });
    const edgeHtml = (id) => {
      const before = lineTotal(id, {});
      const now = lineTotal(id, sales);
      const value = before === now ? fmt(now) : `<span class="cl-old">${fmt(before)}</span> → <span class="cl-new">${fmt(now)}</span>`;
      return `<span class="cl-edge" title="이 박스 아래 전체 실적 합계">하위 총 ${value}</span>`;
    };
    const node = (id, level) => {
      const children = level < depth ? kids(id) : [];
      const more = level >= depth && kids(id).length ? '<div class="box-more">아래 더 있음</div>' : "";
      return `<li>${level > 1 ? edgeHtml(id) : ""}${cardHtml(id, base)}${more}${children.length ? `<ul>${children.map((kid) => node(kid, level + 1)).join("")}</ul>` : ""}</li>`;
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

  const man = (nv) => String(Math.round((nv / 10000) * 10) / 10);
  // 목표합(서브1 + 서브2) 추천: 부족분 = 목표합 − (현재 서브1 + 현재 서브2)를 이 박스에서부터 균형으로 나눈다.
  const buildSumRecommendation = (state, rid, ctx) => {
    const totalTarget = Number(targetOf(rid).total || 0) * 10000;
    const current = state.sums[0] + state.sums[1];
    const head = `${nameOf(rid)} · 목표합(서브1 + 서브2) ${fmt(totalTarget)} / 현재 ${fmt(current)} (서브1 ${fmt(state.sums[0])} / 서브2 ${fmt(state.sums[1])})`;
    const deficit = totalTarget - current;
    if (deficit <= 0) {
      ctx.text = `<div>${head} → <span style="color:var(--success)"><b>✅ 채웠음</b></span></div>`;
      return;
    }
    const plan = planSelectiveSplit(model, persons, { lineRootId: rid, deficitNv: deficit, salesNv: sales, takeable, personOnly });
    if (!plan) {
      ctx.text = `<div>${head} → 부족 <b>${fmt(deficit)} NV</b> (제외하지 않은 코드가 이 박스 아래에 없습니다)</div>`;
      return;
    }
    const after = { ...sales };
    const list = [];
    plan.placed.forEach((units, code) => {
      after[code] = Number(after[code] || 0) + units * UNIT_NV;
      list.push({ id: code, nv: units * UNIT_NV });
      ctx.preview.set(code, (ctx.preview.get(code) || 0) + units * 1000);
    });
    const next = calc(rid, after);
    ctx.apply = list;
    const chips = excl.size
      ? `<div style="margin-top:6px">제외한 코드: ${[...excl].map((code) => `<span class="cl-chip">${nameOf(code)} <a href="#" data-cl-undo="${safe(code)}">되돌리기</a></span>`).join("")}</div>`
      : "";
    const items = [...plan.placed.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([code, units]) => `<div style="margin-left:14px">↳ ${nameOf(code)} · <b>${fmt(units * UNIT_NV)} NV</b> (${fmt(units * 1000)}원) <button class="secondary compact cl-xbtn" data-cl-ex="${safe(code)}" type="button">이곳 제외</button></div>`)
      .join("");
    ctx.text = `<div>${head} → 부족 <b>${fmt(deficit)} NV</b> → 필요 <b>${fmt(plan.totalWon)}원</b></div>${items}<details style="margin-left:14px"><summary style="cursor:pointer;color:var(--muted)">내려간 과정 보기</summary>${traceHtml(plan)}</details><div style="margin-top:6px">넣은 뒤 예상: 서브1 <b>${fmt(next.sums[0])}</b> / 서브2 <b>${fmt(next.sums[1])}</b> → 합 <b>${fmt(next.sums[0] + next.sums[1])}</b> (<b>${man(next.sums[0])} / ${man(next.sums[1])}</b>만) · 대 ${man(next.major)} / 소 ${man(next.minor)}</div>${chips}<button class="primary compact" data-cl-apply="${safe(rid)}" style="margin-top:6px" type="button">이 추천 넣기</button><div class="help">추천 기준: 목표합에서 현재 서브1 + 서브2를 뺀 부족분을 1,000원 단위(최소 1만원)로 올려, ${personOnly ? "사람 단위로만 균형(서브 코드 밑 두 사람은 반반)" : "각 박스에서 작은 쪽 라인부터 채워 두 라인이 같아지면 양쪽에 나눠"} 내려갑니다. 한 라인이 이미 절반보다 크면 그 라인은 그대로 두고 작은 라인만 올라갑니다.</div>`;
  };
  const buildRecommendationInto = (rid, ctx) => {
    const k = kids(rid);
    if (!k.length) {
      ctx.text = "서브 박스가 없습니다.";
      return;
    }
    const state = calc(rid, sales);
    if (sumMode) {
      buildSumRecommendation(state, rid, ctx);
      return;
    }
    const wants = [];
    wants[state.minorLine] = { label: "소실적", target: Number(targetOf(rid).minor || 0) * 10000 };
    wants[1 - state.minorLine] = { label: "대실적", target: Number(targetOf(rid).major || 0) * 10000 };
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
        ctx.preview.set(code, (ctx.preview.get(code) || 0) + units * 1000);
      });
      html += `<div>${title} → 부족 <b>${fmt(deficit)} NV</b> → 필요 <b>${fmt(plan.totalWon)}원</b></div>`;
      html += [...plan.placed.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([code, units]) => `<div style="margin-left:14px">↳ ${nameOf(code)} · <b>${fmt(units * UNIT_NV)} NV</b> (${fmt(units * 1000)}원) <button class="secondary compact cl-xbtn" data-cl-ex="${safe(code)}" type="button">이곳 제외</button></div>`)
        .join("");
      html += `<details style="margin-left:14px"><summary style="cursor:pointer;color:var(--muted)">내려간 과정 보기</summary>${traceHtml(plan)}</details>`;
    });
    ctx.apply = list;
    const chips = excl.size
      ? `<div style="margin-top:6px">제외한 코드: ${[...excl].map((code) => `<span class="cl-chip">${nameOf(code)} <a href="#" data-cl-undo="${safe(code)}">되돌리기</a></span>`).join("")}</div>`
      : "";
    ctx.text = `<div>${html}</div>${chips}${list.length ? `<button class="primary compact" data-cl-apply="${safe(rid)}" style="margin-top:6px" type="button">이 추천 넣기</button>` : ""}<div class="help">추천 기준: 부족분을 1,000원 단위(최소 1만원)로 올려 계산하고, ${personOnly ? "사람 단위로만 균형(서브 코드 밑 두 사람은 반반)" : "각 박스에서 작은 쪽 라인부터 채워 두 라인이 같아지면 양쪽에 나눠"} 내려갑니다. 마음에 안 드는 곳은 <b>이곳 제외</b>(또는 박스 누르기)로 빼면 나머지로 다시 균형 계산합니다. 사업자로 표시(불 켠)한 코드가 있으면 그곳에만 넣습니다.</div>`;
  };

  const buildRecommendation = (rid) => {
    const ctx = { text: "", apply: null, preview: new Map() };
    buildRecommendationInto(rid, ctx);
    recBy[rid] = { html: ctx.text, apply: ctx.apply };
    previewBy[rid] = ctx.preview;
  };

  const targetOf = (id) => targetsBy[id] || target;
  const rootsSorted = () => [...rids].sort((x, y) => Number(x) - Number(y));
  const sectionHtml = (id) => {
    const row = rowOf(id);
    const t = targetOf(id);
    const inputs = sumMode
      ? `목표합(서브1 + 서브2) <input type="number" data-cl-ttot="${safe(id)}" min="0" step="any" value="${t.total}" style="width:90px"> 만`
      : `마감 목표 대 <input type="number" data-cl-tmaj="${safe(id)}" min="0" step="any" value="${t.major}" style="width:84px"> 만 / 소 <input type="number" data-cl-tmin="${safe(id)}" min="0" step="any" value="${t.minor}" style="width:84px"> 만`;
    return `<section class="cl-sec" data-cl-sec="${safe(id)}"><div class="cl-print-head">${safe(row.userName)} ${safe(id)} ${labelOf(id)} — 수집 ${safe(new Date(collectedAt).toLocaleString("ko-KR"))}</div><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><b style="font-size:15px">${safe(row.userName)} ${safe(id)}</b> <small class="help">${safe(row.rankName || "")}/${safe(row.rankMaxName || "")} · ${labelOf(id)}</small><span style="margin-left:auto"></span>${inputs} <button class="secondary compact" data-cl-rec-btn="${safe(id)}" type="button">추천 보기</button><span class="box-zoom"><button class="secondary compact" data-cl-zoom="out" type="button" aria-label="축소">−</button><button class="secondary compact" data-cl-zoom="reset" data-cl-zoomlabel type="button">100%</button><button class="secondary compact" data-cl-zoom="in" type="button" aria-label="확대">＋</button></span><button class="secondary compact" data-cl-full type="button">전체화면</button><button class="secondary compact" data-cl-reset type="button">입력 초기화</button><button class="secondary compact" data-cl-print type="button">인쇄</button><button class="secondary compact" data-cl-close="${safe(id)}" type="button" aria-label="닫기">×</button></div><div class="cl-body"><div class="cl-main"><div class="box-tree pannable-tree" style="margin-top:8px"><div class="tree-stage" data-cl-stage="${safe(id)}"></div></div></div><aside class="cl-recbox" data-cl-rec="${safe(id)}"></aside></div></section>`;
  };
  const drawSections = () => {
    $("clTrees").innerHTML = rids.length ? rootsSorted().map(sectionHtml).join("") : '<p class="help">위 목록에서 맨 위 박스를 체크하면 아래에 그 박스 기준 계보도가 나옵니다.</p>';
    draw();
  };
  const draw = () => {
    root.querySelectorAll("[data-cl-stage]").forEach((stage) => {
      stage.innerHTML = treeHtml(stage.dataset.clStage);
      stage.style.zoom = zoom;
    });
    root.querySelectorAll("[data-cl-zoomlabel]").forEach((el) => {
      el.textContent = `${Math.round(zoom * 100)}%`;
    });
    root.querySelectorAll("[data-cl-rec]").forEach((el) => {
      el.innerHTML = recBy[el.dataset.clRec]?.html || "";
    });
    // 넓은 화면에서는 추천 결과를 화면 오른쪽에 고정해 어디까지 내려가도 보이게 한다(계보도 안의 사본은 숨김).
    const floatItems = rootsSorted().filter((id) => recBy[id]?.html);
    $("clFloatBody").innerHTML = floatItems
      .map((id) => `<div class="cl-float-item" data-cl-sec="${safe(id)}"><div class="cl-float-title">${nameOf(id)}</div>${recBy[id].html}</div>`)
      .join("");
    $("clFloat").classList.toggle("on", floatItems.length > 0);
    $("clNotice").innerHTML = notice ? `<div class="cl-notice">${notice}</div>` : "";
    $("clState").textContent = `${excl.size ? `제외 ${excl.size}개 코드 · ` : ""}${lit.size ? `불 켠 코드 ${lit.size}개` : "불 켠 코드 없음"}`;
    const total = Object.values(sales).reduce((sum, nv) => sum + Number(nv || 0), 0);
    $("clTotal").textContent = total
      ? `넣은 매출 합계 ${fmt(total)} NV (약 ${fmt(Math.ceil(total / UNIT_NV) * 1000)}원, 실제로는 박스별 1,000원 단위로 올려 넣습니다)`
      : "박스의 매출(NV) 칸에 숫자를 넣으면 위쪽 서브1·서브2가 바로 바뀝니다.";
  };
  const recommend = (id) => {
    buildRecommendation(id);
    draw();
    save();
  };
  // 이미 추천을 본 맨 위 박스들(과 extra)을 지금 상태로 다시 계산한다.
  const rebuildRecs = (extra) => {
    const ids = new Set(Object.keys(recBy).filter((id) => rids.includes(id)));
    [].concat(extra || []).forEach((id) => {
      if (rids.includes(id)) ids.add(id);
    });
    ids.forEach((id) => buildRecommendation(id));
    draw();
    save();
  };
  const covers = (rootId, code) => {
    const seen = new Set();
    const walk = (c) => {
      if (c === code) return true;
      if (seen.has(c)) return false;
      seen.add(c);
      return kids(c).some(walk);
    };
    return walk(rootId);
  };
  // 제외·되돌리기·불 켜기처럼 계산 조건이 바뀌면, 그동안 "이 추천 넣기"로 넣은 매출만 빼고(직접 입력한 매출은 그대로)
  // 처음부터 다시 계산해서 보여 준다. code가 있으면 그 코드가 들어 있는 맨 위 박스만, 없으면 전부 해당한다.
  const replan = (code, extra) => {
    let removed = 0;
    const touched = [];
    rids.forEach((id) => {
      if (!appliedBy[id] || (code && !covers(id, code))) return;
      appliedBy[id].forEach(({ id: c, nv }) => {
        const before = Number(sales[c] || 0);
        const after = Math.max(0, before - nv);
        removed += before - after;
        if (after > 0) sales[c] = after;
        else delete sales[c];
      });
      delete appliedBy[id];
      touched.push(id);
    });
    if (removed > 0) {
      const msg = `추천으로 넣었던 매출 ${fmt(removed)} NV(약 ${fmt(Math.ceil(removed / UNIT_NV) * 1000)}원)를 빼고 다시 계산했습니다. 마음에 들면 "이 추천 넣기"를 다시 누르세요.`;
      notice = [notice, msg].filter(Boolean).join("<br>");
    }
    rebuildRecs([...touched, ...[].concat(extra || [])]);
  };
  const clearRecs = () => {
    recBy = {};
    previewBy = {};
  };

  const shell = () => {
    const sourceOptions = sources
      .map((row) => `<option value="${row.id}"${row.id === snapshotId ? " selected" : ""}>${safe(row.source_account_id || "?")} · ${new Date(row.collected_at).toLocaleString("ko-KR")}</option>`)
      .join("");
    $("clSource").innerHTML = `수집 자료 <select id="clSnap">${sourceOptions}</select> · 기준일 ${new Date(collectedAt).toLocaleString("ko-KR")}`;
    const depthOptions = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}"${n === depth ? " selected" : ""}>${n}단계</option>`).join("");
    // 맨 위 박스 목록: 회원번호 숫자 순서. 검색창으로 거르고, 여러 개를 체크하면 계보도가 아래로 차례로 나온다.
    const pickList = [...model.rows]
      .sort((x, y) => Number(x.userId) - Number(y.userId))
      .map(
        (row) =>
          `<label data-cl-pickrow="${safe(row.userId)}" class="cl-pickrow"><input type="checkbox" data-cl-root="${safe(row.userId)}"${rids.includes(String(row.userId)) ? " checked" : ""}><span class="cl-pn">${safe(row.userId)}</span><b>${safe(row.userName)}</b><small>${safe(row.rankName || "")}/${safe(row.rankMaxName || "")}</small><small class="cl-pt">${labelOf(String(row.userId))}</small></label>`,
      )
      .join("");
    $("clBody").innerHTML = `<section class="card"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label>단계 <select id="clDepth">${depthOptions}</select></label><label style="display:flex;flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="clPerson" style="width:18px;height:18px;min-height:0;margin:0"${personOnly ? " checked" : ""}> 사람 단위로만 균형</label><label>박스를 누르면 <select id="clMode"><option value="exclude"${clickMode === "exclude" ? " selected" : ""}>제외하기(추천에서 빼기)</option><option value="lit"${clickMode === "lit" ? " selected" : ""}>불 켜기(그 코드에만 넣기)</option></select></label><button class="secondary compact" id="clExOff" type="button">제외·불 모두 풀기</button><button class="secondary compact" id="clReset" type="button">입력 초기화</button></div><div class="help" style="margin-top:4px">계보도의 빈 곳을 끌면 화면이 움직입니다. 칸·버튼 위에서는 움직이지 않습니다.</div><details open class="cl-hide-print" style="margin-top:8px"><summary><b>맨 위 박스 고르기</b> (여러 개 체크하면 아래로 차례로 나옵니다)</summary><input id="clSearch" type="search" placeholder="이름 또는 회원번호 검색" style="width:100%;margin:6px 0"><div class="cl-picklist">${pickList}</div></details><div style="margin-top:6px"><span id="clState" class="help"></span></div><div id="clNotice"></div><div id="clTotal" class="help" style="margin-top:4px"></div><div id="clTrees"></div><div id="clFloat" class="cl-float"><div class="cl-float-head"><b>추천 결과</b><button type="button" class="secondary compact" data-cl-float-toggle>접기</button></div><div class="cl-float-body" id="clFloatBody"></div></div></section>`;
    drawSections();
  };

  const loadSnapshot = async () => {
    const merged = await loadMergedModel(snapshotId);
    model = merged.model;
    collectedAt = merged.collectedAt;
    persons = buildPersons(model);
    rids = [];
    load();
    rids = rids.filter((id) => model.byId.has(id));
    if (!rids.length) rids = [model.byId.has(String(me.member_no)) ? String(me.member_no) : String(model.rows[0].userId)];
    lit = new Set([...lit].filter((id) => model.byId.has(id)));
    excl = new Set([...excl].filter((id) => model.byId.has(id)));
    sales = Object.fromEntries(Object.entries(sales).filter(([id]) => model.byId.has(id)));
    clearRecs();
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
    const pick = event.target.closest("[data-cl-root]");
    if (pick) {
      const id = pick.dataset.clRoot;
      if (pick.checked) {
        if (!rids.includes(id)) rids.push(id);
      } else {
        rids = rids.filter((x) => x !== id);
        delete recBy[id];
        delete previewBy[id];
      }
      drawSections();
      save();
      return;
    }
    if (event.target.id === "clDepth") {
      depth = Number(event.target.value) || 5;
      draw();
      save();
    } else if (event.target.id === "clPerson") {
      personOnly = event.target.checked;
      replan(null);
    } else if (event.target.id === "clMode") {
      clickMode = event.target.value === "lit" ? "lit" : "exclude";
      save();
    }
  };
  root.oninput = (event) => {
    if (event.target.id === "clSearch") {
      const query = event.target.value.trim().toLowerCase();
      root.querySelectorAll("[data-cl-pickrow]").forEach((el) => {
        el.style.display = !query || el.textContent.toLowerCase().includes(query) ? "" : "none";
      });
      return;
    }
    const field = event.target.closest("[data-cl-tmaj],[data-cl-tmin],[data-cl-ttot]");
    if (field) {
      const id = field.dataset.clTmaj || field.dataset.clTmin || field.dataset.clTtot;
      const key = field.dataset.clTmaj ? "major" : field.dataset.clTmin ? "minor" : "total";
      targetsBy[id] = { ...targetOf(id), [key]: Number(field.value || 0) };
      save();
      return;
    }
    const input = event.target.closest("[data-cl-sale]");
    if (!input) return;
    notice = "";
    const id = input.dataset.clSale;
    const value = Math.max(0, Math.floor(Number(input.value || 0)));
    if (value > 0) sales[id] = value;
    else delete sales[id];
    clearRecs();
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
    const fullBtn = event.target.closest("[data-cl-full]");
    if (fullBtn) {
      const section = fullBtn.closest("[data-cl-sec]");
      if (document.fullscreenElement) document.exitFullscreen?.();
      else section?.requestFullscreen?.().catch(() => {});
      return;
    }
    const floatBtn = event.target.closest("[data-cl-float-toggle]");
    if (floatBtn) {
      const box = $("clFloat");
      box.classList.toggle("min");
      floatBtn.textContent = box.classList.contains("min") ? "펼치기" : "접기";
      return;
    }
    const closeBtn = event.target.closest("[data-cl-close]");
    if (closeBtn) {
      const id = closeBtn.dataset.clClose;
      rids = rids.filter((x) => x !== id);
      delete recBy[id];
      delete previewBy[id];
      const box = root.querySelector(`[data-cl-root="${CSS.escape(id)}"]`);
      if (box) box.checked = false;
      drawSections();
      save();
      return;
    }
    const printBtn = event.target.closest("[data-cl-print]");
    if (printBtn) {
      // 누른 계보도 하나만 인쇄한다
      const section = printBtn.closest("[data-cl-sec]");
      section?.classList.add("cl-print-this");
      document.body.classList.add("cl-printing");
      window.print();
      setTimeout(() => {
        document.body.classList.remove("cl-printing");
        section?.classList.remove("cl-print-this");
      }, 500);
      return;
    }
    const recBtn = event.target.closest("[data-cl-rec-btn]");
    if (recBtn) {
      notice = "";
      return recommend(recBtn.dataset.clRecBtn);
    }
    if (event.target.closest("#clReset,[data-cl-reset]")) {
      notice = "";
      sales = {};
      appliedBy = {};
      clearRecs();
      draw();
      save();
      return;
    }
    if (event.target.closest("#clExOff")) {
      excl.clear();
      lit.clear();
      return replan(null);
    }
    const applyBtn = event.target.closest("[data-cl-apply]");
    if (applyBtn) {
      notice = "";
      const id = applyBtn.dataset.clApply;
      const applied = recBy[id]?.apply || [];
      applied.forEach(({ id: code, nv }) => {
        sales[code] = Number(sales[code] || 0) + nv;
      });
      if (applied.length) appliedBy[id] = [...(appliedBy[id] || []), ...applied.map(({ id: code, nv }) => ({ id: code, nv }))];
      delete previewBy[id];
      return rebuildRecs(id);
    }
    const sectionOf = () => event.target.closest("[data-cl-sec]")?.dataset.clSec;
    const exBtn = event.target.closest("[data-cl-ex]");
    if (exBtn) {
      notice = "";
      excludeCode(exBtn.dataset.clEx);
      return replan(exBtn.dataset.clEx, sectionOf());
    }
    const undo = event.target.closest("[data-cl-undo]");
    if (undo) {
      event.preventDefault();
      excl.delete(undo.dataset.clUndo);
      return replan(undo.dataset.clUndo, sectionOf());
    }
    if (event.target.closest("input,label")) return;
    const card = event.target.closest("[data-cl-card]");
    if (!card) return;
    const id = card.dataset.clCard;
    notice = "";
    if (clickMode === "lit") {
      if (lit.has(id)) lit.delete(id);
      else lit.add(id);
    } else if (excl.has(id)) excl.delete(id);
    else excludeCode(id);
    replan(clickMode === "lit" ? null : id);
  };

  // 빈 곳을 끌면 화면이 움직인다(손바닥). 끌었을 때는 박스가 눌리지 않게 한다.
  let pan = null;
  root.onpointerdown = (event) => {
    const canvas = event.target.closest(".pannable-tree");
    if (!canvas || event.button !== 0 || event.target.closest("input,button,select,textarea,label,a")) return;
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
  dragGuards.get(root)?.();
  const dragGuard = (event) => {
    if (!pan?.moved) return;
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener("click", dragGuard, true);
  dragGuards.set(root, () => root.removeEventListener("click", dragGuard, true));

  try {
    await loadSnapshot();
  } catch (error) {
    $("clSource").textContent = "";
    $("clError").textContent = error.message;
  }
}
