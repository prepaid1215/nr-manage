const numeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const memberId = (row) => String(row?.userId ?? "");

const normalizeTargets = (requestedTargets) => {
  const sameTarget =
    typeof requestedTargets === "object" ? null : numeric(requestedTargets);
  return {
    majorTarget: numeric(requestedTargets?.majorTarget ?? sameTarget),
    minorTarget: numeric(requestedTargets?.minorTarget ?? sameTarget),
  };
};

const comparePosition = (left, right) => {
  const leftPosition = numeric(left?.abPos) || Number.MAX_SAFE_INTEGER;
  const rightPosition = numeric(right?.abPos) || Number.MAX_SAFE_INTEGER;
  return (
    leftPosition - rightPosition ||
    memberId(left).localeCompare(memberId(right))
  );
};

export function branchBreakdown(row) {
  const own = numeric(row?.ordPv);
  const major = numeric(row?.maxPv);
  const minor = numeric(row?.minPv);
  const completedTotal = numeric(row?.completedClosingNv);
  const descendantDelta = numeric(row?.closingDescendantDeltaNv);
  return {
    own,
    major,
    minor,
    total:
      completedTotal > 0
        ? completedTotal
        : own + major + minor + descendantDelta,
    completed: completedTotal > 0,
  };
}

export function salesTopUpForDeficit(deficitNv) {
  const deficit = Math.max(0, numeric(deficitNv));
  if (deficit === 0) return { salesWon: 0, addedNv: 0, excessNv: 0 };
  const thousandWonUnits = Math.max(10, Math.ceil(deficit / 810));
  const addedNv = thousandWonUnits * 810;
  return {
    salesWon: thousandWonUnits * 1000,
    addedNv,
    excessNv: addedNv - deficit,
  };
}

export function closingPeriodForDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error("올바른 마감 기준일이 아닙니다.");
  const day = date.getDate();
  const round = day <= 8 ? 1 : day <= 15 ? 2 : day <= 23 ? 3 : 4;
  const startDay = [0, 1, 9, 16, 24][round];
  const endDay = round === 4 ? new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() : [0, 8, 15, 23][round];
  const pad = (number) => String(number).padStart(2, "0");
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  return {
    periodId: `${year}-${pad(month)}-${round}`,
    year,
    month,
    round,
    startDate: `${year}-${pad(month)}-${pad(startDay)}`,
    endDate: `${year}-${pad(month)}-${pad(endDay)}`,
  };
}

export function normalizeClosingConfigs(configs) {
  return Object.fromEntries(
    Object.entries(configs || {})
      .filter(([, config]) => config?.closingEnabled)
      .map(([id, config]) => [String(id), {
        closingEnabled: true,
        majorTargetNv: Math.max(0, numeric(config.majorTargetNv)),
        minorTargetNv: Math.max(0, numeric(config.minorTargetNv)),
      }]),
  );
}

const PROMOTION_ORDER = ["회원", "DT", "GD", "RD", "ED", "DD", "SDD", "CDD", "PM", "IM"];

export function evaluatePromotion(currentRankName, metrics = {}) {
  const normalized = String(currentRankName || "회원").toUpperCase();
  const currentIndex = Math.max(0, PROMOTION_ORDER.indexOf(normalized));
  const targetRank = PROMOTION_ORDER[Math.min(currentIndex + 1, PROMOTION_ORDER.length - 1)];
  if (normalized === "IM") {
    return { currentRank: "IM", targetRank: "IM", achieved: true, reason: "최고 직급" };
  }
  if (targetRank === "DT" || targetRank === "GD") {
    const requiredNv = targetRank === "DT" ? 400000 : 1000000;
    const actualNv = numeric(metrics.firstRoundDtGroupNv);
    return {
      currentRank: normalized,
      targetRank,
      achieved: actualNv >= requiredNv,
      requiredNv,
      actualNv,
      reason: "본인 DT그룹 1차 매출",
    };
  }
  if (targetRank === "RD") {
    const actualNv =
      numeric(metrics.round) === 1
        ? numeric(metrics.currentMinorNv)
        : numeric(metrics.previousMinorNv) + numeric(metrics.currentMinorNv);
    const gdEligible = metrics.gdEligible !== false;
    return {
      currentRank: normalized,
      targetRank,
      achieved: gdEligible && actualNv >= 3000000,
      requiredNv: 3000000,
      actualNv,
      reason: "GD 조건 충족 + 1차 또는 1·2차 합산 소실적",
    };
  }
  const requiredDownlineRank = PROMOTION_ORDER[currentIndex];
  const leftCount = Math.max(0, numeric(metrics.leftQualifiedCount));
  const rightCount = Math.max(0, numeric(metrics.rightQualifiedCount));
  return {
    currentRank: normalized,
    targetRank,
    achieved: leftCount >= 2 && rightCount >= 2,
    requiredDownlineRank,
    leftCount,
    rightCount,
    reason: `좌우 각 2명의 ${requiredDownlineRank}`,
  };
}

export function evaluatePromotionPath(currentRankName, metrics = {}) {
  const normalized = String(currentRankName || "회원").toUpperCase();
  const currentIndex = Math.max(0, PROMOTION_ORDER.indexOf(normalized));
  const rdIndex = PROMOTION_ORDER.indexOf("RD");
  if (currentIndex >= rdIndex) return evaluatePromotion(normalized, metrics);
  const firstRoundNv = numeric(metrics.firstRoundDtGroupNv);
  const combinedMinorNv =
    numeric(metrics.round) === 1
      ? numeric(metrics.currentMinorNv)
      : numeric(metrics.previousMinorNv) + numeric(metrics.currentMinorNv);
  let achievedIndex = currentIndex;
  if (firstRoundNv >= 400000) achievedIndex = Math.max(achievedIndex, 1);
  if (firstRoundNv >= 1000000) achievedIndex = Math.max(achievedIndex, 2);
  if (achievedIndex >= 2 && combinedMinorNv >= 3000000) {
    achievedIndex = rdIndex;
  }
  const achievedRank = PROMOTION_ORDER[achievedIndex];
  return {
    currentRank: normalized,
    targetRank: achievedRank === normalized ? PROMOTION_ORDER[currentIndex + 1] : achievedRank,
    achievedRank,
    achieved: achievedIndex > currentIndex,
    firstRoundDtGroupNv: firstRoundNv,
    combinedMinorNv,
    reason: "RD까지는 같은 차수에 연속 승급 가능",
  };
}

export function planExplicitClosings(model, topMemberId, configs) {
  const topId = String(topMemberId);
  if (!model.byId.has(topId)) throw new Error("기준 사업자를 찾지 못했습니다.");
  const enabled = normalizeClosingConfigs(configs);
  const selectedIds = Object.keys(enabled).filter((id) => model.byId.has(id));
  const ordered = sortMembersDeepestFirst(model, selectedIds);
  const steps = ordered.map((member) => {
    const targets = enabled[memberId(member)];
    if (targets.majorTargetNv <= 0 || targets.minorTargetNv <= 0) {
      throw new Error(`${member.userName || memberId(member)}의 대·소목표를 모두 입력하세요.`);
    }
    const result = calculatePerformance(model, memberId(member), {
      majorTarget: targets.majorTargetNv,
      minorTarget: targets.minorTargetNv,
    });
    const projection = projectClosingCompletion(result);
    if (projection.feasible !== false) applyClosingCompletion(model, memberId(member), projection);
    return {
      memberId: memberId(member),
      targets,
      result,
      projection,
      currentAchieved: result.achieved,
      projectedAchieved: projection.feasible !== false &&
        projection.majorNv >= targets.majorTargetNv &&
        projection.minorNv >= targets.minorTargetNv,
    };
  });
  const topStep = steps.find((step) => step.memberId === topId) || null;
  return {
    steps,
    topStep,
    currentAchieved: Boolean(topStep?.currentAchieved),
    projectedAchieved: Boolean(topStep?.projectedAchieved),
    placements: steps.flatMap((step) =>
      step.projection.topUps.map((topUp, index) => ({
        closerMemberId: step.memberId,
        side: index === step.result.majorIndex ? "major" : "minor",
        placementMemberId: step.result.placements[index].target
          ? memberId(step.result.placements[index].target)
          : null,
        salesWon: topUp.salesWon,
        addedNv: topUp.addedNv,
        excessNv: topUp.excessNv,
      })).filter((placement) => placement.salesWon > 0),
    ),
  };
}

export function projectClosingCompletion(result) {
  if (result.feasible === false) {
    return {
      feasible: false,
      topUps: result.deficits.map(() => ({
        salesWon: 0,
        addedNv: 0,
        excessNv: 0,
      })),
      projectedTotals: [...result.effectiveTotals],
      majorNv: 0,
      minorNv: 0,
      completedNv: 0,
    };
  }
  const topUps = result.deficits.map(salesTopUpForDeficit);
  const projectedTotals = result.effectiveTotals.map(
    (total, index) => total + topUps[index].addedNv,
  );
  const majorNv = projectedTotals[result.majorIndex];
  const minorNv = projectedTotals[result.minorIndex];
  return {
    feasible: true,
    topUps,
    projectedTotals,
    majorNv,
    minorNv,
    completedNv: majorNv + minorNv,
  };
}

export function completionWhenAchieved(
  result,
  signature,
  completedAt = new Date().toISOString(),
) {
  if (!result?.achieved) return null;
  const majorNv = numeric(result.effectiveTotals?.[result.majorIndex]);
  const minorNv = numeric(result.effectiveTotals?.[result.minorIndex]);
  return {
    majorNv,
    minorNv,
    completedNv: majorNv + minorNv,
    completedAt,
    signature,
    automatic: true,
  };
}

export function applyClosingCompletion(model, memberUserId, completion) {
  const row = model.byId.get(String(memberUserId));
  if (!row) throw new Error("마감 완료 사업자를 찾지 못했습니다.");
  const majorNv = numeric(completion?.majorNv);
  const minorNv = numeric(completion?.minorNv);
  if (majorNv < 0 || minorNv < 0 || majorNv + minorNv <= 0) {
    throw new Error("마감 완료 NV가 올바르지 않습니다.");
  }
  const previousTotal = branchBreakdown(row).total;
  const completedTotal = majorNv + minorNv;
  const delta = completedTotal - previousTotal;
  row.completedClosingMajorNv = majorNv;
  row.completedClosingMinorNv = minorNv;
  row.completedClosingNv = completedTotal;
  row.completedClosingPreviousTotal = previousTotal;
  let parent = model.byId.get(String(row.ppId ?? ""));
  const visited = new Set([memberId(row)]);
  while (parent && !visited.has(memberId(parent))) {
    visited.add(memberId(parent));
    parent.closingDescendantDeltaNv =
      numeric(parent.closingDescendantDeltaNv) + delta;
    parent = model.byId.get(String(parent.ppId ?? ""));
  }
  return row;
}

export function planSignature(
  topMemberId,
  requestedTargets,
  closingMemberIds,
  targetOverrides,
  manualPerformance,
) {
  const { majorTarget, minorTarget } = normalizeTargets(requestedTargets);
  const ids = [...new Set((closingMemberIds || []).map(String))].sort();
  const overrides = Object.entries(targetOverrides || {})
    .map(([id, targets]) => [
      String(id),
      numeric(targets?.majorTarget),
      numeric(targets?.minorTarget),
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  const manual = Object.entries(manualPerformance || {})
    .map(([id, values]) => [
      String(id),
      numeric(values?.majorNv),
      numeric(values?.minorNv),
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify([
    String(topMemberId),
    majorTarget,
    minorTarget,
    ids,
    overrides,
    manual,
  ]);
}

export function pruneInvalidCompletions(completions, signature) {
  return Object.fromEntries(
    Object.entries(completions || {}).filter(
      ([, completion]) => completion?.signature === signature,
    ),
  );
}

export function cancelCompletionCascade(model, completions, memberUserId) {
  const next = { ...(completions || {}) };
  const visited = new Set();
  let current = model.byId.get(String(memberUserId));
  while (current && !visited.has(memberId(current))) {
    visited.add(memberId(current));
    delete next[memberId(current)];
    current = model.byId.get(String(current.ppId ?? ""));
  }
  return next;
}

export function cancelClosingCompletion(model, memberUserId) {
  const row = model.byId.get(String(memberUserId));
  if (!row) throw new Error("마감 취소할 사업자를 찾지 못했습니다.");
  const completedTotal = numeric(row.completedClosingNv);
  if (completedTotal <= 0) {
    throw new Error("취소할 마감 완료 기록이 없습니다.");
  }
  const delta = completedTotal - numeric(row.completedClosingPreviousTotal);
  delete row.completedClosingMajorNv;
  delete row.completedClosingMinorNv;
  delete row.completedClosingNv;
  delete row.completedClosingPreviousTotal;
  let parent = model.byId.get(String(row.ppId ?? ""));
  const visited = new Set([memberId(row)]);
  while (parent && !visited.has(memberId(parent))) {
    visited.add(memberId(parent));
    parent.closingDescendantDeltaNv =
      numeric(parent.closingDescendantDeltaNv) - delta;
    parent = model.byId.get(String(parent.ppId ?? ""));
  }
  return row;
}

export function buildPerformanceModel(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("수집 JSON 형식이 올바르지 않습니다.");
  }

  const genealogy = Array.isArray(payload.rstLst) ? payload.rstLst : [];
  const members = Array.isArray(payload.members) ? payload.members : [];
  if (!genealogy.length) throw new Error("계보 회원 데이터가 없습니다.");

  const sales = new Map(members.map((row) => [memberId(row), row]));
  const rows = genealogy
    .filter((row) => memberId(row))
    .map((row) => ({ ...row, ...(sales.get(memberId(row)) || {}) }));
  const byId = new Map(rows.map((row) => [memberId(row), row]));
  const children = new Map();

  rows.forEach((row) => {
    const parentId = String(row.ppId ?? "");
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(row);
  });
  children.forEach((items) => items.sort(comparePosition));

  return {
    rows,
    byId,
    children,
    missingSalesIds: rows
      .filter((row) => !sales.has(memberId(row)))
      .map((row) => memberId(row)),
  };
}

export function attachPerformanceSubtree(
  targetModel,
  sourceModel,
  anchorMemberId,
  parentMemberId = null,
) {
  const anchorId = String(anchorMemberId ?? "");
  const anchor = sourceModel?.byId?.get(anchorId);
  if (!targetModel?.byId || !targetModel?.children || !anchor) return 0;
  const stack = [anchor];
  const seen = new Set();
  let added = 0;
  while (stack.length) {
    const sourceRow = stack.pop();
    const id = String(sourceRow.userId ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const existing = targetModel.byId.get(id);
    const row = {
      ...(existing || {}),
      ...sourceRow,
      userId: id,
      ppId:
        id === anchorId && parentMemberId != null
          ? String(parentMemberId)
          : existing?.ppId ?? sourceRow.ppId,
    };
    if (existing) {
      const index = targetModel.rows.indexOf(existing);
      if (index >= 0) targetModel.rows[index] = row;
    } else {
      targetModel.rows.push(row);
      added += 1;
    }
    targetModel.byId.set(id, row);
    (sourceModel.children.get(id) || []).forEach((child) => stack.push(child));
  }
  const children = new Map();
  targetModel.rows.forEach((row) => {
    const parentId = String(row.ppId ?? "");
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(row);
  });
  children.forEach((items) => items.sort(comparePosition));
  targetModel.children = children;
  return added;
}

function genealogyDepth(model, row) {
  let depth = 0;
  let current = row;
  const visited = new Set();
  while (current?.ppId && !visited.has(String(current.ppId))) {
    visited.add(String(current.ppId));
    current = model.byId.get(String(current.ppId));
    if (!current) break;
    depth += 1;
  }
  return depth;
}

export function sortMembersDeepestFirst(model, memberIds) {
  return memberIds
    .map((id) => model.byId.get(String(id)))
    .filter(Boolean)
    .sort(
      (left, right) =>
        genealogyDepth(model, right) - genealogyDepth(model, left) ||
        model.rows.indexOf(right) - model.rows.indexOf(left),
    );
}

function deepestLeaf(start, children) {
  if (!start) return null;
  const leaves = [];
  const visited = new Set();
  let visitOrder = 0;
  const stack = [{ row: start, depth: 0 }];

  while (stack.length) {
    const { row, depth } = stack.pop();
    const id = memberId(row);
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const descendants = children.get(id) || [];
    if (!descendants.length) leaves.push({ row, depth, order: visitOrder++ });
    else {
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        stack.push({ row: descendants[index], depth: depth + 1 });
      }
    }
  }

  return (
    leaves.sort(
      (left, right) => right.depth - left.depth || right.order - left.order,
    )[0]?.row || start
  );
}

function deepestPlaceableLeaf(start, children) {
  if (!start || numeric(start.completedClosingNv) > 0) return null;
  const leaves = [];
  const visited = new Set();
  let visitOrder = 0;
  const stack = [{ row: start, depth: 0 }];

  while (stack.length) {
    const { row, depth } = stack.pop();
    const id = memberId(row);
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const placeable = (children.get(id) || []).filter(
      (descendant) => numeric(descendant.completedClosingNv) <= 0,
    );
    if (!placeable.length) leaves.push({ row, depth, order: visitOrder++ });
    else {
      for (let index = placeable.length - 1; index >= 0; index -= 1) {
        stack.push({ row: placeable[index], depth: depth + 1 });
      }
    }
  }

  return (
    leaves.sort(
      (left, right) => right.depth - left.depth || right.order - left.order,
    )[0]?.row || null
  );
}

export function calculatePerformance(
  model,
  selectedMemberId,
  requestedTargets,
) {
  const { majorTarget, minorTarget } = normalizeTargets(requestedTargets);
  if (majorTarget <= 0 || minorTarget <= 0) {
    throw new Error("대실적·소실적 목표는 모두 0보다 커야 합니다.");
  }

  const member = model.byId.get(String(selectedMemberId));
  if (!member) throw new Error("계산할 회원을 찾지 못했습니다.");

  const directChildren = model.children.get(memberId(member)) || [];
  const subMembers = [directChildren[0] || null, directChildren[1] || null];
  const branches = subMembers.map(branchBreakdown);
  const minorOwnContribution = Math.max(0, numeric(member.ordPv));
  const ownContributionIndex = branches[0].total < branches[1].total ? 0 : 1;
  const effectiveTotals = branches.map(
    (branch, index) =>
      branch.total +
      (index === ownContributionIndex ? minorOwnContribution : 0),
  );
  const majorIndex = effectiveTotals[0] >= effectiveTotals[1] ? 0 : 1;
  const minorIndex = majorIndex === 0 ? 1 : 0;
  const minorRequiredTarget = Math.max(
    0,
    minorTarget -
      (ownContributionIndex === minorIndex ? minorOwnContribution : 0),
  );
  const branchTargets = [];
  branchTargets[majorIndex] = majorTarget;
  branchTargets[minorIndex] = minorTarget;
  const deficits = effectiveTotals.map((total, index) =>
    Math.max(0, branchTargets[index] - total),
  );
  const achieved = deficits.every((deficit) => deficit === 0);
  const priority = achieved ? null : deficits[0] >= deficits[1] ? 0 : 1;
  const candidate =
    priority === null
      ? null
      : deepestLeaf(subMembers[priority], model.children);
  const branchCandidates = subMembers.map((subMember) =>
    deepestLeaf(subMember, model.children),
  );
  const placements = [0, 1].map((index) => {
    const subMember = subMembers[index];
    if (subMember) {
      const target = deepestPlaceableLeaf(subMember, model.children);
      if (target) return { kind: "line", target };
    }
    if (index === ownContributionIndex) return { kind: "self", target: member };
    return { kind: "none", target: null };
  });
  const feasible = deficits.every(
    (deficit, index) => deficit === 0 || placements[index].kind !== "none",
  );
  const warnings = [];

  if (!feasible) {
    warnings.push(
      "부족한 라인에 배치 가능한 코드가 없어 마감할 수 없습니다. 신규 하위 배치가 필요합니다.",
    );
  }

  if (directChildren.length > 2) {
    warnings.push(
      `직접 하위가 ${directChildren.length}명이라 앞의 두 라인만 계산했습니다.`,
    );
  }
  if (model.missingSalesIds.length) {
    warnings.push(
      `NV 자료가 없는 회원 ${model.missingSalesIds.length}명은 0으로 계산했습니다.`,
    );
  }

  return {
    member,
    majorTarget,
    minorTarget,
    majorIndex,
    minorIndex,
    ownContributionIndex,
    minorOwnContribution,
    minorRequiredTarget,
    branchTargets,
    effectiveTotals,
    subMembers,
    branches,
    deficits,
    achieved,
    priority,
    candidate,
    branchCandidates,
    placements,
    feasible,
    warnings,
  };
}

export function applyOwnSalesFlow(
  originalResult,
  requestedTargets,
  { inheritedOwnNv = 0, suppressOwn = false } = {},
) {
  const result = {
    ...originalResult,
    effectiveTotals: [...originalResult.effectiveTotals],
    branchTargets: [...originalResult.branchTargets],
    deficits: [...originalResult.deficits],
  };
  if (suppressOwn && result.minorOwnContribution > 0) {
    result.effectiveTotals[result.ownContributionIndex] = Math.max(
      0,
      result.effectiveTotals[result.ownContributionIndex] -
        result.minorOwnContribution,
    );
    result.transferredOwnNv = result.minorOwnContribution;
    result.minorOwnContribution = 0;
  }
  const inherited = Math.max(0, numeric(inheritedOwnNv));
  if (inherited > 0) {
    result.effectiveTotals[result.ownContributionIndex] += inherited;
    result.inheritedOwnNv = inherited;
    result.inheritedOwnIndex = result.ownContributionIndex;
  }
  result.majorIndex =
    result.effectiveTotals[0] >= result.effectiveTotals[1] ? 0 : 1;
  result.minorIndex = result.majorIndex === 0 ? 1 : 0;
  const { majorTarget, minorTarget } = normalizeTargets(requestedTargets);
  result.branchTargets = [];
  result.branchTargets[result.majorIndex] = majorTarget;
  result.branchTargets[result.minorIndex] = minorTarget;
  result.deficits = result.effectiveTotals.map((total, index) =>
    Math.max(0, result.branchTargets[index] - total),
  );
  result.achieved = result.deficits.every((deficit) => deficit === 0);
  result.priority = result.achieved
    ? null
    : result.deficits[0] >= result.deficits[1]
      ? 0
      : 1;
  return result;
}

export function planBalancedClosingTopUp(
  model,
  closerMemberId,
  upstreamDeficitNv,
  plannedCompletion = null,
) {
  const member = model.byId.get(String(closerMemberId));
  if (!member) throw new Error("재계산할 하위 마감 사업자를 찾지 못했습니다.");
  const currentMajorNv = numeric(
    plannedCompletion?.majorNv ?? member.completedClosingMajorNv,
  );
  const currentMinorNv = numeric(
    plannedCompletion?.minorNv ?? member.completedClosingMinorNv,
  );
  const currentCompletedNv = currentMajorNv + currentMinorNv;
  const upstreamDeficit = Math.max(0, numeric(upstreamDeficitNv));
  if (currentCompletedNv <= 0 || upstreamDeficit <= 0) return null;

  const balancedTargetNv = Math.ceil((currentCompletedNv + upstreamDeficit) / 2);
  const clonedRows = model.rows.map((row) => ({ ...row }));
  const clonedById = new Map(clonedRows.map((row) => [memberId(row), row]));
  const clonedChildren = new Map();
  clonedRows.forEach((row) => {
    const parentId = String(row.ppId ?? "");
    if (!clonedChildren.has(parentId)) clonedChildren.set(parentId, []);
    clonedChildren.get(parentId).push(row);
  });
  clonedChildren.forEach((rows) => rows.sort(comparePosition));
  const clonedModel = {
    rows: clonedRows,
    byId: clonedById,
    children: clonedChildren,
    missingSalesIds: [...(model.missingSalesIds || [])],
  };
  const clonedMember = clonedById.get(String(closerMemberId));
  delete clonedMember.completedClosingMajorNv;
  delete clonedMember.completedClosingMinorNv;
  delete clonedMember.completedClosingNv;
  delete clonedMember.completedClosingPreviousTotal;

  const result = calculatePerformance(clonedModel, closerMemberId, {
    majorTarget: balancedTargetNv,
    minorTarget: balancedTargetNv,
  });
  result.effectiveTotals[result.majorIndex] = currentMajorNv;
  result.effectiveTotals[result.minorIndex] = currentMinorNv;
  result.deficits = result.effectiveTotals.map((total, index) =>
    Math.max(0, result.branchTargets[index] - total),
  );
  result.placements = result.subMembers.map((subMember, index) => {
    if (subMember) return { kind: "line", target: deepestLeaf(subMember, clonedChildren) };
    if (index === result.ownContributionIndex) {
      return { kind: "self", target: clonedMember };
    }
    return { kind: "none", target: null };
  });
  result.feasible = result.deficits.every(
    (deficit, index) => deficit === 0 || result.placements[index].kind !== "none",
  );
  return {
    closerMemberId: String(closerMemberId),
    currentMajorNv,
    currentMinorNv,
    currentCompletedNv,
    upstreamDeficitNv: upstreamDeficit,
    balancedTargetNv,
    result,
    projection: projectClosingCompletion(result),
  };
}

function shallowestClosingDescendant(start, children, closingSet) {
  if (!start) return null;
  const queue = [start];
  const visited = new Set();
  while (queue.length) {
    const row = queue.shift();
    const id = memberId(row);
    if (!id || visited.has(id)) continue;
    visited.add(id);
    if (closingSet.has(id)) return row;
    (children.get(id) || []).forEach((descendant) => queue.push(descendant));
  }
  return null;
}

export function allocateClosingTargets(
  model,
  topMemberId,
  topTargets,
  closingMemberIds,
  targetOverrides,
) {
  const { majorTarget, minorTarget } = normalizeTargets(topTargets);
  if (majorTarget <= 0 || minorTarget <= 0) {
    throw new Error("대실적·소실적 목표는 모두 0보다 커야 합니다.");
  }
  const topMember = model.byId.get(String(topMemberId));
  if (!topMember) throw new Error("기준 사업자를 찾지 못했습니다.");
  const closingSet = new Set((closingMemberIds || []).map(String));
  const overrides = targetOverrides || {};

  const allocate = (
    member,
    memberMajorTarget,
    memberMinorTarget,
    depth,
    autoTargets,
  ) => {
    const directChildren = model.children.get(memberId(member)) || [];
    const subMembers = [directChildren[0] || null, directChildren[1] || null];
    const branches = subMembers.map(branchBreakdown);
    const own = Math.max(0, numeric(member.ordPv));
    const ownContributionIndex =
      branches[0].total < branches[1].total ? 0 : 1;
    const effectiveTotals = branches.map(
      (branch, index) =>
        branch.total + (index === ownContributionIndex ? own : 0),
    );
    const majorIndex = effectiveTotals[0] >= effectiveTotals[1] ? 0 : 1;
    const lineTargets = [];
    lineTargets[majorIndex] = memberMajorTarget;
    lineTargets[majorIndex === 0 ? 1 : 0] = memberMinorTarget;

    const lines = [0, 1].map((index) => {
      const subMember = subMembers[index];
      const ownHere = index === ownContributionIndex ? own : 0;
      const closer = subMember
        ? shallowestClosingDescendant(subMember, model.children, closingSet)
        : null;
      if (!closer) {
        return {
          index,
          lineTarget: lineTargets[index],
          passthroughNv: branches[index].total + ownHere,
          childAllocation: null,
        };
      }
      const passthroughNv =
        branches[index].total - branchBreakdown(closer).total + ownHere;
      const remaining = Math.max(0, lineTargets[index] - passthroughNv);
      const autoMajor = Math.ceil(remaining / 2);
      const autoMinor = remaining - autoMajor;
      const override = overrides[memberId(closer)];
      const childMajor = override
        ? Math.max(0, numeric(override.majorTarget))
        : autoMajor;
      const childMinor = override
        ? Math.max(0, numeric(override.minorTarget))
        : autoMinor;
      return {
        index,
        lineTarget: lineTargets[index],
        passthroughNv,
        childAllocation: allocate(closer, childMajor, childMinor, depth + 1, {
          majorTarget: autoMajor,
          minorTarget: autoMinor,
        }),
      };
    });

    return {
      memberId: memberId(member),
      depth,
      majorTarget: memberMajorTarget,
      minorTarget: memberMinorTarget,
      autoMajorTarget: autoTargets?.majorTarget ?? memberMajorTarget,
      autoMinorTarget: autoTargets?.minorTarget ?? memberMinorTarget,
      overridden:
        depth > 0 &&
        (memberMajorTarget !== (autoTargets?.majorTarget ?? memberMajorTarget) ||
          memberMinorTarget !==
            (autoTargets?.minorTarget ?? memberMinorTarget)),
      sourceTopMemberId: String(topMemberId),
      lines,
      childAllocations: lines
        .map((line) => line.childAllocation)
        .filter(Boolean),
    };
  };

  return allocate(topMember, majorTarget, minorTarget, 0);
}

function flattenAllocation(node, out = []) {
  out.push(node);
  node.lines.forEach((line) => {
    if (line.childAllocation) flattenAllocation(line.childAllocation, out);
  });
  return out;
}

export function planClosing(
  model,
  topMemberId,
  topTargets,
  closingMemberIds,
  targetOverrides,
) {
  const { majorTarget, minorTarget } = normalizeTargets(topTargets);
  const allocation = allocateClosingTargets(
    model,
    topMemberId,
    topTargets,
    closingMemberIds,
    targetOverrides,
  );
  const nodes = flattenAllocation(allocation).sort(
    (left, right) => right.depth - left.depth,
  );
  const steps = nodes.map((node) => {
    if (node.majorTarget + node.minorTarget <= 0) {
      return { memberId: node.memberId, allocation: node, skipped: true };
    }
    const result = calculatePerformance(model, node.memberId, {
      majorTarget: node.majorTarget,
      minorTarget: node.minorTarget,
    });
    const projection = projectClosingCompletion(result);
    const applied = projection.feasible !== false;
    if (applied) applyClosingCompletion(model, node.memberId, projection);
    return { memberId: node.memberId, allocation: node, result, projection, applied };
  });
  const placements = steps.flatMap((step) => {
    if (!step.projection) return [];
    return step.projection.topUps
      .map((topUp, index) => ({
        closerMemberId: step.memberId,
        side: index === step.result.majorIndex ? "major" : "minor",
        placementKind: step.result.placements[index].kind,
        placementMemberId: step.result.placements[index].target
          ? memberId(step.result.placements[index].target)
          : null,
        salesWon: topUp.salesWon,
        addedNv: topUp.addedNv,
        excessNv: topUp.excessNv,
      }))
      .filter((placement) => placement.salesWon > 0);
  });
  const topStep = steps[steps.length - 1];
  const verified =
    topStep?.projection?.feasible !== false &&
    numeric(topStep?.projection?.majorNv) >= majorTarget &&
    numeric(topStep?.projection?.minorNv) >= minorTarget;
  return {
    allocation,
    steps,
    placements,
    totalSalesWon: placements.reduce(
      (sum, placement) => sum + placement.salesWon,
      0,
    ),
    topMajorNv: numeric(topStep?.projection?.majorNv),
    topMinorNv: numeric(topStep?.projection?.minorNv),
    topCompletedNv: numeric(topStep?.projection?.completedNv),
    verified,
  };
}

// ── 6만 NV 기준 ─────────────────────────────────────────────
// 인증직급 GD 이상은 소실적 6만 NV 이상일 때 매출장려금이 나온다. 한 라인에 넣을 매출을
// 맨 아래 한 곳에 몰지 않고, 그 아래 모든 하위 구조에서 6만을 새로 넘기는 사람이 가장
// 많아지도록 같은 금액을 한두 곳에 나눠 넣는 안을 찾는다. (총 지출 = 기본 추천과 같다.)
export const SIXTY_K_NV = 60000;

export function isSixtyKEligible(row) {
  const rank = String(row?.rankMaxName || row?.rankName || "회원").toUpperCase();
  return PROMOTION_ORDER.indexOf(rank) >= PROMOTION_ORDER.indexOf("GD");
}

function subtreeMemberIds(model, rootId) {
  const ids = [];
  const seen = new Set();
  const stack = [String(rootId)];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !model.byId.has(id)) continue;
    seen.add(id);
    ids.push(id);
    (model.children.get(id) || []).forEach((child) => stack.push(memberId(child)));
  }
  return ids;
}

// salesNvById: 회원번호 → 그 회원 본인 코드에 새로 넣는 NV. 소실적 규칙은 calculatePerformance와
// 같다(본인 매출은 두 라인 중 더 작은 쪽에 합산, 소실적 = 두 값 중 작은 쪽).
function minorNvByMember(model, rootId, salesNvById = new Map()) {
  const subSales = new Map();
  const sales = (id) => {
    if (subSales.has(id)) return subSales.get(id);
    let sum = numeric(salesNvById.get(id));
    (model.children.get(id) || []).forEach((child) => {
      sum += sales(memberId(child));
    });
    subSales.set(id, sum);
    return sum;
  };
  const total = (row) => branchBreakdown(row).total + sales(memberId(row));
  const result = new Map();
  subtreeMemberIds(model, rootId).forEach((id) => {
    const row = model.byId.get(id);
    const kids = model.children.get(id) || [];
    const lines = [kids[0] ? total(kids[0]) : 0, kids[1] ? total(kids[1]) : 0];
    const own = numeric(row.ordPv) + numeric(salesNvById.get(id));
    const withOwn = lines[0] < lines[1] ? [lines[0] + own, lines[1]] : [lines[0], lines[1] + own];
    result.set(id, Math.min(...withOwn));
  });
  return result;
}

export function planSixtyKSplit(model, lineRootId, deficitNv, defaultPlacements = [], excludedIds = new Set()) {
  const topUp = salesTopUpForDeficit(deficitNv);
  if (topUp.salesWon <= 0) return null;
  const ids = subtreeMemberIds(model, lineRootId);
  if (!ids.length) return null;
  // 제외한 회원에게는 매출을 넣지 않는다(실적 계산에는 그대로 포함).
  const placeIds = ids.filter((id) => !excludedIds.has(id));
  const eligible = ids.filter((id) => isSixtyKEligible(model.byId.get(id)));
  const base = minorNvByMember(model, lineRootId);
  const nvOf = (won) => Math.floor(won / 1000) * 810;
  const qualifiedFor = (placements) => {
    const salesNv = new Map();
    placements.forEach(({ memberId: id, salesWon }) => {
      salesNv.set(id, numeric(salesNv.get(id)) + nvOf(salesWon));
    });
    const after = minorNvByMember(model, lineRootId, salesNv);
    const crossed = eligible.filter(
      (id) => numeric(base.get(id)) < SIXTY_K_NV && numeric(after.get(id)) >= SIXTY_K_NV,
    );
    // 같은 수라면 하위 박스들의 소실적 합이 더 큰 안(아래 칸에 넣어 위로 올리는 안)을 고른다.
    crossed.minorSum = [...after.values()].reduce((sum, value) => sum + value, 0);
    return crossed;
  };
  const baselineQualified = qualifiedFor(
    defaultPlacements.map((p) => ({ memberId: String(p.memberId), salesWon: p.salesWon })),
  );
  const total = topUp.salesWon;
  const MIN_PIECE = 10000;
  const step = total <= 100000 ? 1000 : 2000;
  let best = null;
  const consider = (placements) => {
    const qualified = qualifiedFor(placements);
    // 6만/6만처럼 한 박스의 두 라인을 모두 올려야 넘는 경우에는, 그 박스의 바로 아래
    // 박스 코드에 나눠 넣는 안을 우선한다. (이미 한쪽이 충분하면 맨 아래 칸이 우선)
    const qualifiedSet = new Set(qualified);
    const direct =
      placements.length >= 2 &&
      placements.every((p) => qualifiedSet.has(String(model.byId.get(p.memberId)?.ppId ?? "")))
        ? 1
        : 0;
    const same = best && qualified.length === best.qualified.length;
    if (
      !best ||
      qualified.length > best.qualified.length ||
      (same && placements.length < best.placements.length) ||
      (same && placements.length === best.placements.length && direct > best.direct) ||
      (same &&
        placements.length === best.placements.length &&
        direct === best.direct &&
        qualified.minorSum > best.qualified.minorSum)
    ) {
      best = { placements, qualified, direct };
    }
  };
  placeIds.forEach((id) => consider([{ memberId: id, salesWon: total }]));
  if (total >= MIN_PIECE * 2) {
    for (let i = 0; i < placeIds.length; i += 1) {
      for (let j = i + 1; j < placeIds.length; j += 1) {
        for (let first = MIN_PIECE; first <= total - MIN_PIECE; first += step) {
          consider([
            { memberId: placeIds[i], salesWon: first },
            { memberId: placeIds[j], salesWon: total - first },
          ]);
        }
      }
    }
  }
  if (!best) return null;
  // 한 곳에 몰아 넣는 안이면, 6만 달성자가 같은 다른 단일 코드도 함께 알려준다(같은 결과).
  const bestKey = [...best.qualified].sort().join(",");
  const alternatives =
    best.placements.length === 1 && best.qualified.length > 0
      ? placeIds.filter(
          (id) => [...qualifiedFor([{ memberId: id, salesWon: total }])].sort().join(",") === bestKey,
        )
      : [];
  return {
    totalWon: total,
    alternatives,
    placements: best.placements.map((p) => ({ ...p, addedNv: nvOf(p.salesWon) })),
    qualified: [...best.qualified],
    baselineQualified: [...baselineQualified],
    improves: best.qualified.length > baselineQualified.length,
  };
}

// 균형 분산 추천: 부족분을 한두 박스에 몰지 않고, 각 박스에서 "작은 쪽 라인"부터 채워
// 두 라인이 같아지면 양쪽에 반반 나누며 아래 박스로 계속 내려간다. (소실적 = 작은 쪽이므로
// 균형 있게 채워야 소실적이 가장 많이 오르고 6만 NV를 넘는 박스가 늘어난다.)
// 1,000원 = 810 NV 단위로 계산하고, 한 곳에 넣는 금액은 최소 1만원이다.
// excludedIds: 매출을 넣지 않을 회원(실적 계산에는 그대로 포함, 넣을 자리는 가까운 윗사람으로 올린다).
export function planBalancedSplit(model, lineRootId, deficitNv, excludedIds = new Set()) {
  const topUp = salesTopUpForDeficit(deficitNv);
  if (topUp.salesWon <= 0) return null;
  const ids = subtreeMemberIds(model, lineRootId);
  if (!ids.length) return null;
  const idSet = new Set(ids);
  const UNIT_NV = 810;
  const MIN_UNITS = 10;
  const totalUnits = topUp.salesWon / 1000;
  const placed = new Map(); // 회원번호 → 넣은 단위(1,000원)
  const redirected = new Map(); // 회원번호 → 제외한 회원 몫으로 대신 받은 단위(1,000원)
  const kidsOf = (id) => model.children.get(String(id)) || [];
  const nvOf = (won) => Math.floor(won / 1000) * UNIT_NV;

  const subSalesNv = (id, seen = new Set()) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let sum = numeric(placed.get(id)) * UNIT_NV;
    kidsOf(id).forEach((kid) => {
      sum += subSalesNv(memberId(kid), seen);
    });
    return sum;
  };
  const lineTotal = (row) => branchBreakdown(row).total + subSalesNv(memberId(row));
  const place = (id, units) => {
    let target = String(id);
    while (target && excludedIds.has(target)) target = String(model.byId.get(target)?.ppId ?? "");
    if (!idSet.has(target)) return false;
    placed.set(target, numeric(placed.get(target)) + units);
    if (target !== String(id)) redirected.set(target, numeric(redirected.get(target)) + units);
    return true;
  };

  const distribute = (id, units, depth = 0) => {
    if (units <= 0) return;
    const kids = kidsOf(id);
    if (!kids.length || depth > 60) {
      if (!place(id, units)) leftover += units;
      return;
    }
    const row = model.byId.get(id);
    const lines = [kids[0] ? lineTotal(kids[0]) : 0, kids[1] ? lineTotal(kids[1]) : 0];
    const own = numeric(row.ordPv) + numeric(placed.get(id)) * UNIT_NV;
    const small = lines[0] < lines[1] ? 0 : 1; // 본인 NV는 작은 쪽(같으면 서브2)에 합산
    const sums = [lines[0] + (small === 0 ? own : 0), lines[1] + (small === 1 ? own : 0)];
    const weak = sums[0] < sums[1] ? 0 : 1; // 소실적을 올리려면 작은 쪽을 채운다
    const gapUnits = Math.ceil(Math.abs(sums[0] - sums[1]) / UNIT_NV);
    const toWeak = Math.min(units, gapUnits);
    const rest = units - toWeak;
    const amounts = [0, 0];
    amounts[weak] = toWeak + Math.ceil(rest / 2);
    amounts[1 - weak] = Math.floor(rest / 2);
    // 1만원보다 작은 조각은 다른 쪽으로 합친다
    [0, 1].forEach((side) => {
      if (amounts[side] > 0 && amounts[side] < MIN_UNITS && amounts[1 - side] > 0) {
        amounts[1 - side] += amounts[side];
        amounts[side] = 0;
      }
    });
    [0, 1].forEach((side) => {
      if (amounts[side] <= 0) return;
      if (kids[side]) distribute(memberId(kids[side]), amounts[side], depth + 1);
      else if (!place(id, amounts[side])) leftover += amounts[side];
    });
  };

  let leftover = 0;
  distribute(String(lineRootId), totalUnits);
  if (leftover > 0) {
    const fallback = ids.find((id) => !excludedIds.has(id));
    if (fallback === undefined) return null;
    placed.set(fallback, numeric(placed.get(fallback)) + leftover);
    redirected.set(fallback, numeric(redirected.get(fallback)) + leftover);
  }

  const placements = [...placed.entries()]
    .filter(([, units]) => units > 0)
    .map(([memberIdValue, units]) => ({ memberId: memberIdValue, salesWon: units * 1000 }));
  const eligible = ids.filter((id) => isSixtyKEligible(model.byId.get(id)));
  const base = minorNvByMember(model, lineRootId);
  const salesNv = new Map(placements.map((p) => [p.memberId, nvOf(p.salesWon)]));
  const after = minorNvByMember(model, lineRootId, salesNv);
  const qualified = eligible.filter(
    (id) => numeric(base.get(id)) < SIXTY_K_NV && numeric(after.get(id)) >= SIXTY_K_NV,
  );
  return {
    totalWon: topUp.salesWon,
    alternatives: [],
    placements: placements.map((p) => ({ ...p, addedNv: nvOf(p.salesWon) })),
    qualified,
    baselineQualified: [],
    improves: qualified.length > 0,
    // 제외한 회원 몫을 대신 받은 박스 (회원번호 → 원). 화면에 이유를 보여주는 데 쓴다.
    redirected: Object.fromEntries([...redirected.entries()].filter(([, u]) => u > 0).map(([id, u]) => [id, u * 1000])),
  };
}
