// 추천·제외 탭의 계산: 균형 분산 + (제외·사업자 표시) + (사람 단위로만 균형).
// planBalancedSplit(performance-calculator.js)과 같은 규칙에 아래 세 가지를 더한 별도 함수다.
//  - takeable(코드): false인 코드는 매출을 받지 않고 건너뛴다(그 몫은 아래로, 같은 라인의 다른 쪽으로 이어진다).
//  - 건너뛴 코드에서는 균형을 따지지 않고 반반으로 아래로 보낸다.
//  - personOnly: 서브 코드(서브1·서브2) 밑 두 사람에게는 균형을 따지지 않고 반반으로 나눈다.
// 1,000원 = 810 NV, 한 곳에 넣는 금액은 최소 1만원(10단위)이다.

const UNIT_NV = 810;
const MIN_UNITS = 10;
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function planSelectiveSplit(model, persons, options) {
  const { lineRootId, deficitNv, salesNv = {}, takeable = () => true, personOnly = false } = options;
  const deficit = Math.max(0, num(deficitNv));
  if (deficit <= 0) return null;
  const root = String(lineRootId);
  if (!model.byId.has(root)) return null;
  const units = Math.max(MIN_UNITS, Math.ceil(deficit / UNIT_NV));

  const kidsOf = (id) => (model.children.get(String(id)) || []).slice(0, 2).map((row) => String(row.userId));
  const ownOf = (id) => num(model.byId.get(id)?.ordPv);
  const isSubCode = (id) => {
    const key = persons.personOf.get(id);
    const list = key ? persons.codes.get(key) : null;
    return Boolean(list && list.length === 3 && id !== list[0]);
  };
  const placed = new Map();
  const trace = [];

  const hasTakeable = (id) => takeable(id) || kidsOf(id).some(hasTakeable);
  const salesBelow = (id) => {
    let sum = num(salesNv[id]) + (placed.get(id) || 0) * UNIT_NV;
    kidsOf(id).forEach((kid) => {
      sum += salesBelow(kid);
    });
    return sum;
  };
  const lineTotal = (id) => {
    const row = model.byId.get(id);
    return num(row.ordPv) + num(row.maxPv) + num(row.minPv) + salesBelow(id);
  };
  const add = (id, amount) => placed.set(id, (placed.get(id) || 0) + amount);
  const mergeSmall = (amounts) => {
    [0, 1].forEach((side) => {
      if (amounts[side] > 0 && amounts[side] < MIN_UNITS && amounts[1 - side] > 0) {
        amounts[1 - side] += amounts[side];
        amounts[side] = 0;
      }
    });
  };

  // 반환값: 이 아래에서 넣지 못하고 남은 단위
  const distribute = (id, amount, depth) => {
    if (amount <= 0) return 0;
    const kids = kidsOf(id);
    const mine = takeable(id);
    const avail = [Boolean(kids[0] && hasTakeable(kids[0])), Boolean(kids[1] && hasTakeable(kids[1]))];
    if (!kids.length || depth > 80 || (!avail[0] && !avail[1])) {
      if (mine) {
        add(id, amount);
        trace.push({ id, units: amount, end: true, depth });
        return 0;
      }
      return amount;
    }
    const split = [0, 1].map(() => 0);
    let kind;
    if (!mine || (personOnly && isSubCode(id))) {
      kind = !mine ? "skip-even" : "person-even";
      if (avail[0] && avail[1]) {
        split[0] = Math.ceil(amount / 2);
        split[1] = amount - split[0];
      } else if (avail[0]) split[0] = amount;
      else split[1] = amount;
    } else {
      const lines = [kids[0] ? lineTotal(kids[0]) : 0, kids[1] ? lineTotal(kids[1]) : 0];
      const own = ownOf(id) + num(salesNv[id]) + (placed.get(id) || 0) * UNIT_NV;
      const smaller = lines[0] < lines[1] ? 0 : 1; // 본인 NV는 작은 쪽(같으면 서브2)에 합산
      const sums = [lines[0] + (smaller === 0 ? own : 0), lines[1] + (smaller === 1 ? own : 0)];
      const weak = sums[0] < sums[1] ? 0 : 1;
      const gapUnits = Math.ceil(Math.abs(sums[0] - sums[1]) / UNIT_NV);
      const toWeak = Math.min(amount, gapUnits);
      const rest = amount - toWeak;
      split[weak] = toWeak + Math.ceil(rest / 2);
      split[1 - weak] = Math.floor(rest / 2);
      kind = "balance";
    }
    mergeSmall(split);
    trace.push({ id, units: amount, split: split.slice(), kids, kind, depth });
    let unplaced = 0;
    [0, 1].forEach((side) => {
      if (split[side] <= 0) return;
      if (kids[side] && avail[side]) {
        let left = distribute(kids[side], split[side], depth + 1);
        if (left > 0 && kids[1 - side] && avail[1 - side]) left = distribute(kids[1 - side], left, depth + 1);
        unplaced += left;
      } else if (mine) add(id, split[side]);
      else if (kids[1 - side] && avail[1 - side]) unplaced += distribute(kids[1 - side], split[side], depth + 1);
      else unplaced += split[side];
    });
    if (unplaced > 0 && mine) {
      add(id, unplaced);
      return 0;
    }
    return unplaced;
  };

  const leftover = distribute(root, units, 0);
  if (leftover > 0) {
    let fallback = null;
    const walk = (id) => {
      if (fallback) return;
      if (takeable(id)) {
        fallback = id;
        return;
      }
      kidsOf(id).forEach(walk);
    };
    walk(root);
    if (!fallback) return null;
    add(fallback, leftover);
  }
  const entries = [...placed.entries()].filter(([, amount]) => amount > 0);
  if (entries.length > 1) {
    const largest = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    entries.forEach((entry) => {
      if (entry !== largest && entry[1] < MIN_UNITS) {
        largest[1] += entry[1];
        entry[1] = 0;
      }
    });
  }
  const result = new Map(entries.filter(([, amount]) => amount > 0));
  return { placed: result, trace, totalWon: units * 1000 };
}
