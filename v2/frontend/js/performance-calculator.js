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
  return { own, major, minor, total: own + major + minor };
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
      (left, right) =>
        right.depth - left.depth || right.order - left.order,
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
  const majorIndex = branches[0].total >= branches[1].total ? 0 : 1;
  const minorIndex = majorIndex === 0 ? 1 : 0;
  const minorOwnContribution = Math.max(0, numeric(member.ordPv));
  const minorRequiredTarget = Math.max(0, minorTarget - minorOwnContribution);
  const branchTargets = [];
  branchTargets[majorIndex] = majorTarget;
  branchTargets[minorIndex] = minorRequiredTarget;
  const effectiveTotals = branches.map(
    (branch, index) =>
      branch.total + (index === minorIndex ? minorOwnContribution : 0),
  );
  const deficits = branches.map((branch, index) =>
    Math.max(0, branchTargets[index] - branch.total),
  );
  const achieved = deficits.every((deficit) => deficit === 0);
  const priority = achieved ? null : deficits[0] >= deficits[1] ? 0 : 1;
  const candidate =
    priority === null ? null : deepestLeaf(subMembers[priority], model.children);
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
    warnings,
  };
}
