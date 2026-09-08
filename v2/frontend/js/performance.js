import { supabase } from "./supabase.js?v=20260829-34";
import {
  attachPerformanceSubtree,
  applyClosingCompletion,
  applyOwnSalesFlow,
  branchBreakdown,
  buildPerformanceModel,
  calculatePerformance,
  cancelCompletionCascade,
  closingPeriodForDate,
  completionWhenAchieved,
  evaluatePromotion,
  evaluatePromotionPath,
  planSignature,
  planBalancedClosingTopUp,
  projectClosingCompletion,
  pruneInvalidCompletions,
  sortMembersDeepestFirst,
} from "./performance-calculator.js?v=20260908-57";
import { boxTreeHtml } from "./box-tree.js?v=20260831-60";
import {
  addManualLink,
  loadManualLinks,
  removeManualLink,
} from "./genealogy-links.js?v=20260831-1";

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

export async function performancePage(root) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const initialPeriod = closingPeriodForDate(today);
  root.innerHTML = `<section class="card"><div class="section-head"><div><h2>마감 실적 계산기</h2><p class="help">이번 차수에 실제로 마감할 사업자만 선택하고, 각 사업자의 대·소목표를 직접 입력하세요.</p></div><label>기준일<input id="perfDate" type="date" value="${initialPeriod.endDate}"></label></div><p id="perfPeriod" class="connection-status"></p><p id="perfSource" class="help"></p><p id="perfStorage" class="help"></p><div class="closing-target-row"><label>최상위 마감 사업자<select id="topMemberSelect"></select></label><label>대실적 목표 (NV)<input id="topMajor" type="number" min="1" step="1000"></label><label>소실적 목표 (NV)<input id="topMinor" type="number" min="1" step="1000"></label></div><div id="firstRoundTop" class="closing-target-row" hidden><label>1차 현재 대실적 직접 입력<input id="topCurrentMajor" type="number" min="0" step="1"></label><label>1차 현재 소실적 직접 입력<input id="topCurrentMinor" type="number" min="0" step="1"></label></div><details class="closing-member-picker" open><summary>이번 차수 마감 사업자 <b id="closingCount">0명</b></summary><p class="help">체크한 사업자만 별도로 마감합니다. 체크하지 않은 회원은 목표를 만들지 않고 현재 조직실적과 하위 증가분만 상위로 전달합니다.</p><div id="closingOptions" class="closing-member-options"></div><details class="performance-link-manager"><summary>끊긴 계보 수동으로 잇기</summary><p class="help">중간 회원이 수집자료에 보이지 않을 때 상위와 하위 사업자 회원번호를 직접 연결합니다. 같은 회원번호는 한 번만 계산됩니다.</p><form id="perfManualLinkForm" class="inline-form"><input id="perfLinkParent" placeholder="상위 회원번호" required><input id="perfLinkChild" placeholder="하위 사업자 회원번호" required><input id="perfLinkName" placeholder="하위 사업자 이름"><button class="primary compact" type="submit">계보 연결</button></form><div id="perfLinkError" class="error"></div><div id="perfLinkList" class="fav-list"></div></details></details><button id="perfRun" class="primary">현재 실적과 추천 매출 계산</button><p id="perfNotice" class="help"></p><div id="perfError" class="error"></div></section><section id="perfSummary"></section><section id="perfResult"></section>`;
  const $ = (id) => document.getElementById(id);
  let { data, error } = await supabase
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
  let collectedPerformance = new Map(
    model.rows.map((row) => [
      String(row.userId),
      { majorNv: Number(row.maxPv || 0), minorNv: Number(row.minPv || 0) },
    ]),
  );
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
  let period = initialPeriod;
  let previousPerformance = {};
  let firstRoundPerformance = {};
  let manualLinks = [];
  const snapshotModels = [];
  if (ownerId) {
    const { data: snapshots } = await supabase
      .from("nrc_sync_snapshots")
      .select("payload,collected_at,source_account_id")
      .eq("snapshot_type", "combined")
      .order("collected_at", { ascending: false })
      .limit(100);
    const seenSources = new Set();
    (snapshots || []).forEach((snapshot) => {
      const sourceId = String(snapshot.source_account_id || "");
      if (seenSources.has(sourceId)) return;
      seenSources.add(sourceId);
      try {
        const payload =
          typeof snapshot.payload === "string"
            ? JSON.parse(snapshot.payload)
            : snapshot.payload;
        snapshotModels.push({
          sourceId,
          collectedAt: snapshot.collected_at,
          model: buildPerformanceModel(payload),
        });
      } catch {}
    });
    let changed = true;
    let passes = 0;
    while (changed && passes <= snapshotModels.length) {
      changed = false;
      passes += 1;
      snapshotModels.forEach(({ model: sourceModel }) => {
        const overlaps = [...model.byId.keys()].filter((id) =>
          sourceModel.byId.has(id),
        );
        overlaps.forEach((id) => {
          if (attachPerformanceSubtree(model, sourceModel, id) > 0)
            changed = true;
        });
      });
    }
    manualLinks = await loadManualLinks(ownerId);
    manualLinks.forEach((link) => {
      const childId = String(link.member_id);
      const source =
        snapshotModels.find(({ model: sourceModel }) =>
          sourceModel.byId.has(childId),
        )?.model || (model.byId.has(childId) ? model : null);
      if (source) {
        attachPerformanceSubtree(model, source, childId, link.parent_id);
      } else if (model.byId.has(String(link.parent_id))) {
        const placeholder = buildPerformanceModel({
          rstLst: [
            {
              userId: childId,
              userName: link.member_name,
              ppId: String(link.parent_id),
              manualLink: true,
            },
          ],
        });
        attachPerformanceSubtree(
          model,
          placeholder,
          childId,
          link.parent_id,
        );
      }
    });
    collectedPerformance = new Map(
      model.rows.map((row) => [
        String(row.userId),
        { majorNv: Number(row.maxPv || 0), minorNv: Number(row.minPv || 0) },
      ]),
    );
  }

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
      manualPerformance: {},
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
    manualPerformance: {},
    completions: {},
  });

  const rowToPlan = (row) => ({
    topMemberId: String(row.top_member_id),
    topMajorTarget: Number(row.top_major_target),
    topMinorTarget: Number(row.top_minor_target),
    closingMemberIds: (row.closing_member_ids || []).map(String),
    targetOverrides: row.allocation?.targetOverrides || {},
    manualPerformance: row.allocation?.manualPerformance || {},
    periodId: row.period_id || initialPeriod.periodId,
    completions: row.completions || {},
  });

  const previousPeriodId = () =>
    period.round > 1
      ? `${period.year}-${String(period.month).padStart(2, "0")}-${period.round - 1}`
      : null;

  async function loadPreviousPerformance() {
    previousPerformance = {};
    firstRoundPerformance = {};
    const previousId = previousPeriodId();
    if (!previousId) return;
    let previousRow = null;
    if (storage === "supabase") {
      const { data: row } = await supabase
        .from(PLAN_TABLE)
        .select("allocation")
        .eq("period_id", previousId)
        .eq("top_member_id", plan.topMemberId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      previousRow = row;
    } else {
      previousRow = readJson(`${LOCAL_PLAN_KEY}:${previousId}`, null);
    }
    previousPerformance =
      previousRow?.allocation?.currentPerformance ||
      previousRow?._lastRun?.allocation?.currentPerformance ||
      {};
    if (period.round === 2) {
      firstRoundPerformance = previousPerformance;
    } else if (period.round > 2) {
      const firstId = `${period.year}-${String(period.month).padStart(2, "0")}-1`;
      let firstRow = null;
      if (storage === "supabase") {
        const { data: row } = await supabase
          .from(PLAN_TABLE)
          .select("allocation")
          .eq("period_id", firstId)
          .eq("top_member_id", plan.topMemberId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        firstRow = row;
      } else {
        firstRow = readJson(`${LOCAL_PLAN_KEY}:${firstId}`, null);
      }
      firstRoundPerformance =
        firstRow?.allocation?.currentPerformance ||
        firstRow?._lastRun?.allocation?.currentPerformance ||
        {};
    }
  }

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
        period_id: period.periodId,
        period_year: period.year,
        period_month: period.month,
        closing_round: period.round,
        top_member_id: plan.topMemberId,
        top_major_target: plan.topMajorTarget,
        top_minor_target: plan.topMinorTarget,
        closing_member_ids: plan.closingMemberIds,
        completions: plan.completions,
        allocation: lastRun?.allocation
          ? { ...lastRun.allocation, targetOverrides: plan.targetOverrides, manualPerformance: plan.manualPerformance }
          : Object.keys(plan.targetOverrides || {}).length
            ? { targetOverrides: plan.targetOverrides, manualPerformance: plan.manualPerformance }
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
        .upsert(row, { onConflict: "owner_id,period_id,top_member_id" });
      if (!saveError) {
        renderStorageNote();
        return true;
      }
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        saveError.message,
      )
        ? "Supabase에서 RUN_013_PERFORMANCE_PERIODS.sql을 실행하세요. 기존 데이터는 삭제하지 않았습니다."
        : `Supabase 저장 실패: ${saveError.message} (기존 데이터는 그대로 남아 있습니다)`;
    }
    try {
      localStorage.setItem(
        `${LOCAL_PLAN_KEY}:${period.periodId}`,
        JSON.stringify({ ...plan, _lastRun: lastRun }),
      );
    } catch {}
    renderStorageNote();
    return false;
  }

  if (storage === "supabase") {
    const { data: planRow, error: planError } = await supabase
      .from(PLAN_TABLE)
      .select("*")
      .eq("period_id", initialPeriod.periodId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (planError) {
      storage = "local";
      storageNote = /does not exist|schema cache|relation/i.test(
        planError.message,
      )
        ? "Supabase에서 RUN_013_PERFORMANCE_PERIODS.sql을 실행하면 차수별로 저장됩니다."
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
      (storage === "local" &&
        (readJson(`${LOCAL_PLAN_KEY}:${initialPeriod.periodId}`, null) ||
          readJson(LOCAL_PLAN_KEY, null))) ||
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
  plan.periodId ||= initialPeriod.periodId;
  plan.manualPerformance ||= {};
  await loadPreviousPerformance();
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
    $("firstRoundTop").hidden = period.round !== 1;
    const topCollected = collectedPerformance.get(plan.topMemberId) || {};
    const topManual = plan.manualPerformance[plan.topMemberId] || {};
    $("topCurrentMajor").value = topManual.majorNv ?? topCollected.majorNv ?? 0;
    $("topCurrentMinor").value = topManual.minorNv ?? topCollected.minorNv ?? 0;
    const availableAt = new Date(`${period.endDate}T00:00:00`);
    availableAt.setDate(availableAt.getDate() + 1);
    const collectedAt = new Date(data.collected_at);
    const sourceState =
      period.round === 1
        ? "1차는 현재 실적을 직접 입력합니다."
        : collectedAt >= availableAt
          ? "마감일 다음 날 이후 수집 자료를 자동으로 불러왔습니다."
          : `${period.endDate} 마감 다음 날 수집 자료가 아직 없어 최신 자료를 미리보기로 표시합니다.`;
    $("perfPeriod").textContent = `${period.year}년 ${period.month}월 ${period.round}차 · ${period.startDate} ~ ${period.endDate} · ${sourceState}`;
    renderClosers();
  };

  const collapsedCloserBranches = new Set();
  const renderClosers = () => {
    const top = model.byId.get(String(plan.topMemberId));
    const container = $("closingOptions");
    container.classList.add("closing-genealogy-picker");
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
    if (!top) {
      container.innerHTML = '<p class="help">표시할 계보가 없습니다.</p>';
      return;
    }
    const nodeHtml = (row, level, path) => {
      const id = String(row.userId);
      if (path.has(id) || level >= 10) return "";
      const nextPath = new Set(path);
      nextPath.add(id);
      const isTop = id === String(plan.topMemberId);
      const children = (model.children.get(id) || []).filter(
        (child) => !nextPath.has(String(child.userId)),
      );
      const hasChildren = level < 9 && children.length > 0;
      const collapsed = collapsedCloserBranches.has(id);
      const checked = isTop || plan.closingMemberIds.includes(id);
      const targets = plan.targetOverrides[id] || {};
      const collected = collectedPerformance.get(id) || {};
      const manual = plan.manualPerformance[id] || {};
      const actualInputs =
        !isTop && period.round === 1
          ? `<label>1차 현재 대실적<input data-member-current-major="${safe(id)}" type="number" min="0" step="1" value="${manual.majorNv ?? collected.majorNv ?? 0}"></label><label>1차 현재 소실적<input data-member-current-minor="${safe(id)}" type="number" min="0" step="1" value="${manual.minorNv ?? collected.minorNv ?? 0}"></label>`
          : "";
      const targetInputs = isTop
        ? ""
        : `<div class="closing-member-targets" ${checked ? "" : "hidden"}><label>대 목표 NV<input data-member-major="${safe(id)}" type="number" min="1" step="1000" value="${targets.majorTarget ?? ""}" placeholder="직접 입력"></label><label>소 목표 NV<input data-member-minor="${safe(id)}" type="number" min="1" step="1000" value="${targets.minorTarget ?? ""}" placeholder="직접 입력"></label>${actualInputs}</div>`;
      const toggle = hasChildren
        ? `<button class="closing-tree-toggle" data-closing-tree-toggle="${safe(id)}" type="button" aria-label="${collapsed ? "하위 계보 펼치기" : "하위 계보 접기"}">${collapsed ? "+" : "−"}</button>`
        : '<span class="closing-tree-spacer"></span>';
      const checkbox = isTop
        ? '<input type="checkbox" checked disabled>'
        : `<input data-closing-enabled type="checkbox" value="${safe(id)}" ${checked ? "checked" : ""}>`;
      const childrenHtml = hasChildren
        ? `<div class="closing-tree-children" data-closing-tree-children="${safe(id)}" ${collapsed ? "hidden" : ""}>${children.map((child) => nodeHtml(child, level + 1, nextPath)).join("")}</div>`
        : "";
      return `<div class="closing-selector-node" style="--closing-depth:${level}"><div class="closing-selector-row">${toggle}<article class="closing-member-setting"><label class="check">${checkbox}<span>${safe(row.userName)} <small>(${safe(id)}) · ${safe(row.rankName || "회원")}${isTop ? " · 최상위" : ""}</small></span></label>${targetInputs}</article></div>${childrenHtml}</div>`;
    };
    container.innerHTML = nodeHtml(top, 0, new Set());
  };

  const renderManualLinks = () => {
    $("perfLinkList").innerHTML = manualLinks.length
      ? manualLinks
          .map(
            (link) =>
              `<span>${safe(link.member_name || link.member_id)} (${safe(link.member_id)}) → 상위 ${safe(link.parent_id)} <button type="button" data-remove-perf-link="${safe(link.id)}">×</button></span>`,
          )
          .join("")
      : '<small class="help">수동으로 연결한 계보가 없습니다.</small>';
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
    const downstreamItem = subMember
      ? items.find((candidate) => candidate.node.memberId === String(subMember.userId))
      : null;
    const downstreamCompletion =
      downstreamItem?.completion || downstreamItem?.projection || null;
    const balanced =
      deficit > 0 && Number(downstreamCompletion?.completedNv || 0) > 0
        ? planBalancedClosingTopUp(
            model,
            subMember.userId,
            deficit,
            downstreamCompletion,
          )
        : null;
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
      role = "현재 조직실적 · 비마감 중간 회원은 별도 목표 없이 그대로 전달";
    }
    const ownNote =
      index === result.ownContributionIndex && result.minorOwnContribution > 0
        ? `<small>본인 매출 ${fmt(result.minorOwnContribution)} NV가 이 라인에 합산됩니다.</small>`
        : index === result.inheritedOwnIndex && result.inheritedOwnNv > 0
          ? `<small>상위 ${safe(model.byId.get(result.inheritedOwnFromMemberId)?.userName || "")} 본인매출 ${fmt(result.inheritedOwnNv)} NV가 이 작은 라인에 합산됩니다.</small>`
          : result.transferredOwnNv > 0 && index === result.ownContributionIndex
            ? `<small>본인매출 ${fmt(result.transferredOwnNv)} NV는 아래 마감자의 작은 라인으로 전달되어 여기서는 중복 합산하지 않습니다.</small>`
            : "";
    const balancedSaleLine = balanced
      ? `<span class="sale-hint"><b>${safe(subMember.userName)} ${isMajor ? "대실적" : "소실적"} 라인 ${fmt(deficit)} NV 부족</b></span><span class="sale-hint">균형 목표 · 대실적 ${fmt(balanced.balancedTargetNv)} / 소실적 ${fmt(balanced.balancedTargetNv)} NV</span><small>현재 ${safe(subMember.userName)} 실적 · 대 ${fmt(balanced.currentMajorNv)} / 소 ${fmt(balanced.currentMinorNv)}</small>${balanced.projection.topUps
          .map((nestedTopUp, nestedIndex) => {
            if (nestedTopUp.salesWon <= 0) return "";
            const nestedPlacement = balanced.result.placements[nestedIndex];
            const side =
              nestedIndex === balanced.result.majorIndex ? "대실적" : "소실적";
            return `<span class="sale-hint">${side} ${fmt(balanced.result.deficits[nestedIndex])} NV 부족 → ${safe(nestedPlacement.target?.userName || "-")} (${safe(nestedPlacement.target?.userId || "-")})에 <b>${fmt(nestedTopUp.salesWon)}원</b> 입력 (+${fmt(nestedTopUp.addedNv)} NV)</span>`;
          })
          .join("")}<small>표시된 금액을 실제 매출에 입력한 뒤 다시 수집해 주세요.</small>`
      : "";
    const saleLine =
      balancedSaleLine ||
      (topUp.salesWon > 0
        ? `<span class="sale-hint">매출 넣을 곳: ${safe(placement.target?.userName || "-")} (${safe(placement.target?.userId || "-")}) · ${fmt(topUp.salesWon)}원 → +${fmt(topUp.addedNv)} NV</span>`
        : deficit > 0
          ? `<span class="sale-hint">${isMajor ? "대실적" : "소실적"} 라인 ${fmt(deficit)} NV 부족 · 매출을 넣을 수 있는 하위 코드를 확인하세요.</span>`
          : `<span>추가 매출이 필요 없습니다.</span>`);
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
      depth: 10,
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
    const targetBox = `<p class="help">사용자 입력 목표 · 대 ${fmt(node.majorTarget)} / 소 ${fmt(node.minorTarget)}${completion ? " · 마감을 취소해야 변경할 수 있습니다" : ""}</p>`;
    return `<section class="card closing-step"><div class="section-head"><h2>${title}</h2><b>${state}</b></div>${targetBox}<div class="closing-lines">${lineHtml(item, 0)}${lineHtml(item, 1)}</div>${treeHtml(item)}${final}${warn}${button}</section>`;
  };

  const runPlan = () => {
    $("perfError").textContent = "";
    plan.topMemberId = $("topMemberSelect").value;
    plan.topMajorTarget = Number($("topMajor").value);
    plan.topMinorTarget = Number($("topMinor").value);
    plan.closingMemberIds = [
      ...$("closingOptions").querySelectorAll("[data-closing-enabled]:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    plan.targetOverrides = Object.fromEntries(
      plan.closingMemberIds
        .filter((id) => id !== plan.topMemberId)
        .map((id) => {
          const major = Number(
            $("closingOptions").querySelector(`[data-member-major="${CSS.escape(id)}"]`)?.value,
          );
          const minor = Number(
            $("closingOptions").querySelector(`[data-member-minor="${CSS.escape(id)}"]`)?.value,
          );
          return [id, { majorTarget: major, minorTarget: minor }];
        }),
    );
    if (period.round === 1) {
      plan.manualPerformance = Object.fromEntries(
        plan.closingMemberIds.map((id) => {
          if (id === plan.topMemberId) {
            return [
              id,
              {
                majorNv: Number($("topCurrentMajor").value || 0),
                minorNv: Number($("topCurrentMinor").value || 0),
              },
            ];
          }
          return [
            id,
            {
              majorNv: Number(
                $("closingOptions").querySelector(
                  `[data-member-current-major="${CSS.escape(id)}"]`,
                )?.value || 0,
              ),
              minorNv: Number(
                $("closingOptions").querySelector(
                  `[data-member-current-minor="${CSS.escape(id)}"]`,
                )?.value || 0,
              ),
            },
          ];
        }),
      );
    } else {
      plan.manualPerformance = {};
    }
    model.rows.forEach((row) => {
      const id = String(row.userId);
      const collected = collectedPerformance.get(id) || {};
      row.maxPv = Number(collected.majorNv || 0);
      row.minPv = Number(collected.minorNv || 0);
      const manual = plan.manualPerformance[id];
      if (manual) {
        row.maxPv = Number(manual.majorNv || 0);
        row.minPv = Number(manual.minorNv || 0);
      }
    });
    lastSignature = planSignature(
      plan.topMemberId,
      { majorTarget: plan.topMajorTarget, minorTarget: plan.topMinorTarget },
      plan.closingMemberIds,
      plan.targetOverrides,
      plan.manualPerformance,
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
      const depthFromTop = (row) => {
        let depth = 0;
        let current = row;
        const visited = new Set();
        while (
          current &&
          String(current.userId) !== plan.topMemberId &&
          !visited.has(String(current.userId))
        ) {
          visited.add(String(current.userId));
          current = model.byId.get(String(current.ppId || ""));
          depth += 1;
        }
        return depth;
      };
      const nodes = sortMembersDeepestFirst(model, plan.closingMemberIds).map(
        (row) => {
          const id = String(row.userId);
          const targets =
            id === plan.topMemberId
              ? {
                  majorTarget: plan.topMajorTarget,
                  minorTarget: plan.topMinorTarget,
                }
              : plan.targetOverrides[id];
          if (
            !targets ||
            !Number.isFinite(targets.majorTarget) ||
            !Number.isFinite(targets.minorTarget) ||
            targets.majorTarget <= 0 ||
            targets.minorTarget <= 0
          ) {
            throw new Error(`${row.userName || id}의 대·소목표를 모두 직접 입력하세요.`);
          }
          return {
            memberId: id,
            depth: depthFromTop(row),
            majorTarget: targets.majorTarget,
            minorTarget: targets.minorTarget,
            lines: [{}, {}],
          };
        },
      );
      const selectedCloserIds = new Set(nodes.map((node) => node.memberId));
      const inheritedOwnNv = new Map();
      const transferredOwnIds = new Set();
      const nearestSelectedCloser = (start) => {
        const queue = start ? [start] : [];
        const visited = new Set();
        while (queue.length) {
          const row = queue.shift();
          const id = String(row.userId);
          if (visited.has(id)) continue;
          visited.add(id);
          if (selectedCloserIds.has(id)) return id;
          (model.children.get(id) || []).forEach((child) => queue.push(child));
        }
        return null;
      };
      nodes.forEach((node) => {
        const row = model.byId.get(node.memberId);
        const ownNv = Math.max(0, Number(row?.ordPv || 0));
        if (ownNv <= 0) return;
        const base = calculatePerformance(model, node.memberId, {
          majorTarget: node.majorTarget,
          minorTarget: node.minorTarget,
        });
        const receivingCloserId = nearestSelectedCloser(
          base.subMembers[base.ownContributionIndex],
        );
        if (!receivingCloserId || receivingCloserId === node.memberId) return;
        inheritedOwnNv.set(receivingCloserId, {
          amount: Number(inheritedOwnNv.get(receivingCloserId)?.amount || 0) + ownNv,
          fromMemberId: node.memberId,
        });
        transferredOwnIds.add(node.memberId);
      });
      const resetCalculated = () =>
        model.rows.forEach((row) => {
          delete row.completedClosingMajorNv;
          delete row.completedClosingMinorNv;
          delete row.completedClosingNv;
          delete row.completedClosingPreviousTotal;
          delete row.closingDescendantDeltaNv;
        });
      const calculateNode = (node) => {
        let result = calculatePerformance(model, node.memberId, {
          majorTarget: node.majorTarget,
          minorTarget: node.minorTarget,
        });
        const manual = period.round === 1
          ? plan.manualPerformance[node.memberId]
          : null;
        if (manual) {
          const ownNv = Math.max(
            0,
            Number(model.byId.get(node.memberId)?.ordPv || 0),
          );
          const rawMajor = Number(manual.majorNv || 0);
          const rawMinorWithOwn = Number(manual.minorNv || 0) + ownNv;
          result.effectiveTotals[result.majorIndex] = Math.max(
            rawMajor,
            rawMinorWithOwn,
          );
          result.effectiveTotals[result.minorIndex] = Math.min(
            rawMajor,
            rawMinorWithOwn,
          );
          result.deficits = result.effectiveTotals.map((total, index) =>
            Math.max(0, result.branchTargets[index] - total),
          );
          result.achieved = result.deficits.every((deficit) => deficit === 0);
          result.priority = result.achieved
            ? null
            : result.deficits[0] >= result.deficits[1]
              ? 0
              : 1;
        }
        const inherited = inheritedOwnNv.get(node.memberId);
        result = applyOwnSalesFlow(
          result,
          { majorTarget: node.majorTarget, minorTarget: node.minorTarget },
          {
            inheritedOwnNv: inherited?.amount || 0,
            suppressOwn: transferredOwnIds.has(node.memberId),
          },
        );
        if (inherited?.amount > 0) {
          result.inheritedOwnFromMemberId = inherited.fromMemberId;
        }
        return result;
      };
      const actualResults = new Map();
      nodes.forEach((node) => {
        const result = calculateNode(node);
        actualResults.set(node.memberId, result);
        const completion = plan.completions[node.memberId] || null;
        if (completion) applyClosingCompletion(model, node.memberId, completion);
      });
      resetCalculated();
      items = nodes.map((node) => {
        const result = calculateNode(node);
        node.lines = result.branchTargets.map((lineTarget, index) => ({
          index,
          lineTarget,
          childAllocation: null,
        }));
        const projection = projectClosingCompletion(result);
        const completion = plan.completions[node.memberId] || null;
        if (completion) {
          applyClosingCompletion(model, node.memberId, completion);
        } else if (projection.feasible !== false) {
          applyClosingCompletion(model, node.memberId, projection);
        }
        return {
          node,
          result,
          actualResult: actualResults.get(node.memberId),
          projection,
          completion,
        };
      });
      const nextIndex = items.findIndex(
        (item) => !item.completion && !item.skipped,
      );
      items.forEach((item, index) => {
        item.canComplete = index === nextIndex;
      });
      const topItem = items.find(
        (item) => item.node.memberId === plan.topMemberId,
      );
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
      const actualTop = topItem.actualResult;
      const currentMajorNv = topItem.completion
        ? Number(topItem.completion.majorNv)
        : Number(actualTop?.effectiveTotals?.[actualTop.majorIndex] || 0);
      const currentMinorNv = topItem.completion
        ? Number(topItem.completion.minorNv)
        : Number(actualTop?.effectiveTotals?.[actualTop.minorIndex] || 0);
      const currentAchieved =
        currentMajorNv >= plan.topMajorTarget &&
        currentMinorNv >= plan.topMinorTarget;
      if (currentAchieved && !topItem.completion) {
        const automaticCompletion = completionWhenAchieved(
          actualTop,
          lastSignature,
        );
        if (automaticCompletion) {
          plan.completions[plan.topMemberId] = automaticCompletion;
          topItem.completion = automaticCompletion;
          $("perfNotice").textContent =
            "하위 마감 완료 NV가 목표를 채워 최상위 사업자도 자동으로 마감 완료되었습니다.";
          queueMicrotask(() => persistPlan());
        }
      }
      lastRun = {
        allocation: {
          mode: "explicit",
          periodId: period.periodId,
          targetOverrides: plan.targetOverrides,
          currentPerformance: Object.fromEntries(
            items.map((item) => {
              const current = item.actualResult;
              return [
                item.node.memberId,
                {
                  majorNv: Number(
                    current?.effectiveTotals?.[current.majorIndex] || 0,
                  ),
                  minorNv: Number(
                    current?.effectiveTotals?.[current.minorIndex] || 0,
                  ),
                },
              ];
            }),
          ),
        },
        placements,
        topMajorNv,
        topMinorNv,
        topCompletedNv: topMajorNv + topMinorNv,
        currentMajorNv,
        currentMinorNv,
        currentAchieved,
        verified,
      };
      const topMember = model.byId.get(plan.topMemberId);
      const previous = previousPerformance[plan.topMemberId] || {
        majorNv: 0,
        minorNv: 0,
      };
      const rankOrder = ["회원", "DT", "GD", "RD", "ED", "DD", "SDD", "CDD", "PM", "IM"];
      const certifiedRank = String(
        topMember?.rankMaxName || topMember?.rankName || "회원",
      ).toUpperCase();
      const requiredIndex = Math.max(0, rankOrder.indexOf(certifiedRank));
      const direct = model.children.get(plan.topMemberId) || [];
      const qualifiedCount = (rootRow) => {
        if (!rootRow) return 0;
        const stack = [rootRow];
        const visited = new Set();
        let count = 0;
        while (stack.length) {
          const row = stack.pop();
          const id = String(row.userId);
          if (visited.has(id)) continue;
          visited.add(id);
          const rank = String(row.rankMaxName || row.rankName || "회원").toUpperCase();
          if (rankOrder.indexOf(rank) >= requiredIndex) count += 1;
          (model.children.get(id) || []).forEach((child) => stack.push(child));
        }
        return count;
      };
      const promotionMetrics = {
        firstRoundDtGroupNv:
          period.round === 1
            ? currentMajorNv + currentMinorNv
            : Number(firstRoundPerformance[plan.topMemberId]?.majorNv || 0) +
              Number(firstRoundPerformance[plan.topMemberId]?.minorNv || 0),
        round: period.round,
        previousMinorNv: previous.minorNv,
        currentMinorNv,
        gdEligible: rankOrder.indexOf(certifiedRank) >= rankOrder.indexOf("GD"),
        leftQualifiedCount: qualifiedCount(direct[0]),
        rightQualifiedCount: qualifiedCount(direct[1]),
      };
      const promotion =
        rankOrder.indexOf(certifiedRank) < rankOrder.indexOf("RD")
          ? evaluatePromotionPath(certifiedRank, promotionMetrics)
          : evaluatePromotion(certifiedRank, promotionMetrics);
      const promotionText =
        promotion.targetRank === "IM" && certifiedRank === "IM"
          ? "최고 직급"
          : rankOrder.indexOf(certifiedRank) < rankOrder.indexOf("GD")
            ? `${rankOrder[rankOrder.indexOf(certifiedRank) + 1]} 승급 · DT그룹 1차 매출 자료 확인 필요`
          : `${promotion.achieved ? promotion.achievedRank || promotion.targetRank : promotion.targetRank} 승급 ${promotion.achieved ? "가능" : "미달"} · ${promotion.reason}`;
      $("perfSummary").innerHTML =
        `<section class="recommend-card"><span>${period.year}년 ${period.month}월 ${period.round}차 · ${safe(topMember?.userName || "")} 기준</span><h2>현재 ${currentAchieved ? "마감 완료" : "마감 미달"} · 대 ${fmt(currentMajorNv)} / 소 ${fmt(currentMinorNv)}</h2><p>목표 대 ${fmt(plan.topMajorTarget)} / 소 ${fmt(plan.topMinorTarget)}</p><div class="period-performance"><span></span><b>전차수</b><b>현차수</b><b>합산</b><strong>대실적</strong><span>${fmt(previous.majorNv)}</span><span>${fmt(currentMajorNv)}</span><span>${fmt(Number(previous.majorNv || 0) + currentMajorNv)}</span><strong>소실적</strong><span>${fmt(previous.minorNv)}</span><span>${fmt(currentMinorNv)}</span><span>${fmt(Number(previous.minorNv || 0) + currentMinorNv)}</span></div><p class="promotion-status"><b>직급 승급 확인</b> · ${safe(promotionText)}</p><h3>추천 매출 합계 ${fmt(totalSalesWon)}원</h3><p>아직 넣지 않은 매출 ${fmt(remainingSalesWon)}원 · 매출 1,000원 = 810 NV · 최소 10,000원부터</p><p>추천 매출 반영 예상 · 대 ${fmt(topMajorNv)} / 소 ${fmt(topMinorNv)}</p><p><b>${verified ? "✅ 추천대로 진행하면 목표 달성 예상" : "⚠️ 추천 후에도 목표 미달 예상"}</b></p></section>`;
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
      ...$("closingOptions").querySelectorAll("[data-closing-enabled]:checked"),
    ].map((input) => input.value);
    if (!plan.closingMemberIds.includes(plan.topMemberId)) {
      plan.closingMemberIds.push(plan.topMemberId);
    }
    $("closingCount").textContent =
      `${plan.closingMemberIds.filter((id) => id !== plan.topMemberId).length}명`;
    $("closingOptions")
      .querySelectorAll(".closing-member-setting")
      .forEach((setting) => {
        const checkbox = setting.querySelector("[data-closing-enabled]");
        const targets = setting.querySelector(".closing-member-targets");
        if (checkbox && targets) targets.hidden = !checkbox.checked;
      });
  };
  $("closingOptions").onclick = (event) => {
    const toggle = event.target.closest("[data-closing-tree-toggle]");
    if (!toggle) return;
    const id = toggle.dataset.closingTreeToggle;
    const children = $("closingOptions").querySelector(
      `[data-closing-tree-children="${CSS.escape(id)}"]`,
    );
    if (!children) return;
    children.hidden = !children.hidden;
    toggle.textContent = children.hidden ? "+" : "−";
    toggle.setAttribute(
      "aria-label",
      children.hidden ? "하위 계보 펼치기" : "하위 계보 접기",
    );
    if (children.hidden) collapsedCloserBranches.add(id);
    else collapsedCloserBranches.delete(id);
  };
  $("perfManualLinkForm").onsubmit = async (event) => {
    event.preventDefault();
    const parentId = $("perfLinkParent").value.trim();
    const childId = $("perfLinkChild").value.trim();
    const childName = $("perfLinkName").value.trim();
    $("perfLinkError").textContent = "";
    if (!ownerId) {
      $("perfLinkError").textContent = "로그인 후 수동 계보를 저장할 수 있습니다.";
      return;
    }
    if (result.inheritedOwnNv > 0 && result.inheritedOwnIndex != null) {
      const receiving = result.subMembers[result.inheritedOwnIndex];
      if (receiving) {
        const fromName =
          model.byId.get(result.inheritedOwnFromMemberId)?.userName || "상위";
        notes[String(receiving.userId)] =
          `${fromName} 본인매출 ${fmt(result.inheritedOwnNv)} NV 합산 · 합산 후 대·소실적 재비교`;
      }
    }
    if (!model.byId.has(parentId)) {
      $("perfLinkError").textContent = "현재 계보에서 상위 회원번호를 찾지 못했습니다.";
      return;
    }
    if (!childId || childId === parentId) {
      $("perfLinkError").textContent = "서로 다른 상위·하위 회원번호를 입력하세요.";
      return;
    }
    let cursor = model.byId.get(parentId);
    const visited = new Set();
    while (cursor && !visited.has(String(cursor.userId))) {
      const id = String(cursor.userId);
      if (id === childId) {
        $("perfLinkError").textContent = "순환되는 계보는 연결할 수 없습니다.";
        return;
      }
      visited.add(id);
      cursor = model.byId.get(String(cursor.ppId || ""));
    }
    const source =
      snapshotModels.find(({ model: sourceModel }) =>
        sourceModel.byId.has(childId),
      )?.model || (model.byId.has(childId) ? model : null);
    if (!source) {
      $("perfLinkError").textContent =
        "하위 사업자의 수집자료를 찾지 못했습니다. 해당 계정에서 먼저 매출받기를 실행하세요.";
      return;
    }
    const child = source.byId.get(childId);
    const { error: linkError } = await addManualLink(ownerId, {
      memberId: childId,
      memberName: childName || child?.userName || childId,
      parentId,
      note: "실적 탭 수동 연결",
    });
    if (linkError && !/duplicate|unique/i.test(linkError.message || "")) {
      $("perfLinkError").textContent =
        linkError.message || "수동 계보를 저장하지 못했습니다.";
      return;
    }
    attachPerformanceSubtree(model, source, childId, parentId);
    manualLinks = await loadManualLinks(ownerId);
    renderManualLinks();
    renderControls();
    runPlan();
    $("perfLinkError").textContent =
      "계보를 연결했습니다. 같은 회원번호는 한 번만 계산됩니다.";
  };
  $("perfLinkList").onclick = async (event) => {
    const button = event.target.closest("[data-remove-perf-link]");
    if (!button) return;
    const { error: removeError } = await removeManualLink(
      button.dataset.removePerfLink,
    );
    if (removeError) {
      $("perfLinkError").textContent = removeError.message;
      return;
    }
    await performancePage(root);
  };
  $("perfDate").onchange = async () => {
    period = closingPeriodForDate($("perfDate").value);
    if (period.round > 1) {
      const availableAt = new Date(`${period.endDate}T00:00:00`);
      availableAt.setDate(availableAt.getDate() + 1);
      const { data: periodSnapshot } = await supabase
        .from("nrc_sync_snapshots")
        .select("payload,collected_at,source_account_id")
        .eq("snapshot_type", "combined")
        .gte("collected_at", availableAt.toISOString())
        .order("collected_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (periodSnapshot) {
        data = periodSnapshot;
        const payload =
          typeof data.payload === "string"
            ? JSON.parse(data.payload)
            : data.payload;
        model = buildPerformanceModel(payload);
        collectedPerformance = new Map(
          model.rows.map((row) => [
            String(row.userId),
            {
              majorNv: Number(row.maxPv || 0),
              minorNv: Number(row.minPv || 0),
            },
          ]),
        );
        $("perfSource").textContent =
          `수집 ${new Date(data.collected_at).toLocaleString("ko-KR")} · ${period.round}차 마감 다음 날 이후 첫 자료`;
      }
    }
    let loaded = null;
    if (storage === "supabase") {
      const { data: row } = await supabase
        .from(PLAN_TABLE)
        .select("*")
        .eq("period_id", period.periodId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (row) loaded = rowToPlan(row);
    } else {
      loaded = readJson(`${LOCAL_PLAN_KEY}:${period.periodId}`, null);
    }
    plan = loaded || defaultPlan();
    plan.periodId = period.periodId;
    plan.targetOverrides ||= {};
    plan.manualPerformance ||= {};
    plan.completions ||= {};
    if (!model.byId.has(String(plan.topMemberId))) plan = defaultPlan();
    await loadPreviousPerformance();
    renderControls();
    runPlan();
  };
  $("perfRun").onclick = async () => {
    runPlan();
    await persistPlan();
  };
  $("perfResult").addEventListener("toggle", fitTrees, true);
  window.addEventListener("resize", fitTrees);
  $("perfResult").onclick = async (event) => {
    const completeButton = event.target.closest("[data-complete-closing]");
    const cancelButton = event.target.closest("[data-cancel-closing]");
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

  renderManualLinks();
  renderControls();
  runPlan();
}
