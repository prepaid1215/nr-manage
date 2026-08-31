const numeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const memberId = (row) => String(row?.userId ?? "");

// 매출 단위 — 1,000원 = 810 NV, 최소 10,000원부터 1,000원 단위
export const NV_PER_WON = 0.81;
export const SALE_UNIT_WON = 1000;
export const MIN_SALE_WON = 10000;
export const MIN_SALE_NV = MIN_SALE_WON * NV_PER_WON; // 8,100 NV
// 부족분 분산 배치 — 기본 2곳(라인당 1곳), 한 라인 금액이 크면 4곳(라인당 2곳)까지 내려간다
export const SPLIT_SALE_WON = 100000;
export const MAX_CODES_PER_LINE = 2;

// 인증직급(rankMaxName) 등급. 표기가 없으면 0(매출장려금 지급 대상 아님)
const RANK_LEVELS = [
  ["CDD", 6],
  ["DD", 5],
  ["ED", 4],
  ["RD", 3],
  ["GD", 2],
  ["DT", 1],
];

export function certifiedRankLevel(row) {
  const rank = String(row?.rankMaxName ?? "")
    .toUpperCase()
    .replace(/\s/g, "");
  const hit = RANK_LEVELS.find(([code]) => rank.includes(code));
  return hit ? hit[1] : 0;
}

// 매출장려금 지급 기준선 — 인증직급 DT 3만 NV, GD 이상 6만 NV
export function minorPayoutFloor(row) {
  const level = certifiedRankLevel(row);
  if (level >= 2) return 60000;
  if (level === 1) return 30000;
  return 0;
}

// 매출장려금 표 (v2/docs/closing-calculator.md)
export const INCENTIVE_TABLE = [
  { level: 1, min: 30000, max: 400000, rate: 5 },
  { level: 1, min: 400000, max: 800000, rate: 6 },
  { level: 2, min: 400000, max: 800000, rate: 8 },
  { level: 2, min: 800000, max: 1500000, rate: 10 },
  { level: 3, min: 1500000, max: 4000000, rate: 10 },
  { level: 4, min: 5000000, max: 12000000, rate: 9 },
  { level: 5, min: 20000000, max: 30000000, rate: 7 },
  { level: 5, min: 40000000, max: 50000000, rate: 6 },
  { level: 5, min: 75000000, max: 150000000, amountWon: 3500000 },
  { level: 5, min: 150000000, max: 200000000, amountWon: 5000000 },
  { level: 5, min: 200000000, max: 400000000, amountWon: 7000000 },
  { level: 6, min: 400000000, max: Infinity, amountWon: 10000000 },
];

// 지금 소실적이 어느 지급 구간인지와 다음 구간까지 얼마나 남았는지
export function minorIncentiveTier(row, minorNv) {
  const level = certifiedRankLevel(row);
  const nv = Math.max(0, numeric(minorNv));
  const usable = INCENTIVE_TABLE.filter((tier) => tier.level <= level);
  const current =
    usable
      .filter((tier) => nv >= tier.min && nv <= tier.max)
      .sort(
        (left, right) =>
          (right.rate ?? 0) - (left.rate ?? 0) ||
          (right.amountWon ?? 0) - (left.amountWon ?? 0) ||
          right.min - left.min,
      )[0] || null;
  const next =
    usable
      .filter((tier) => tier.min > nv)
      .sort((left, right) => left.min - right.min)[0] || null;
  return {
    level,
    floor: minorPayoutFloor(row),
    rate: current?.rate ?? null,
    amountWon: current?.amountWon ?? null,
    min: current?.min ?? null,
    max: current?.max ?? null,
    nextMin: next?.min ?? null,
    nextShortfallNv: next ? next.min - nv : 0,
  };
}

// 목표는 두 가지 모양이다.
// - sides: 최상위 사업자가 직접 입력한 대실적·소실적 목표
// - total: 상위에서 내려온 "라인 합계" 목표 + 소실적 지급 기준선
const normalizeTargets = (requestedTargets) => {
  const isTotalMode =
    requestedTargets &&
    typeof requestedTargets === "object" &&
    (requestedTargets.lineTarget != null || requestedTargets.minorFloor != null);
  if (isTotalMode) {
    return {
      mode: "total",
      lineTarget: Math.max(0, numeric(requestedTargets.lineTarget)),
      minorFloor: Math.max(0, numeric(requestedTargets.minorFloor)),
      majorTarget: 0,
      minorTarget: 0,
    };
  }
  const sameTarget =
    typeof requestedTargets === "object" ? null : numeric(requestedTargets);
  return {
    mode: "sides",
    lineTarget: 0,
    minorFloor: 0,
    majorTarget: numeric(requestedTargets?.majorTarget ?? sameTarget),
    minorTarget: numeric(requestedTargets?.minorTarget ?? sameTarget),
  };
};

export const comparePosition = (left, right) => {
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

// 직계 하위가 2명이면 그대로 한 명씩 두 줄로, 3명 이상이면 실적 큰 순서로
// 정렬해 그 순간 합이 더 작은 줄에 번갈아 넣어서(그리디 균형 분배) 최대한
// 대실적 줄/소실적 줄 두 개로 균형 있게 나눈다. "밸런스 있게 내려가면 된다."
export function balancedLines(model, member) {
  const directChildren = model.children.get(memberId(member)) || [];
  if (directChildren.length <= 2) {
    return [
      directChildren[0] ? [directChildren[0]] : [],
      directChildren[1] ? [directChildren[1]] : [],
    ];
  }
  const withTotal = directChildren
    .map((row) => ({ row, total: branchBreakdown(row).total }))
    .sort((left, right) => right.total - left.total);
  const groups = [[], []];
  const sums = [0, 0];
  withTotal.forEach(({ row, total }) => {
    const target = sums[0] <= sums[1] ? 0 : 1;
    groups[target].push(row);
    sums[target] += total;
  });
  return groups;
}

// 그룹(하위 여러 명을 한 줄로 묶은 것)의 실적 합계.
export function groupBranchBreakdown(group) {
  return (group || []).reduce(
    (acc, row) => {
      const branch = branchBreakdown(row);
      return {
        own: acc.own + branch.own,
        major: acc.major + branch.major,
        minor: acc.minor + branch.minor,
        total: acc.total + branch.total,
        completed: acc.completed || branch.completed,
      };
    },
    { own: 0, major: 0, minor: 0, total: 0, completed: false },
  );
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

// 라인 합계 목표(lineTarget)와 소실적 기준선(minorFloor)을 두 서브라인의 부족분으로 나눈다.
// 1) 두 라인 모두 기준선 이상이 되게 한다 (소실적 = 두 라인 중 작은 쪽).
// 2) 남은 부족분은 작은 줄부터 채워 두 줄이 비슷해지도록 나눈다.
// 3) 최소 매출 10,000원(8,100 NV)에 못 미치는 자투리는 반대쪽에 합쳐 매출 낭비를 막는다.
export function distributeLineDeficit(
  totals,
  lineTarget,
  minorFloor,
  options = {},
) {
  const current = [
    Math.max(0, numeric(totals?.[0])),
    Math.max(0, numeric(totals?.[1])),
  ];
  const floor = Math.max(0, numeric(minorFloor));
  const placeable = options.placeable || [true, true];
  const floorNeed = current.map((total) => Math.max(0, floor - total));
  const need = [...floorNeed];
  const filled = current.map((total, index) => total + need[index]);
  const remaining = Math.max(0, numeric(lineTarget) - (filled[0] + filled[1]));

  if (remaining > 0) {
    const small = filled[0] <= filled[1] ? 0 : 1;
    const large = small === 0 ? 1 : 0;
    const gap = filled[large] - filled[small];
    if (remaining <= gap) {
      need[small] += remaining;
    } else {
      const rest = remaining - gap;
      const half = Math.ceil(rest / 2);
      need[small] += gap + half;
      need[large] += rest - half;
    }
  }

  const [lower, higher] = need[0] <= need[1] ? [0, 1] : [1, 0];
  if (
    need[lower] > 0 &&
    need[lower] < MIN_SALE_NV &&
    floorNeed[lower] === 0 &&
    need[higher] > 0 &&
    placeable[higher]
  ) {
    need[higher] += need[lower];
    need[lower] = 0;
  }

  return need;
}

// 한 라인에 들어갈 매출을 코드에 나눈다. 1,000원 단위 금액 자체를 반으로 쪼개므로
// 총 매출과 총 NV는 한 곳에 넣을 때와 정확히 같다. (144,000원 = 72,000원 두 번)
const splitLineSales = (topUp, codes) => {
  if (!topUp || topUp.salesWon <= 0 || !codes.length) return [];
  const single = (target) => [
    { target, salesWon: topUp.salesWon, addedNv: topUp.addedNv, excessNv: topUp.excessNv },
  ];
  if (codes.length < 2) return single(codes[0]);
  const units = topUp.salesWon / SALE_UNIT_WON;
  // codes[1]이 소실적 지급 기준선을 가진 코드(상위 본인 코드 또는 그 라인의
  // 얕은 코드)면, 그 코드가 자기 기준선을 채우는 데 필요한 만큼만 먼저
  // 배정하고, 남는 매출만 가장 깊은 코드(codes[0])로 몰아준다. 기준선을
  // 이미 채웠으면 codes[1]에는 아무것도 배정하지 않는다. 이번 매출로도
  // 기준선을 못 채우면 전액을 codes[1]에 넣는다(더 깊이 내려갈 필요 없음).
  const payoutFloor = minorPayoutFloor(codes[1]);
  if (payoutFloor > 0) {
    const ownNeedNv = Math.max(0, payoutFloor - branchBreakdown(codes[1]).total);
    const ownTopUp = salesTopUpForDeficit(ownNeedNv);
    if (ownTopUp.salesWon <= 0) return single(codes[0]);
    if (ownTopUp.salesWon >= topUp.salesWon) return single(codes[1]);
    const restWon = topUp.salesWon - ownTopUp.salesWon;
    if (restWon < MIN_SALE_WON) return single(codes[1]);
    return [
      {
        target: codes[1],
        salesWon: ownTopUp.salesWon,
        addedNv: ownTopUp.addedNv,
        excessNv: 0,
      },
      {
        target: codes[0],
        salesWon: restWon,
        addedNv: restWon * NV_PER_WON,
        excessNv: topUp.excessNv,
      },
    ];
  }
  // codes[1]에 기준선이 없으면 기존처럼 매출 규모가 클 때만 반반 나눈다.
  if (topUp.salesWon >= SPLIT_SALE_WON) {
    const firstUnits = Math.ceil(units / 2);
    const secondUnits = units - firstUnits;
    if (secondUnits * SALE_UNIT_WON >= MIN_SALE_WON) {
      return [
        {
          target: codes[0],
          salesWon: firstUnits * SALE_UNIT_WON,
          addedNv: firstUnits * 810,
          excessNv: 0,
        },
        {
          target: codes[1],
          salesWon: secondUnits * SALE_UNIT_WON,
          addedNv: secondUnits * 810,
          excessNv: topUp.excessNv,
        },
      ];
    }
  }
  return single(codes[0]);
};

export function projectClosingCompletion(result) {
  if (result.feasible === false) {
    return {
      feasible: false,
      topUps: result.deficits.map(() => ({
        salesWon: 0,
        addedNv: 0,
        excessNv: 0,
      })),
      sales: [],
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
  const sales = topUps.flatMap((topUp, index) =>
    splitLineSales(topUp, result.placementCodes?.[index] || []).map((entry) => ({
      lineIndex: index,
      side: index === result.majorIndex ? "major" : "minor",
      memberId: memberId(entry.target),
      target: entry.target,
      salesWon: entry.salesWon,
      addedNv: entry.addedNv,
      excessNv: entry.excessNv,
    })),
  );
  // 대·소실적은 매출을 넣은 뒤의 두 라인 중 큰 쪽/작은 쪽이다.
  // 작은 줄부터 채우는 분산 배치 때문에 계산 전후로 대·소가 뒤집힐 수 있다.
  const projectedMajorIndex = projectedTotals[0] >= projectedTotals[1] ? 0 : 1;
  const projectedMinorIndex = projectedMajorIndex === 0 ? 1 : 0;
  const majorNv = projectedTotals[projectedMajorIndex];
  const minorNv = projectedTotals[projectedMinorIndex];
  return {
    feasible: true,
    topUps,
    sales,
    projectedTotals,
    projectedMajorIndex,
    projectedMinorIndex,
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
      numeric(targets?.lineTarget),
      numeric(targets?.minorFloor),
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
  const starts = (Array.isArray(start) ? start : [start]).filter(Boolean);
  if (!starts.length) return null;
  const leaves = [];
  const visited = new Set();
  let visitOrder = 0;
  const stack = starts.map((row) => ({ row, depth: 0 }));

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
    )[0]?.row || starts[0]
  );
}

// 매출을 넣을 수 있는 코드를 깊은 곳부터 최대 limit개.
// 완료된 마감 사업자와 그 하위에는 중복 배치하지 않는다.
// start는 회원 한 명이거나(기존), 하위가 3명 이상이라 두 줄로 나눈 그룹
// (배열)일 수도 있다 — 그룹이면 그 안의 모든 사람과 하위를 함께 뒤진다.
export function placeableCodes(start, children, limit = MAX_CODES_PER_LINE) {
  const starts = (Array.isArray(start) ? start : [start]).filter(
    (row) => row && numeric(row.completedClosingNv) <= 0,
  );
  if (!starts.length) return [];
  const found = [];
  const visited = new Set();
  let visitOrder = 0;
  const stack = starts.map((row) => ({ row, depth: 0 }));

  while (stack.length) {
    const { row, depth } = stack.pop();
    const id = memberId(row);
    if (!id || visited.has(id)) continue;
    visited.add(id);
    found.push({ row, depth, order: visitOrder++ });
    const placeable = (children.get(id) || []).filter(
      (descendant) => numeric(descendant.completedClosingNv) <= 0,
    );
    for (let index = placeable.length - 1; index >= 0; index -= 1) {
      stack.push({ row: placeable[index], depth: depth + 1 });
    }
  }

  return found
    .sort((left, right) => right.depth - left.depth || right.order - left.order)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.row);
}

export function calculatePerformance(
  model,
  selectedMemberId,
  requestedTargets,
) {
  const targets = normalizeTargets(requestedTargets);
  if (
    targets.mode === "sides" &&
    (targets.majorTarget <= 0 || targets.minorTarget <= 0)
  ) {
    throw new Error("대실적·소실적 목표는 모두 0보다 커야 합니다.");
  }
  if (
    targets.mode === "total" &&
    targets.lineTarget <= 0 &&
    targets.minorFloor <= 0
  ) {
    throw new Error("라인 합계 목표는 0보다 커야 합니다.");
  }

  const member = model.byId.get(String(selectedMemberId));
  if (!member) throw new Error("계산할 회원을 찾지 못했습니다.");

  const directChildren = model.children.get(memberId(member)) || [];
  const subMembers = balancedLines(model, member);
  const branches = subMembers.map(groupBranchBreakdown);
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
    targets.minorTarget -
      (ownContributionIndex === minorIndex ? minorOwnContribution : 0),
  );

  // 상위(member)가 인증직급 소실적 지급 기준선(예: GD 6만 NV)을 갖고 있는데
  // 하위 라인에 나눠 넣을 코드가 하나뿐이면, 상위 본인 코드도 후보에 넣어서
  // 둘로 나눠 넣을 수 있게 한다 — 그래야 상위도 본인 매출로 그 기준선을 채운다.
  const ancestorPayoutFloor = minorPayoutFloor(member);
  const ancestorEligible =
    ancestorPayoutFloor > 0 && numeric(member.completedClosingNv) <= 0;
  let ancestorUsed = false;
  const placements = [0, 1].map((index) => {
    const subMember = subMembers[index];
    if (subMember) {
      let codes = placeableCodes(subMember, model.children);
      if (
        codes.length === 1 &&
        ancestorEligible &&
        !ancestorUsed &&
        memberId(codes[0]) !== memberId(member)
      ) {
        codes = [codes[0], member];
        ancestorUsed = true;
      }
      if (codes.length) return { kind: "line", target: codes[0], codes };
    }
    if (index === ownContributionIndex) {
      return { kind: "self", target: member, codes: [member] };
    }
    return { kind: "none", target: null, codes: [] };
  });
  const placementCodes = placements.map((placement) => placement.codes);

  const branchTargets = [];
  let deficits;
  if (targets.mode === "sides") {
    branchTargets[majorIndex] = targets.majorTarget;
    branchTargets[minorIndex] = targets.minorTarget;
    deficits = effectiveTotals.map((total, index) =>
      Math.max(0, branchTargets[index] - total),
    );
  } else {
    deficits = distributeLineDeficit(
      effectiveTotals,
      targets.lineTarget,
      targets.minorFloor,
      { placeable: placements.map((placement) => placement.kind !== "none") },
    );
    branchTargets[0] = effectiveTotals[0] + deficits[0];
    branchTargets[1] = effectiveTotals[1] + deficits[1];
  }

  const achieved = deficits.every((deficit) => deficit === 0);
  const priority = achieved ? null : deficits[0] >= deficits[1] ? 0 : 1;
  const candidate =
    priority === null
      ? null
      : deepestLeaf(subMembers[priority], model.children);
  const branchCandidates = subMembers.map((subMember) =>
    deepestLeaf(subMember, model.children),
  );
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
      `직접 하위가 ${directChildren.length}명이라, 실적이 큰 순서로 두 줄에 나눠 균형 있게 계산했습니다.`,
    );
  }
  if (model.missingSalesIds.length) {
    warnings.push(
      `NV 자료가 없는 회원 ${model.missingSalesIds.length}명은 0으로 계산했습니다.`,
    );
  }

  return {
    member,
    mode: targets.mode,
    majorTarget: targets.majorTarget,
    minorTarget: targets.minorTarget,
    lineTarget: targets.lineTarget,
    minorFloor: targets.minorFloor,
    majorIndex,
    minorIndex,
    ownContributionIndex,
    minorOwnContribution,
    minorRequiredTarget,
    branchTargets,
    effectiveTotals,
    lineTotal: effectiveTotals[0] + effectiveTotals[1],
    subMembers,
    branches,
    deficits,
    achieved,
    priority,
    candidate,
    branchCandidates,
    placements,
    placementCodes,
    feasible,
    warnings,
  };
}

function shallowestClosingDescendant(start, children, closingSet) {
  const queue = (Array.isArray(start) ? start : [start]).filter(Boolean);
  if (!queue.length) return null;
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

// 계획 노드가 calculatePerformance에 넘길 목표.
// 최상위는 사용자가 직접 넣은 대·소실적, 하위는 라인 합계 목표 + 소실적 기준선.
export function nodeTargets(node) {
  return node.mode === "sides"
    ? { majorTarget: node.majorTarget, minorTarget: node.minorTarget }
    : { lineTarget: node.lineTarget, minorFloor: node.minorFloor };
}

export function nodeHasTarget(node) {
  return node.mode === "sides"
    ? node.majorTarget + node.minorTarget > 0
    : node.lineTarget > 0 || node.minorFloor > 0;
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

  const allocate = (member, targets, depth, autoTargets) => {
    const subMembers = balancedLines(model, member);
    const branches = subMembers.map(groupBranchBreakdown);
    const own = Math.max(0, numeric(member.ordPv));
    const ownContributionIndex = branches[0].total < branches[1].total ? 0 : 1;
    const effectiveTotals = branches.map(
      (branch, index) =>
        branch.total + (index === ownContributionIndex ? own : 0),
    );
    const majorIndex = effectiveTotals[0] >= effectiveTotals[1] ? 0 : 1;
    const minorIndex = majorIndex === 0 ? 1 : 0;

    // 대실적·소실적을 따로 입력받은 경우("sides") 그대로 각 라인에 배정하고,
    // 아니면 "라인 합계" 하나를 두 라인의 부족분으로 나눈다("total").
    const useSidesMode = targets.majorTarget != null && targets.minorTarget != null;
    const lineGoals = [];
    if (useSidesMode) {
      lineGoals[majorIndex] = Math.max(targets.majorTarget, targets.minorFloor);
      lineGoals[minorIndex] = Math.max(targets.minorTarget, targets.minorFloor);
    } else {
      const need = distributeLineDeficit(
        effectiveTotals,
        targets.lineTarget,
        targets.minorFloor,
        {
          placeable: subMembers.map(
            (subMember, index) =>
              subMember.length > 0 || index === ownContributionIndex,
          ),
        },
      );
      lineGoals[0] = effectiveTotals[0] + need[0];
      lineGoals[1] = effectiveTotals[1] + need[1];
    }

    const lines = [0, 1].map((index) => {
      const subMember = subMembers[index];
      const ownHere = index === ownContributionIndex ? own : 0;
      const closer = subMember
        ? shallowestClosingDescendant(subMember, model.children, closingSet)
        : null;
      if (!closer) {
        return {
          index,
          lineTarget: lineGoals[index],
          passthroughNv: branches[index].total + ownHere,
          childAllocation: null,
        };
      }
      const passthroughNv =
        branches[index].total - branchBreakdown(closer).total + ownHere;
      const autoLineTarget = Math.max(0, lineGoals[index] - passthroughNv);
      const autoMinorFloor = minorPayoutFloor(closer);
      const override = overrides[memberId(closer)];
      const overrideUsesSides =
        override && override.majorTarget != null && override.minorTarget != null;
      const childMinorFloor =
        override && override.minorFloor != null
          ? Math.max(0, numeric(override.minorFloor))
          : autoMinorFloor;
      const childTargets = overrideUsesSides
        ? {
            majorTarget: Math.max(0, numeric(override.majorTarget)),
            minorTarget: Math.max(0, numeric(override.minorTarget)),
            minorFloor: childMinorFloor,
          }
        : {
            lineTarget:
              override && override.lineTarget != null
                ? Math.max(0, numeric(override.lineTarget))
                : autoLineTarget,
            minorFloor: childMinorFloor,
          };
      return {
        index,
        lineTarget: lineGoals[index],
        passthroughNv,
        childAllocation: allocate(
          closer,
          childTargets,
          depth + 1,
          { lineTarget: autoLineTarget, minorFloor: autoMinorFloor },
        ),
      };
    });

    const autoLineTarget = autoTargets?.lineTarget ?? targets.lineTarget ?? 0;
    const autoMinorFloor = autoTargets?.minorFloor ?? targets.minorFloor ?? 0;
    return {
      memberId: memberId(member),
      depth,
      mode: useSidesMode ? "sides" : "total",
      majorTarget: targets.majorTarget ?? 0,
      minorTarget: targets.minorTarget ?? 0,
      lineTarget: targets.lineTarget ?? 0,
      minorFloor: targets.minorFloor ?? 0,
      autoLineTarget,
      autoMinorFloor,
      overridden:
        depth > 0 &&
        (useSidesMode ||
          targets.lineTarget !== autoLineTarget ||
          targets.minorFloor !== autoMinorFloor),
      lineGoals,
      sourceTopMemberId: String(topMemberId),
      lines,
      childAllocations: lines
        .map((line) => line.childAllocation)
        .filter(Boolean),
    };
  };

  return allocate(
    topMember,
    {
      majorTarget,
      minorTarget,
      lineTarget: 0,
      minorFloor: minorPayoutFloor(topMember),
    },
    0,
  );
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
    if (!nodeHasTarget(node)) {
      return { memberId: node.memberId, allocation: node, skipped: true };
    }
    const result = calculatePerformance(
      model,
      node.memberId,
      nodeTargets(node),
    );
    const projection = projectClosingCompletion(result);
    const applied = projection.feasible !== false;
    if (applied) applyClosingCompletion(model, node.memberId, projection);
    return {
      memberId: node.memberId,
      allocation: node,
      result,
      projection,
      applied,
    };
  });
  const placements = steps.flatMap((step) => {
    if (!step.projection) return [];
    return step.projection.sales.map((sale) => ({
      closerMemberId: step.memberId,
      side: sale.side,
      placementKind: step.result.placements[sale.lineIndex].kind,
      placementMemberId: sale.memberId || null,
      salesWon: sale.salesWon,
      addedNv: sale.addedNv,
      excessNv: sale.excessNv,
    }));
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
