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
const formula = (branch) =>
  `본인 ${fmt(branch.own)} + 대 ${fmt(branch.major)} + 소 ${fmt(branch.minor)}`;

export async function performancePage(root) {
  const savedMajorTarget = Number(
    localStorage.getItem("nrc-performance-major-target") || 200000,
  );
  const savedMinorTarget = Number(
    localStorage.getItem("nrc-performance-minor-target") || 200000,
  );
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>목표 실적 계산기</h2><p class="help">대실적·소실적 목표를 각각 입력해 부족분과 추천 회원을 계산합니다.</p></div></div><p id="perfSource" class="help"></p><label>계산할 회원<select id="perfMember"></select></label><div class="activity-grid two"><label>대실적 목표 NV<input id="perfMajorTarget" type="number" min="1" step="1000" value="${savedMajorTarget}"></label><label>소실적 목표 NV<input id="perfMinorTarget" type="number" min="1" step="1000" value="${savedMinorTarget}"></label></div><button id="perfRun" class="primary">부족분 계산</button><div id="perfError" class="error"></div></section><section id="perfResult"></section>`;
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

  $("perfRun").onclick = () => {
    try {
      const majorTarget = Number($("perfMajorTarget").value);
      const minorTarget = Number($("perfMinorTarget").value);
      const result = calculatePerformance(model, $("perfMember").value, {
        majorTarget,
        minorTarget,
      });
      localStorage.setItem("nrc-performance-major-target", String(majorTarget));
      localStorage.setItem("nrc-performance-minor-target", String(minorTarget));

      const totals = result.effectiveTotals;
      const warnings = result.warnings.length
        ? `<p class="error">${result.warnings.map(safe).join(" ")}</p>`
        : "";
      const recommendation = result.achieved
        ? `<section class="recommend-card"><span>계산 결과</span><h2>목표 달성</h2><p>입력한 대실적·소실적 목표의 부족 NV가 없습니다.</p><small>※ 목표값을 바꾸면 즉시 다시 계산할 수 있습니다.</small></section>`
        : `<section class="recommend-card"><span>최적 배치 제안</span><h2>${result.candidate?.userName ? safe(result.candidate.userName) : `${result.priority + 1}번 서브 신규 위치`}</h2><p>${result.priority + 1}번 서브 라인에 <b>${fmt(result.deficits[result.priority])} NV</b>가 부족합니다.</p><small>※ 현재 JSON의 본인·대·소실적 합산 초안입니다. 실제 매출 이동 전 손계산 결과와 반드시 비교하세요.</small></section>`;

      $("perfError").textContent = "";
      $("perfResult").innerHTML =
        `<section class="card"><h2>${safe(result.member.userName)} · 대 ${fmt(result.majorTarget)} / 소 ${fmt(result.minorTarget)} 목표</h2><div class="perf-grid"><article><span>본인 NV</span><b>${fmt(result.member.ordPv)}</b><small>소실적 목표에서 ${fmt(result.minorOwnContribution)} 차감</small></article>${result.branches.map((branch, index) => `<article><span>서브${index + 1} · ${index === result.majorIndex ? "대실적" : "소실적"} 라인</span><b>${fmt(result.effectiveTotals[index])}</b><small>${formula(branch)}${index === result.minorIndex ? ` + 선택 회원 본인 ${fmt(result.minorOwnContribution)}` : ""} · ${index === result.minorIndex ? "소실적 필요 목표" : "대실적 목표"} ${fmt(result.branchTargets[index])}</small><em>부족 ${fmt(result.deficits[index])}</em></article>`).join("")}<article><span>대 / 소실적</span><b>${fmt(result.effectiveTotals[result.majorIndex])} / ${fmt(result.effectiveTotals[result.minorIndex])}</b><small>소실적 입력 목표 ${fmt(result.minorTarget)} − 본인 NV ${fmt(result.minorOwnContribution)} = 소실적 필요 목표 ${fmt(result.minorRequiredTarget)}</small></article></div>${warnings}</section>${recommendation}`;
    } catch (calculationError) {
      $("perfError").textContent = calculationError.message;
      $("perfResult").replaceChildren();
    }
  };
  $("perfRun").click();
}
