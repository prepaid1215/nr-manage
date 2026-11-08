import assert from 'node:assert/strict';
import { buildPerformanceModel, planBalancedSplit } from '../js/performance-calculator.js';

const row = (userId, ppId, abPos, extra = {}) => ({ userId, ppId, abPos, userName: userId, ordPv: 0, maxPv: 0, minPv: 0, rankName: 'GD', rankMaxName: 'GD', ...extra });
// L 밑에 두 라인(X, Y). X는 이미 큼, Y는 비어 있음. 아래로 각각 두 칸씩.
const model = buildPerformanceModel({
  rstLst: [row('L', ''), row('X', 'L', 'L', { ordPv: 40000 }), row('Y', 'L', 'R'), row('X1', 'X', 'L'), row('X2', 'X', 'R'),
    row('Y1', 'Y', 'L'), row('Y2', 'Y', 'R')],
  members: [],
});
const sum = (plan) => plan.placements.reduce((s, p) => s + p.salesWon, 0);

// 합계는 항상 부족분을 1,000원 단위로 올린 금액과 같다
const plan = planBalancedSplit(model, 'L', 300000);
assert.equal(sum(plan), plan.totalWon);
assert.ok(plan.placements.every((p) => p.salesWon >= 10000));
// 작은 쪽(Y 라인)을 먼저 채워 X 라인과 같아지게 한 뒤, 남은 금액은 양쪽에 나눈다 → 두 라인이 거의 같아진다
const nvOf = (id) => (plan.placements.find((p) => p.memberId === id)?.addedNv ?? 0);
const lineX = 40000 + nvOf('X') + nvOf('X1') + nvOf('X2');
const lineY = nvOf('Y') + nvOf('Y1') + nvOf('Y2');
assert.ok(Math.abs(lineX - lineY) <= 3 * 810, `${lineX} vs ${lineY}`);
assert.ok(lineY > 0);
// 한 박스에 몰리지 않는다: 네 칸 모두에 들어가고 각 라인 안에서도 고르게 나뉜다
assert.ok(['X1', 'X2', 'Y1', 'Y2'].every((id) => nvOf(id) > 0), JSON.stringify(plan.placements));
assert.ok(Math.abs(nvOf('Y1') - nvOf('Y2')) <= 2 * 810, JSON.stringify(plan.placements));

// 제외한 회원에게는 넣지 않고 가까운 윗사람 쪽으로 올린다
const skipped = planBalancedSplit(model, 'L', 300000, new Set(['Y1', 'Y2']));
assert.equal(sum(skipped), skipped.totalWon);
assert.ok(skipped.placements.every((p) => !['Y1', 'Y2'].includes(p.memberId)), JSON.stringify(skipped.placements));
// 전부 제외하면 추천 불가
assert.equal(planBalancedSplit(model, 'L', 300000, new Set(['L', 'X', 'Y', 'X1', 'X2', 'Y1', 'Y2'])), null);
assert.equal(planBalancedSplit(model, 'L', 0), null);
// 부족분이 작으면 한 곳에만 넣는다(1만원 미만으로 쪼개지 않는다)
const small = planBalancedSplit(model, 'L', 9000);
assert.ok(small.placements.length >= 1 && small.placements.every((p) => p.salesWon >= 10000));
console.log('Balanced split tests passed: weaker line first, even split downward, exclusions, min piece.');

// 제외 때문에 윗사람에게 합쳐지면 그 사실이 결과에 남는다
const merged = planBalancedSplit(model, 'L', 300000, new Set(['X1', 'X2', 'Y1', 'Y2']));
assert.ok(merged.redirected && Object.keys(merged.redirected).length > 0, JSON.stringify(merged.redirected));
assert.deepEqual(planBalancedSplit(model, 'L', 300000).redirected, {});
console.log('Balanced split redirect info passed.');

// 한쪽 라인이 전부 제외돼도 그만큼을 합치지 않고, 같은 라인의 제외하지 않은 다른 회원들에게 계속 나눠 준다
const sideOut = planBalancedSplit(model, 'L', 300000, new Set(['X1', 'X2', 'Y1']));
assert.equal(sum(sideOut), sideOut.totalWon);
assert.ok(sideOut.placements.every((p) => !['X1', 'X2', 'Y1'].includes(p.memberId)), JSON.stringify(sideOut.placements));
assert.ok(sideOut.placements.some((p) => p.memberId === 'Y2'), JSON.stringify(sideOut.placements));
assert.ok(sideOut.placements.length >= 2, JSON.stringify(sideOut.placements));
console.log('Balanced split continues among non-excluded members.');
