import assert from 'node:assert/strict';
import { buildPerformanceModel, planBalancedSplit } from '../js/performance-calculator.js';
import { buildPersons } from '../js/custom-tree-logic.js';
import { planSelectiveSplit } from '../js/selective-split.js';

const row = (userId, ppId, userName, extra = {}) => ({ userId, ppId, abPos: 0, userName, ordPv: 0, maxPv: 0, minPv: 0, rankName: 'GD', rankMaxName: 'GD', ...extra });
// 사람 T(100·101·102), T의 서브1(101) 밑에 사람 A(200·201·202), 서브2(102) 밑에 사람 B(300·301·302)
const model = buildPerformanceModel({ members: [], rstLst: [
  row('100', '', 'T'), row('101', '100', 'T'), row('102', '100', 'T'),
  row('200', '101', 'A'), row('201', '200', 'A', { ordPv: 40000 }), row('202', '200', 'A'),
  row('300', '102', 'B'), row('301', '300', 'B'), row('302', '300', 'B'),
] });
const persons = buildPersons(model);
const sum = (plan) => [...plan.placed.values()].reduce((s, u) => s + u, 0);

// 1) 옵션 없이 쓰면 기존 균형 추천(planBalancedSplit)과 같은 결과
for (const [root, deficit] of [['101', 300000], ['102', 123456], ['200', 80000]]) {
  const mine = planSelectiveSplit(model, persons, { lineRootId: root, deficitNv: deficit });
  const base = planBalancedSplit(model, root, deficit);
  const baseMap = Object.fromEntries(base.placements.map((p) => [p.memberId, p.salesWon / 1000]));
  assert.deepEqual(Object.fromEntries(mine.placed), baseMap, `root ${root}`);
}

// 2) 합계는 항상 필요 단위와 같고, 한 곳 최소 1만원
const plan = planSelectiveSplit(model, persons, { lineRootId: '100', deficitNv: 500000 });
assert.equal(sum(plan), plan.totalWon / 1000);
assert.ok([...plan.placed.values()].every((u) => u >= 10));

// 3) 제외한 코드에는 넣지 않고, 나머지로 계속 나눈다
const ex = planSelectiveSplit(model, persons, { lineRootId: '200', deficitNv: 200000, takeable: (c) => !['201'].includes(c) });
assert.equal(sum(ex), ex.totalWon / 1000);
assert.ok(!ex.placed.has('201'));
assert.ok(ex.placed.has('202') || ex.placed.has('200'));

// 4) 사업자(불 켠 코드)만 지정하면 그곳에만 넣는다
const only = planSelectiveSplit(model, persons, { lineRootId: '100', deficitNv: 300000, takeable: (c) => ['301', '302'].includes(c) });
assert.ok([...only.placed.keys()].every((c) => ['301', '302'].includes(c)), JSON.stringify([...only.placed]));
assert.equal(sum(only), only.totalWon / 1000);

// 5) 받을 수 있는 코드가 라인 아래에 없으면 null
assert.equal(planSelectiveSplit(model, persons, { lineRootId: '101', deficitNv: 100000, takeable: (c) => c === '302' }), null);
assert.equal(planSelectiveSplit(model, persons, { lineRootId: '101', deficitNv: 0 }), null);

// 6) 사람 단위로만 균형: 서브 코드(101) 밑 두 사람(A,B가 아니라 이 예에서는 A 한 명)... 서브 코드에서 균형 없이 반반
const model2 = buildPerformanceModel({ members: [], rstLst: [
  row('100', '', 'T'), row('101', '100', 'T'), row('102', '100', 'T'),
  row('200', '101', 'A', { minPv: 100000 }), row('201', '200', 'A'), row('202', '200', 'A'),
  row('300', '101', 'B'), row('301', '300', 'B'), row('302', '300', 'B'),
] });
const persons2 = buildPersons(model2);
const bal = planSelectiveSplit(model2, persons2, { lineRootId: '101', deficitNv: 200000 });
const even = planSelectiveSplit(model2, persons2, { lineRootId: '101', deficitNv: 200000, personOnly: true });
const aBal = ['200', '201', '202'].reduce((s, c) => s + (bal.placed.get(c) || 0), 0);
const bBal = ['300', '301', '302'].reduce((s, c) => s + (bal.placed.get(c) || 0), 0);
const aEven = ['200', '201', '202'].reduce((s, c) => s + (even.placed.get(c) || 0), 0);
const bEven = ['300', '301', '302'].reduce((s, c) => s + (even.placed.get(c) || 0), 0);
assert.ok(bBal > aBal, `균형은 작은 쪽(B)을 먼저 채운다: A ${aBal} / B ${bBal}`);
assert.ok(Math.abs(aEven - bEven) <= 1, `사람 단위로만은 서브 코드 밑 두 사람에게 반반: A ${aEven} / B ${bEven}`);
console.log('Selective split tests passed: same as balanced, exclusions, lit-only, person-only even split.');
