import { supabase } from "./supabase.js?v=20260829-11";
import {
  allocateClosingTargets,
  applyClosingCompletion,
  branchBreakdown,
  buildPerformanceModel,
  calculatePerformance,
  cancelCompletionCascade,
  planSignature,
  projectClosingCompletion,
  pruneInvalidCompletions,
  sortMembersDeepestFirst,
} from "./performance-calculator.js?v=20260829-53";
import { boxTreeHtml } from "./box-tree.js?v=20260829-53";

const PLAN_TABLE = "nrc_closing_plans";
const MIN_TREE_ZOOM = 0.72;
const LOCAL_PLAN_KEY = "nrc-closing-plan-backup";
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

const flattenAllocation = (node, out = []) => {
  out.push(node);
  node.lines.forEach((line) => {
    if (line.childAllocation) flattenAllocation(line.childAllocation, out);
  });
  return out;
};

export async function performancePage(root) {
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 실적 계산기</h2><p class="help">기준이 되는 최상위 마감 사업자와 목표만 정하면, 아래 사업자들의 목표는 자동으로 나눠서 계산합니다.</p></div></div><p id="perfSource" class="help"></p><p id="perfStorage" class="help"></p><div class="closing-target-row"><label>최상위 마감 사업자<select id="topMemberSelect"></select></label><label>대실적 목표 (NV)<input id="topMajor" type="number" min="1" step="1000"></label><label>소실적 목표 (NV)<input id="topMinor" type="number" min="1" step="1000"></label></div><details class="closing-member-picker" open><summary>마감할 하위 사업자 선택 <b id="closingCount">0명</b></summary><p class="help">체크한 사업자에게만 목표가 자동으로 내려갑니다. 체크하지 않은 회원의 라인은 지금 실적을 그대로 위로 올립니다.</p><div id="closingOptions" class="closing-member-options"></div></details><button id="perfRun" class="primary">자동 배분 계산</button><p id="perfNotice" class="help"></p><div id="perfError" class="error"></div></section><section id="perfSummary"></section><section id="perfResult"></section>`;
  const $ = (id) => document.getElementById(id);
  const { data, error } = await supabase
    .from("nrc_sync_snapshots")
    .select("payload,collected_at,source_account_id")
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
    `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · 계보도 가장 아래 사업자부터 순서대로 마감합니다.`;

  const { data: auth } = await supabase.auth.getUser().catch(() => ({}));
  const ownerId = auth?.user?.id || null;
  let storage = ownerId ? "supabase" : "local";
  let storageNote = ownerId
    ? ""
    : "로그인 정보를 찾지 못해 이 브라우저에만 저장합니다.";
  let plan = null;
  let lastRun = null;
  let lastSignature = "";
  let items = [];

  const legacyPlan = () => {
    const selected = readJson("nrc-closing-members", [])
      .map(String)
      .filter((id) => model.byId.has(id));
    if (!selected.length) return null;
    const ordered = sortMembersDeepestFirst(model, selected);
    const top = ordered[ordered.length - 1];
    const targets = readJson("nrc-closing-member-targets", {});
    const completions = readJson("nrc-closing-completions", {});
    const topMajorTarget =
      Number(targets[top.userId]?.major) ||
      Number(localStorage.getItem("nrc-performance-major-target")) ||
      400000;
    const topMinorTarget =
      Number(targets[top.userId]?.minor) ||
      Number(localStorage.getItem("nrc-performance-minor-target")) ||
      400000;
    const signature = planSignature(
      top.userId,
      { majorTarget: topMajorTarget, minorTarget: topMinorTarget },
      selected,
    );
    return {
      topMemberId: String(top.userId),
      topMajorTarget,
      topMinorTarget,
      closingMemberIds: selected,
      targetOverrides: {},
      completions: Object.fromEntries(
        Object.entries(completions)
          .filter(([id]) => model.byId.has(String(id)))
          .map(([id, value]) => [id, { ...value, signature }]),
      ),
    };
  };

  const defaultPlan = () => ({
    topMemberId: String(model.rows[0].userId),
    topMajorTarget: 400000,
    topMinorTarget: 400000,
    closingMemberIds: [String(model.rows[0].userId)],
    targetOverrides: {},
    completions: {},
  });

  const rowToPlan = (row) => ({
    topMemberId: String(row.top_member_id),
    topMajorTarget: Number(row.top_major_target),
    topMinorTarget: Number(row.top_minor_target),
    closingMemberIds: (row.closing_member_ids || []).map(String),
    targetOverrides: row.allocation?.targetOverrides || {},
    completions: row.completions || {},
  });

  const renderStorageNote = () => {
    $("perfStorage").textContent =
      storage === "supabase"
        ? "저장 위치: 내 계정(Supabase) · 다른 기기에서도 이어서 볼 수 있습니다."
        : `저장 위치: 이 브라우저만 · ${storageNote}`;
  };

  async function persistPlan() {
    const topCompletion = plan.completions[plan.topMemberId] || null;
    if (storage === "supabase") {
      const row = {
        owner_id: ownerId,
        top_member_id: plan.topMemberId,
        top_major_target: plan.topMajorTarget,
        top_minor_target: plan.topMinorTarget,
        closing_member_ids: plan.closingMemberIds,
        completions: plan.completions,
        allocation: lastRun?.allocation
          ? { ...lastRun.allocation, targetOverrides: plan.targetOverrides }
          : Object.keys(plan.targetOverrides || {}).length
            ? { targetOverrides: plan.targetOverrides }
            : null,
        placements: lastRun?.placements || null,
        top_major_nv: lastRun?.topMajorNv ?? null,
        top_minor_nv: lastRun?.topMinorNv ?? null,
        top_completed_nv: lastRun?.topCompletedNv ?? null,
        verified: Boolean(lastRun?.verified),
        status: topCompletion ? "DONE" : "DRAFT",
        completed_at: topCompletion?.completedAt || null,
        snapshot_source_account_id: data.source_account_id || null,
        snapshot_collected_at: data.collected_at || null,
        updated_at: new Date().toISOString(),
      };
      const { error: saveError } = await supabase
        .from(PLAN_TABLE)
        .upsert(row, { onConflict: "owner_id,top_member_id" });
      if (!saveError) {
        renderStorageNote();
        return true;
      }
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        saveError.message,
      )
        ? "Supabase에서 RUN_012_CLOSING_PLANS.sql을 먼저 실행하세요. 기존 데이터는 삭제하지 않았습니다."
        : `Supabase 저장 실패: ${saveError.message} (기존 데이터는 그대로 남아 있습니다)`;
    }
    try {
      localStorage.setItem(LOCAL_PLAN_KEY, JSON.stringify(plan));
    } catch {}
    renderStorageNote();
    return false;
  }

  if (storage === "supabase") {
    const { data: planRow, error: planError } = await supabase
      .from(PLAN_TABLE)
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (planError) {
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        planError.message,
      )
        ? "Supabase에서 RUN_012_CLOSING_PLANS.sql을 먼저 실행하면 계정에 저장됩니다."
        : `Supabase 조회 오류: ${planError.message}`;
    } else if (planRow) {
      plan = rowToPlan(planRow);
    } else {
      const migrated = legacyPlan();
      if (migrated) {
        plan = migrated;
        await persistPlan();
      }
    }
  }
  if (!plan) {
    plan =
      (storage === "local" && readJson(LOCAL_PLAN_KEY, null)) ||
      legacyPlan() ||
      defaultPlan();
  }
  if (!model.byId.has(String(plan.topMemberId))) plan = defaultPlan();
  plan.closingMemberIds = (plan.closingMemberIds || [])
    .map(String)
    .filter((id) => model.byId.has(id));
  if (!plan.closingMemberIds.includes(plan.topMemberId)) {
    plan.closingMemberIds.push(plan.topMemberId);
  }
  plan.targetOverrides = Object.fromEntries(
    Object.entries(plan.targetOverrides || {}).filter(([id]) =>
      model.byId.has(String(id)),
    ),
  );
  renderStorageNote();

  const descendantsOf = (topId) => {
    const out = [];
    const stack = [...(model.children.get(String(topId)) || [])];
    while (stack.length) {
      const row = stack.pop();
      out.push(row);
      (model.children.get(String(row.userId)) || []).forEach((child) =>
        stack.push(child),
      );
    }
    return out.sort(
      (left, right) => model.rows.indexOf(left) - model.rows.indexOf(right),
    );
  };

  const renderControls = () => {
    $("topMemberSelect").innerHTML = model.rows
      .map(
        (row) =>
          `<option value="${safe(row.userId)}" ${String(row.userId) === plan.topMemberId ? "selected" : ""}>${safe(row.userName)} (${safe(row.userId)})</option>`,
      )
      .join("");
    $("topMajor").value = plan.topMajorTarget;
    $("topMinor").value = plan.topMinorTarget;
    renderClosers();
  };

  const renderClosers = () => {
    const rows = descendantsOf(plan.topMemberId);
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
    $("closingOptions").innerHTML = rows.length
      ? rows
          .map(
            (row) =>
              `<label class="check"><input type="checkbox" value="${safe(row.userId)}" ${plan.closingMemberIds.includes(String(row.userId)) ? "checked" : ""}> <span>${safe(row.userName)} <small>(${safe(row.userId)})</small></span></label>`,
          )
          .join("")
      : '<p class="help">이 사업자 아래에는 하위 회원이 없습니다.</p>';
  };

  const lineHtml = (item, index) => {
    const { node, result, projection } = item;
    const line = node.lines[index];
    const isMajor = index === result.majorIndex;
    const branch = result.branches[index];
    const subMember = result.subMembers[index];
    const topUp = projection.topUps[index];
    const placement = result.placements[index];
    const deficit = result.deficits[index];
    let role;
    if (!subMember) {
      role =
        index === result.ownContributionIndex
          ? "하위 회원이 없어 본인 매출로 채우는 라인"
          : "하위 회원이 없는 라인";
    } else if (line.childAllocation) {
      const closer = model.byId.get(line.childAllocation.memberId);
      const childDone = Boolean(plan.completions[line.childAllocation.memberId]);
      const targetKind = line.childAllocation.overridden ? "직접 입력" : "자동";
      role = branch.completed
        ? `하위 마감 ${safe(closer?.userName || "")} ${childDone ? "완료값" : "예상 완료값"} ${fmt(branch.total)} NV 반영`
        : `하위 마감 ${safe(closer?.userName || "")} 진행 예정 (${targetKind} 목표 대 ${fmt(line.childAllocation.majorTarget)} / 소 ${fmt(line.childAllocation.minorTarget)})`;
    } else {
      role = "마감 대상 아님 · 전체 NV 그대로 반영";
    }
    const ownNote =
      index === result.ownContributionIndex && result.minorOwnContribution > 0
        ? `<small>본인 매출 ${fmt(result.minorOwnContribution)} NV가 이 라인에 합산됩니다.</small>`
        : "";
    const saleLine =
      topUp.salesWon > 0
        ? `<span class="sale-hint">매출 넣을 곳: ${safe(placement.target?.userName || "-")} (${safe(placement.target?.userId || "-")}) · ${fmt(topUp.salesWon)}원 → +${fmt(topUp.addedNv)} NV</span>`
        : deficit > 0
          ? `<span class="sale-hint">부족하지만 매출을 넣을 코드가 없습니다.</span>`
          : `<span>추가 매출이 필요 없습니다.</span>`;
    return `<article class="closing-line"><b>서브${index + 1} · ${isMajor ? "대실적" : "소실적"}</b><small>${role}</small>${ownNote}<small>지금 ${fmt(result.effectiveTotals[index])} NV · 라인 목표 ${fmt(line.lineTarget)} · ${deficit > 0 ? `${fmt(deficit)} NV 부족` : "목표를 채웠습니다"}</small>${saleLine}</article>`;
  };

  const treeHtml = (item) => {
    const { node, result, projection } = item;
    const badges = {};
    const notes = {};
    result.placements.forEach((placement, index) => {
      const topUp = projection.topUps[index];
      if (!placement.target || !topUp || topUp.salesWon <= 0) return;
      const id = String(placement.target.userId);
      badges[id] =
        `매출 ${fmt(topUp.salesWon)}원 → +${fmt(topUp.addedNv)} NV${placement.kind === "self" ? " (본인 코드)" : ""}`;
    });
    result.subMembers.forEach((subMember, index) => {
      if (!subMember) return;
      const side = index === result.majorIndex ? "대실적" : "소실적";
      const deficit = result.deficits[index];
      notes[String(subMember.userId)] =
        `서브${index + 1} · ${side} · 라인 ${fmt(result.effectiveTotals[index])} / 목표 ${fmt(node.lines[index].lineTarget)}${deficit > 0 ? ` · ${fmt(deficit)} 부족` : " · 채움"}`;
    });
    const ownIndex = result.ownContributionIndex;
    if (result.minorOwnContribution > 0) {
      notes[node.memberId] =
        `본인 매출 ${fmt(result.minorOwnContribution)} NV는 서브${ownIndex + 1} 라인에 합산`;
    }
    return `<details class="closing-tree"${item.canComplete ? " open" : ""}><summary>계보도로 확인하기</summary><div class="box-tree compact">${boxTreeHtml(model, node.memberId, {
      depth: 3,
      badges,
      notes,
      hideDate: true,
      clickable: false,
      totalOf: (row) => branchBreakdown(row).total,
    })}</div></details>`;
  };

  const fitTrees = () => {
    const boxes = [
      ...$("perfResult").querySelectorAll(".closing-tree[open] .box-tree"),
    ];
    const pass = (round) => {
      boxes.forEach((box) => {
        const list = box.firstElementChild;
        if (!list || !box.clientWidth) return;
        if (round === 0) list.style.zoom = 1;
        const available = box.clientWidth - 10;
        const overflow = box.scrollWidth - box.clientWidth;
        if (round === 0) {
          const needed = list.scrollWidth;
          if (needed > available)
            list.style.zoom = Math.max(MIN_TREE_ZOOM, available / needed);
        } else if (overflow > 1) {
          const current = Number(list.style.zoom) || 1;
          list.style.zoom = Math.max(
            MIN_TREE_ZOOM,
            current * (available / (available + overflow)),
          );
        }
        box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
      });
      if (round === 0) requestAnimationFrame(() => pass(1));
    };
    pass(0);
  };

  const stepHtml = (item, order, total) => {
    const member = model.byId.get(item.node.memberId);
    const title = `${order}/${total} · ${safe(member?.userName || "이름 없음")} <small>(${safe(item.node.memberId)})</small>`;
    if (item.skipped) {
      return `<section class="card closing-step"><div class="section-head"><h2>${title}</h2><b>추가 마감 불필요</b></div><p class="help">위에서 내려온 목표가 이미 라인 실적으로 채워져 추가 마감이 필요 없습니다.</p></section>`;
    }
    const { node, result, projection, completion } = item;
    const state = completion
      ? "완료"
      : item.canComplete
        ? "지금 마감할 차례"
        : "앞 순서 완료 후 진행";
    const warn = result.warnings.length
      ? `<p class="error">${result.warnings.map(safe).join(" ")}</p>`
      : "";
    const button = completion
      ? `<button class="secondary" data-cancel-closing="${safe(node.memberId)}" type="button">마감 취소</button>`
      : `<button class="primary" data-complete-closing="${safe(node.memberId)}" type="button" ${item.canComplete && projection.feasible !== false ? "" : "disabled"}>${projection.feasible === false ? "마감 불가" : item.canComplete ? "마감 완료로 표시" : "앞 순서부터 완료하세요"}</button>`;
    const final = completion
      ? `<p><b>확정 마감</b> · 대 ${fmt(completion.majorNv)} / 소 ${fmt(completion.minorNv)} → 상위 라인에 <b>${fmt(completion.completedNv)} NV</b> 반영</p>`
      : `<p><b>예상 마감</b> · 대 ${fmt(projection.majorNv)} / 소 ${fmt(projection.minorNv)} → 상위 라인에 <b>${fmt(projection.completedNv)} NV</b> 반영 예정</p>`;
    const targetBox =
      node.depth === 0
        ? `<p class="help">최상위 목표 · 대 ${fmt(node.majorTarget)} / 소 ${fmt(node.minorTarget)} (위에서 직접 입력한 값)</p>`
        : `<div class="closing-target-edit" data-target-member="${safe(node.memberId)}"><span>이 사업자 마감 목표 ${node.overridden ? "<em>직접 입력함</em>" : "<em>자동 배분값</em>"}</span><label>대실적<input data-sub-target="major" type="number" min="0" step="1000" value="${node.majorTarget}" ${completion ? "disabled" : ""}></label><label>소실적<input data-sub-target="minor" type="number" min="0" step="1000" value="${node.minorTarget}" ${completion ? "disabled" : ""}></label><button class="secondary compact" data-reset-target="${safe(node.memberId)}" type="button" ${node.overridden && !completion ? "" : "disabled"}>자동값으로</button><small>자동 배분값 대 ${fmt(node.autoMajorTarget)} / 소 ${fmt(node.autoMinorTarget)}${completion ? " · 마감을 취소해야 수정할 수 있습니다" : ""}</small></div>`;
    return `<section class="card closing-step"><div class="section-head"><h2>${title}</h2><b>${state}</b></div>${targetBox}<div class="closing-lines">${lineHtml(item, 0)}${lineHtml(item, 1)}</div>${treeHtml(item)}${final}${warn}${button}</section>`;
  };

  const runPlan = () => {
    $("perfError").textContent = "";
    plan.topMemberId = $("topMemberSelect").value;
    plan.topMajorTarget = Number($("topMajor").value);
    plan.topMinorTarget = Number($("topMinor").value);
    plan.closingMemberIds = [
      ...$("closingOptions").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    plan.targetOverrides = Object.fromEntries(
      Object.entries(plan.targetOverrides || {}).filter(([id]) =>
        plan.closingMemberIds.includes(String(id)),
      ),
    );
    lastSignature = planSignature(
      plan.topMemberId,
      { majorTarget: plan.topMajorTarget, minorTarget: plan.topMinorTarget },
      plan.closingMemberIds,
      plan.targetOverrides,
    );
    const validCompletions = pruneInvalidCompletions(
      plan.completions,
      lastSignature,
    );
    const invalidatedCount =
      Object.keys(plan.completions).length -
      Object.keys(validCompletions).length;
    plan.completions = validCompletions;
    $("perfNotice").textContent = invalidatedCount
      ? `최상위 사업자·목표·마감 사업자 조건이 바뀌어 이전 완료 상태 ${invalidatedCount}건을 초기화하고 다시 계산했습니다.`
      : "";
    try {
      model.rows.forEach((row) => {
        delete row.completedClosingMajorNv;
        delete row.completedClosingMinorNv;
        delete row.completedClosingNv;
        delete row.completedClosingPreviousTotal;
        delete row.closingDescendantDeltaNv;
      });
      const allocation = allocateClosingTargets(
        model,
        plan.topMemberId,
        { majorTarget: plan.topMajorTarget, minorTarget: plan.topMinorTarget },
        plan.closingMemberIds,
        plan.targetOverrides,
      );
      const nodes = flattenAllocation(allocation).sort(
        (left, right) => right.depth - left.depth,
      );
      items = nodes.map((node) => {
        if (node.majorTarget + node.minorTarget <= 0) {
          return { node, skipped: true, completion: null };
        }
        const result = calculatePerformance(model, node.memberId, {
          majorTarget: node.majorTarget,
          minorTarget: node.minorTarget,
        });
        const projection = projectClosingCompletion(result);
        const completion = plan.completions[node.memberId] || null;
        if (completion) {
          applyClosingCompletion(model, node.memberId, completion);
        } else if (projection.feasible !== false) {
          applyClosingCompletion(model, node.memberId, projection);
        }
        return { node, result, projection, completion };
      });
      const nextIndex = items.findIndex(
        (item) => !item.completion && !item.skipped,
      );
      items.forEach((item, index) => {
        item.canComplete = index === nextIndex;
      });
      const topItem = items[items.length - 1];
      const topMajorNv = topItem.completion
        ? Number(topItem.completion.majorNv)
        : Number(topItem.projection?.majorNv || 0);
      const topMinorNv = topItem.completion
        ? Number(topItem.completion.minorNv)
        : Number(topItem.projection?.minorNv || 0);
      const placements = items.flatMap((item) =>
        item.skipped
          ? []
          : item.projection.topUps
              .map((topUp, index) => ({
                closerMemberId: item.node.memberId,
                placementMemberId: item.result.placements[index].target
                  ? String(item.result.placements[index].target.userId)
                  : null,
                side: index === item.result.majorIndex ? "major" : "minor",
                salesWon: topUp.salesWon,
                addedNv: topUp.addedNv,
                excessNv: topUp.excessNv,
              }))
              .filter((placement) => placement.salesWon > 0),
      );
      const totalSalesWon = placements.reduce(
        (sum, placement) => sum + placement.salesWon,
        0,
      );
      const remainingSalesWon = items
        .filter((item) => !item.completion && !item.skipped)
        .flatMap((item) => item.projection.topUps)
        .reduce((sum, topUp) => sum + topUp.salesWon, 0);
      const infeasible = items.some(
        (item) => !item.skipped && item.projection.feasible === false,
      );
      const verified =
        !infeasible &&
        topMajorNv >= plan.topMajorTarget &&
        topMinorNv >= plan.topMinorTarget;
      lastRun = {
        allocation,
        placements,
        topMajorNv,
        topMinorNv,
        topCompletedNv: topMajorNv + topMinorNv,
        verified,
      };
      const topMember = model.byId.get(plan.topMemberId);
      $("perfSummary").innerHTML =
        `<section class="recommend-card"><span>전체 계획 요약 · ${safe(topMember?.userName || "")} 기준</span><h2>추천 매출 합계 ${fmt(totalSalesWon)}원</h2><p>아직 넣지 않은 매출 ${fmt(remainingSalesWon)}원 · 매출 1,000원 = 810 NV · 최소 10,000원부터</p><p>최상위 예상 마감 · 대 ${fmt(topMajorNv)} / 소 ${fmt(topMinorNv)} (목표 대 ${fmt(plan.topMajorTarget)} / 소 ${fmt(plan.topMinorTarget)})</p><p><b>${verified ? "✅ 이대로 진행하면 목표를 채울 수 있습니다" : "⚠️ 지금 계획으로는 목표를 채우지 못합니다"}</b></p></section>`;
      $("perfResult").innerHTML = items
        .map((item, index) => stepHtml(item, index + 1, items.length))
        .join("");
      fitTrees();
      renderClosers();
    } catch (calculationError) {
      $("perfError").textContent = calculationError.message;
      $("perfSummary").replaceChildren();
      $("perfResult").replaceChildren();
    }
  };

  $("topMemberSelect").onchange = () => {
    plan.topMemberId = $("topMemberSelect").value;
    const allowed = new Set(
      descendantsOf(plan.topMemberId).map((row) => String(row.userId)),
    );
    plan.closingMemberIds = plan.closingMemberIds.filter(
      (id) => allowed.has(id) || id === plan.topMemberId,
    );
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    renderClosers();
  };
  $("closingOptions").onchange = () => {
    plan.closingMemberIds = [
      ...$("closingOptions").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
  };
  $("perfRun").onclick = async () => {
    runPlan();
    await persistPlan();
  };
  $("perfResult").addEventListener("toggle", fitTrees, true);
  window.addEventListener("resize", fitTrees);
  $("perfResult").onchange = async (event) => {
    const input = event.target.closest("[data-sub-target]");
    if (!input) return;
    const box = input.closest("[data-target-member]");
    const id = box.dataset.targetMember;
    const major = Number(
      box.querySelector('[data-sub-target="major"]').value,
    );
    const minor = Number(
      box.querySelector('[data-sub-target="minor"]').value,
    );
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return;
    plan.targetOverrides = {
      ...plan.targetOverrides,
      [id]: { majorTarget: Math.max(0, major), minorTarget: Math.max(0, minor) },
    };
    runPlan();
    await persistPlan();
  };
  $("perfResult").onclick = async (event) => {
    const completeButton = event.target.closest("[data-complete-closing]");
    const cancelButton = event.target.closest("[data-cancel-closing]");
    const resetButton = event.target.closest("[data-reset-target]");
    if (resetButton) {
      const { [resetButton.dataset.resetTarget]: _removed, ...rest } =
        plan.targetOverrides || {};
      plan.targetOverrides = rest;
      runPlan();
      await persistPlan();
      return;
    }
    if (completeButton) {
      const id = completeButton.dataset.completeClosing;
      const item = items.find((entry) => entry.node.memberId === id);
      if (!item?.canComplete || item.projection.feasible === false) return;
      plan.completions[id] = {
        majorNv: item.projection.majorNv,
        minorNv: item.projection.minorNv,
        completedNv: item.projection.completedNv,
        completedAt: new Date().toISOString(),
        signature: lastSignature,
      };
      runPlan();
      await persistPlan();
    }
    if (cancelButton) {
      plan.completions = cancelCompletionCascade(
        model,
        plan.completions,
        cancelButton.dataset.cancelClosing,
      );
      runPlan();
      await persistPlan();
    }
  };

  renderControls();
  runPlan();
}
