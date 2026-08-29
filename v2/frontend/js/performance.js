import { supabase } from "./supabase.js?v=20260829-11";
import {
  buildPerformanceModel,
  calculatePerformance,
  sortMembersDeepestFirst,
} from "./performance-calculator.js?v=20260829-47";

const fmt = (value) => Number(value || 0).toLocaleString("ko-KR");
const safe = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};

const resultHtml = (result, order, total) => {
  const warnings = result.warnings.length
    ? `<p class="error">${result.warnings.map(safe).join(" ")}</p>`
    : "";
  const recommendation = result.achieved
    ? `<section class="recommend-card"><span>${safe(result.member.userName)} 마감 결과</span><h2>목표 달성</h2><p>대실적·소실적 모두 부족한 NV가 없습니다.</p></section>`
    : `<section class="recommend-card"><span>${safe(result.member.userName)} 최적 배치 제안</span><h2>${result.candidate?.userName ? `계보도 ${safe(result.candidate.userName)}에게` : `계보도 ${result.priority + 1}번 서브 신규 위치에`}</h2><p>매출 <b>${fmt(result.deficits[result.priority])} NV</b>가 부족합니다.</p><small>※ 실제 매출을 이동하기 전에 손계산 결과와 한 번 더 비교하세요.</small></section>`;

  return `<div class="closing-result"><section class="card"><div class="section-head"><h2>${order}/${total} · ${safe(result.member.userName)} 마감</h2><b>아래부터 계산</b></div><p class="help">대실적 목표 ${fmt(result.majorTarget)} / 소실적 목표 ${fmt(result.minorTarget)}</p><div class="perf-grid"><article><span>본인 매출 NV</span><b>${fmt(result.member.ordPv)}</b><small>소실적에 포함됩니다.</small></article>${result.branches.map((branch, index) => `<article><span>서브${index + 1} ${index === result.majorIndex ? "대실적" : "소실적"}</span><b>${fmt(result.effectiveTotals[index])}</b><small>${index === result.minorIndex ? `서브${index + 1} ${fmt(branch.total)} + 본인 ${fmt(result.minorOwnContribution)}` : `현재 실적 ${fmt(branch.total)}`}</small><em>목표까지 ${fmt(result.deficits[index])} 부족</em></article>`).join("")}<article><span>목표까지 부족한 NV</span><b>대 ${fmt(result.deficits[result.majorIndex])} / 소 ${fmt(result.deficits[result.minorIndex])}</b><small>소실적에는 본인 매출이 포함되었습니다.</small></article></div>${warnings}</section>${recommendation}</div>`;
};

export async function performancePage(root) {
  const defaultMajor = Number(
    localStorage.getItem("nrc-performance-major-target") || 200000,
  );
  const defaultMinor = Number(
    localStorage.getItem("nrc-performance-minor-target") || 200000,
  );
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 실적 계산기</h2><p class="help">마감해야 할 사업자를 모두 선택하세요. 계보도에서 가장 아래 사업자부터 계산합니다.</p></div></div><p id="perfSource" class="help"></p><details class="closing-member-picker" open><summary>마감 사업자 선택 <b id="closingCount">0명</b></summary><div id="closingOptions" class="closing-member-options"></div></details><div id="closingTargets" class="closing-targets"></div><button id="perfRun" class="primary">선택한 사업자 모두 계산</button><div id="perfError" class="error"></div></section><section id="perfResult"></section>`;
  const $ = (id) => document.getElementById(id);
  const { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("payload,collected_at")
    .eq("snapshot_type", "combined")
    .order("collected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    $("perfError").textContent = error?.message || "수집된 JSON이 없습니다.";
    return;
  }

  let model;
  try {
    const payload =
      typeof data.payload === "string"
        ? JSON.parse(data.payload)
        : data.payload;
    model = buildPerformanceModel(payload);
  } catch (parseError) {
    $("perfError").textContent = parseError.message;
    return;
  }

  const legacyMember = localStorage.getItem("nrc-closing-member");
  let selectedIds = readJson("nrc-closing-members", []);
  selectedIds = selectedIds.filter((id) => model.byId.has(String(id)));
  if (!selectedIds.length && legacyMember && model.byId.has(legacyMember)) {
    selectedIds = [legacyMember];
  }
  if (!selectedIds.length && model.rows[0])
    selectedIds = [model.rows[0].userId];
  const targets = readJson("nrc-closing-member-targets", {});

  $("perfSource").textContent =
    `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · 체크한 사업자 전원을 아래 계보부터 순서대로 계산합니다.`;
  $("closingOptions").innerHTML = model.rows
    .map(
      (row) =>
        `<label class="check"><input type="checkbox" value="${safe(row.userId)}" ${selectedIds.includes(String(row.userId)) ? "checked" : ""}> <span>${safe(row.userName)} <small>(${safe(row.userId)})</small></span></label>`,
    )
    .join("");

  const renderTargets = () => {
    const ordered = sortMembersDeepestFirst(model, selectedIds);
    $("closingCount").textContent = `${ordered.length}명`;
    $("closingTargets").innerHTML = ordered.length
      ? `<h3>마감 사업자별 목표 <small>계보도 아래 순서</small></h3>${ordered
          .map((row, index) => {
            const saved = targets[row.userId] || {};
            return `<article class="closing-target-row" data-member-id="${safe(row.userId)}"><b>${index + 1}. ${safe(row.userName)} <small>(${safe(row.userId)})</small></b><label>대실적<input data-target="major" type="number" min="1" step="1000" value="${Number(saved.major || defaultMajor)}"></label><label>소실적<input data-target="minor" type="number" min="1" step="1000" value="${Number(saved.minor || defaultMinor)}"></label></article>`;
          })
          .join("")}`
      : '<p class="error">마감할 사업자를 한 명 이상 선택하세요.</p>';
  };

  $("closingOptions").onchange = () => {
    selectedIds = [
      ...$("closingOptions").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    localStorage.setItem("nrc-closing-members", JSON.stringify(selectedIds));
    renderTargets();
  };

  $("perfRun").onclick = () => {
    try {
      const ordered = sortMembersDeepestFirst(model, selectedIds);
      if (!ordered.length) throw new Error("마감할 사업자를 선택하세요.");
      const results = ordered.map((row) => {
        const targetRow = root.querySelector(
          `.closing-target-row[data-member-id="${CSS.escape(String(row.userId))}"]`,
        );
        const majorTarget = Number(
          targetRow.querySelector('[data-target="major"]').value,
        );
        const minorTarget = Number(
          targetRow.querySelector('[data-target="minor"]').value,
        );
        targets[row.userId] = { major: majorTarget, minor: minorTarget };
        return calculatePerformance(model, row.userId, {
          majorTarget,
          minorTarget,
        });
      });
      localStorage.setItem("nrc-closing-members", JSON.stringify(selectedIds));
      localStorage.setItem(
        "nrc-closing-member-targets",
        JSON.stringify(targets),
      );
      $("perfError").textContent = "";
      $("perfResult").innerHTML = results
        .map((result, index) => resultHtml(result, index + 1, results.length))
        .join("");
    } catch (calculationError) {
      $("perfError").textContent = calculationError.message;
      $("perfResult").replaceChildren();
    }
  };

  renderTargets();
  $("perfRun").click();
}
