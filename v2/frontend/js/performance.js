import { supabase } from "./supabase.js?v=20260829-11";
import {
  applyClosingCompletion,
  buildPerformanceModel,
  calculatePerformance,
  projectClosingCompletion,
  sortMembersDeepestFirst,
} from "./performance-calculator.js?v=20260829-49";

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

const resultHtml = (
  { result, projection, completion, canComplete },
  order,
  total,
) => {
  const warnings = result.warnings.length
    ? `<p class="error">${result.warnings.map(safe).join(" ")}</p>`
    : "";
  const placement = (index) => {
    const plan = projection.topUps[index];
    const target =
      result.branchCandidates[index]?.userName || result.member.userName;
    const side = index === result.majorIndex ? "대실적" : "소실적";
    return plan.salesWon > 0
      ? `<p><b>${side}</b> · ${safe(target)}에게 매출 ${fmt(plan.salesWon)}원 → ${fmt(plan.addedNv)} NV 추가</p>`
      : `<p><b>${side}</b> · 추가 매출 없음</p>`;
  };
  const recommendation = completion
    ? `<section class="recommend-card"><span>${safe(result.member.userName)} 마감 완료</span><h2>대 ${fmt(completion.majorNv)} / 소 ${fmt(completion.minorNv)}</h2><p>상위 라인에 <b>${fmt(completion.completedNv)} NV</b> 반영</p><button class="secondary" data-cancel-closing="${safe(result.member.userId)}" type="button">마감 취소</button></section>`
    : `<section class="recommend-card"><span>${safe(result.member.userName)} 매출 배치</span>${placement(result.majorIndex)}${placement(result.minorIndex)}<h2>예상 마감 · 대 ${fmt(projection.majorNv)} / 소 ${fmt(projection.minorNv)}</h2><p>상위 반영 예정 <b>${fmt(projection.completedNv)} NV</b></p><button class="secondary" data-complete-closing="${safe(result.member.userId)}" type="button" ${canComplete ? "" : "disabled"}>${canComplete ? "마감 완료" : "아래 사업자 마감 후 가능"}</button></section>`;

  return `<div class="closing-result"><section class="card"><div class="section-head"><h2>${order}/${total} · ${safe(result.member.userName)} 마감</h2><b>${completion ? "완료" : "계산 중"}</b></div><p class="help">대실적 목표 ${fmt(result.majorTarget)} / 소실적 목표 ${fmt(result.minorTarget)}</p><div class="perf-grid"><article><span>본인 매출 NV</span><b>${fmt(result.member.ordPv)}</b><small>작은 하위 라인에 합산</small></article>${result.branches.map((branch, index) => `<article><span>서브${index + 1} ${index === result.majorIndex ? "대실적" : "소실적"}</span><b>${fmt(result.effectiveTotals[index])}</b><small>${branch.completed ? `하위 마감 완료 ${fmt(branch.total)}` : `현재 라인 ${fmt(branch.total)}`}${index === result.ownContributionIndex ? ` + 본인 ${fmt(result.minorOwnContribution)}` : ""}</small><em>목표까지 ${fmt(result.deficits[index])} 부족</em></article>`).join("")}<article><span>목표까지 부족한 NV</span><b>대 ${fmt(result.deficits[result.majorIndex])} / 소 ${fmt(result.deficits[result.minorIndex])}</b><small>1,000원 매출 = 810 NV</small></article></div>${warnings}</section>${recommendation}</div>`;
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
  const completions = readJson("nrc-closing-completions", {});
  let calculatedItems = [];

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
      model.rows.forEach((row) => {
        delete row.completedClosingMajorNv;
        delete row.completedClosingMinorNv;
        delete row.completedClosingNv;
        delete row.closingDescendantDeltaNv;
      });
      calculatedItems = ordered.map((row) => {
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
        const result = calculatePerformance(model, row.userId, {
          majorTarget,
          minorTarget,
        });
        const projection = projectClosingCompletion(result);
        const completion = completions[row.userId] || null;
        if (completion) applyClosingCompletion(model, row.userId, completion);
        return { result, projection, completion };
      });
      const nextIndex = calculatedItems.findIndex((item) => !item.completion);
      calculatedItems.forEach((item, index) => {
        item.canComplete = index === nextIndex;
      });
      localStorage.setItem("nrc-closing-members", JSON.stringify(selectedIds));
      localStorage.setItem(
        "nrc-closing-member-targets",
        JSON.stringify(targets),
      );
      $("perfError").textContent = "";
      $("perfResult").innerHTML = calculatedItems
        .map((item, index) =>
          resultHtml(item, index + 1, calculatedItems.length),
        )
        .join("");
    } catch (calculationError) {
      $("perfError").textContent = calculationError.message;
      $("perfResult").replaceChildren();
    }
  };

  $("perfResult").onclick = (event) => {
    const completeButton = event.target.closest("[data-complete-closing]");
    const cancelButton = event.target.closest("[data-cancel-closing]");
    if (completeButton) {
      const id = completeButton.dataset.completeClosing;
      const item = calculatedItems.find(
        ({ result }) => String(result.member.userId) === id,
      );
      if (!item?.canComplete) return;
      completions[id] = {
        majorNv: item.projection.majorNv,
        minorNv: item.projection.minorNv,
        completedNv: item.projection.completedNv,
        completedAt: new Date().toISOString(),
      };
      localStorage.setItem(
        "nrc-closing-completions",
        JSON.stringify(completions),
      );
      $("perfRun").click();
    }
    if (cancelButton) {
      const cancelId = cancelButton.dataset.cancelClosing;
      const cancelIndex = calculatedItems.findIndex(
        ({ result }) => String(result.member.userId) === cancelId,
      );
      calculatedItems.slice(Math.max(0, cancelIndex)).forEach(({ result }) => {
        delete completions[result.member.userId];
      });
      localStorage.setItem(
        "nrc-closing-completions",
        JSON.stringify(completions),
      );
      $("perfRun").click();
    }
  };

  renderTargets();
  $("perfRun").click();
}
