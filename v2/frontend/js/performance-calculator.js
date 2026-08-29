const numeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const memberId = (row) => String(row?.userId ?? "");

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

export function projectClosingCompletion(result) {
  const topUps = result.deficits.map(salesTopUpForDeficit);
  const projectedTotals = result.effectiveTotals.map(
    (total, index) => total + topUps[index].addedNv,
  );
  const majorNv = projectedTotals[result.majorIndex];
  const minorNv = projectedTotals[result.minorIndex];
  return {
    topUps,
    projectedTotals,
    majorNv,
    minorNv,
    completedNv: majorNv + minorNv,
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

export function calculatePerformance(
  model,
  selectedMemberId,
  requestedTargets,
) {
  const sameTarget =
    typeof requestedTargets === "object" ? null : numeric(requestedTargets);
  const majorTarget = numeric(requestedTargets?.majorTarget ?? sameTarget);
  const minorTarget = numeric(requestedTargets?.minorTarget ?? sameTarget);
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
  const warnings = [];

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
    warnings,
  };
}
