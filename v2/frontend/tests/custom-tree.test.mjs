import assert from 'node:assert/strict';
import { visibleChildrenMap, activeExclusions } from '../js/custom-tree-logic.js';
import { buildPerformanceModel, planSixtyKSplit } from '../js/performance-calculator.js';

const row = (userId, ppId, abPos, extra = {}) => ({ userId, ppId, abPos, userName: userId, ordPv: 0, maxPv: 0, minPv: 0, ...extra });
const model = buildPerformanceModel({
  rstLst: [row('A', ''), row('B', 'A', 'L'), row('C', 'A', 'R'), row('D', 'B', 'L'), row('E', 'B', 'R'), row('F', 'D', 'L')],
  members: [],
});
const ids = (map, id) => (map.get(id) || []).map((r) => r.userId);

// 제외 없음: 원래 구조 그대로
assert.deepEqual(ids(visibleChildrenMap(model, new Set(), 'A'), 'A'), ['B', 'C']);
// B 제외: B의 하위 D, E가 A 밑으로 붙고 C는 그대로 남는다
const noB = visibleChildrenMap(model, new Set(['B']), 'A');
assert.deepEqual(ids(noB, 'A'), ['D', 'E', 'C']);
assert.equal(noB.has('B'), false);
// 연속 제외: B, D 제외하면 F가 A 밑까지 올라온다
assert.deepEqual(ids(visibleChildrenMap(model, new Set(['B', 'D']), 'A'), 'A'), ['F', 'E', 'C']);
// 맨 위 기준 회원은 제외해도 사라지지 않는다
assert.deepEqual(ids(visibleChildrenMap(model, new Set(['A']), 'A'), 'A'), ['B', 'C']);
// 모델 원본은 바뀌지 않는다
assert.deepEqual(model.children.get('A').map((r) => r.userId), ['B', 'C']);
// 수집 자료에 없는 번호는 걷어낸다
assert.deepEqual([...activeExclusions(model, new Set(['B', 'ZZ']))], ['B']);

// 추천은 제외한 회원에게 매출을 넣지 않는다
const big = buildPerformanceModel({
  rstLst: [row('P', ''), row('Q', 'P', 'L', { minPv: 50000, maxPv: 50000 }), row('R', 'Q', 'L'), row('S', 'Q', 'R')],
  members: [],
});
const plan = planSixtyKSplit(big, 'Q', 17599, [], new Set(['Q', 'R']));
if (plan) assert.ok(plan.placements.every((p) => !['Q', 'R'].includes(String(p.memberId))));
const none = planSixtyKSplit(big, 'Q', 17599, [], new Set(['Q', 'R', 'S']));
assert.equal(none, null);

console.log('Custom tree tests passed: exclusion re-parenting, root kept, model untouched, planner skips excluded.');
