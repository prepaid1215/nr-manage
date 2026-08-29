import { supabase } from "./supabase.js?v=20260829-11";
import {
  buildPerformanceModel,
  calculatePerformance,
} from "./performance-calculator.js?v=20260829-42";

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
export async function performancePage(root) {
  const savedMajorTarget = Number(
    localStorage.getItem("nrc-performance-major-target") || 200000,
  );
  const savedMinorTarget = Number(
    localStorage.getItem("nrc-performance-minor-target") || 200000,
  );
  const savedClosingMember = localStorage.getItem("nrc-closing-member") || "";
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 실적 계산기</h2><p class="help">마감할 사업자를 선택하고 목표를 입력하세요.</p></div></div><p id="perfSource" class="help"></p><label>마감할 사업자<select id="perfMember"></select></label><div class="activity-grid two"><label>대실적 목표 NV<input id="perfMajorTarget" type="number" min="1" step="1000" value="${savedMajorTarget}"></label><label>소실적 목표 NV<input id="perfMinorTarget" type="number" min="1" step="1000" value="${savedMinorTarget}"></label></div><button id="perfRun" class="primary">부족분 계산</button><div id="perfError" class="error"></div></section><section id="perfResult"></section>`;
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

  $("perfSource").textContent =
    `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · 소실적 필요 목표 = 입력 목표 − 선택 회원 본인 NV`;
  $("perfMember").innerHTML = model.rows
    .map(
      (row) =>
        `<option value="${safe(row.userId)}">${safe(row.userName)} (${safe(row.userId)})</option>`,
    )
    .join("");
  if (savedClosingMember && model.byId.has(savedClosingMember)) {
    $("perfMember").value = savedClosingMember;
  }

  $("perfRun").onclick = () => {
    try {
      const majorTarget = Number($("perfMajorTarget").value);
      const minorTarget = Number($("perfMinorTarget").value);
      const result = calculatePerformance(model, $("perfMember").value, {
        majorTarget,
        minorTarget,
      });
      localStorage.setItem("nrc-closing-member", $("perfMember").value);
      localStorage.setItem("nrc-performance-major-target", String(majorTarget));
      localStorage.setItem("nrc-performance-minor-target", String(minorTarget));

      const warnings = result.warnings.length
        ? `<p class="error">${result.warnings.map(safe).join(" ")}</p>`
        : "";
      const recommendation = result.achieved
        ? `<section class="recommend-card"><span>계산 결과</span><h2>목표 달성</h2><p>입력한 대실적·소실적 목표의 부족 NV가 없습니다.</p><small>※ 목표값을 바꾸면 즉시 다시 계산할 수 있습니다.</small></section>`
        : `<section class="recommend-card"><span>최적 배치 제안</span><h2>${result.candidate?.userName ? `계보도 ${safe(result.candidate.userName)}에게` : `계보도 ${result.priority + 1}번 서브 신규 위치에`}</h2><p>매출 <b>${fmt(result.deficits[result.priority])} NV</b>가 부족합니다.</p><small>※ 실제 매출을 이동하기 전에 손계산 결과와 한 번 더 비교하세요.</small></section>`;

      $("perfError").textContent = "";
      $("perfResult").innerHTML =
        `<section class="card"><h2>${safe(result.member.userName)} · 대실적 목표 ${fmt(result.majorTarget)} / 소실적 목표 ${fmt(result.minorTarget)}</h2><div class="perf-grid"><article><span>본인 매출 NV</span><b>${fmt(result.member.ordPv)}</b><small>소실적에 포함됩니다.</small></article>${result.branches.map((branch, index) => `<article><span>서브${index + 1} ${index === result.majorIndex ? "대실적" : "소실적"}</span><b>${fmt(result.effectiveTotals[index])}</b><small>${index === result.minorIndex ? `서브${index + 1} ${fmt(branch.total)} + 본인 ${fmt(result.minorOwnContribution)}` : `현재 실적 ${fmt(branch.total)}`}</small><em>목표까지 ${fmt(result.deficits[index])} 부족</em></article>`).join("")}<article><span>목표까지 부족한 NV</span><b>대 ${fmt(result.deficits[result.majorIndex])} / 소 ${fmt(result.deficits[result.minorIndex])}</b><small>소실적에는 본인 매출이 포함되었습니다.</small></article></div>${warnings}</section>${recommendation}`;
    } catch (calculationError) {
      $("perfError").textContent = calculationError.message;
      $("perfResult").replaceChildren();
    }
  };
  $("perfRun").click();
}
