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
  return JSON.stringify([
    String(topMemberId),
    majorTarget,
    minorTarget,
    ids,
    overrides,
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
