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

// ── 사람 단위 선택 ──
import { buildPersons, litPersonTree, codesOutsidePicks } from '../js/custom-tree-logic.js';
const pr = (userId, ppId, userName, abPos) => ({ userId, ppId, abPos, userName, ordPv: 0, maxPv: 0, minPv: 0 });
// 사람 A(100·101·102), 그 서브1 밑에 사람 B(200·201·202), 서브2 밑에 단독 코드 C(300), B 서브1 밑에 사람 D(400·401·402)
const pm = buildPerformanceModel({ members: [], rstLst: [
  pr('100','','A',1), pr('101','100','A',1), pr('102','100','A',2),
  pr('200','101','B',1), pr('201','200','B',1), pr('202','200','B',2),
  pr('300','102','C',1),
  pr('400','201','D',1), pr('401','400','D',1), pr('402','400','D',2),
] });
const persons = buildPersons(pm);
assert.deepEqual(persons.codes.get('100'), ['100','101','102']);
assert.deepEqual(persons.codes.get('300'), ['300']);
assert.equal(persons.personOf.get('402'), '400');
assert.deepEqual(persons.tops, ['100']);
assert.deepEqual(persons.children.get('100').map((r) => r.userId), ['200','300']);
assert.deepEqual(persons.children.get('200').map((r) => r.userId), ['400']);

// A, D만 켜면 B·C는 건너뛰고 D가 A 밑에 붙는다
const lit = litPersonTree(persons, new Set(['100','400']));
assert.deepEqual(lit.tops, ['100']);
assert.deepEqual(lit.children.get('100').map((r) => r.userId), ['400']);
// D만 켜면 D가 맨 위
assert.deepEqual(litPersonTree(persons, new Set(['400'])).tops, ['400']);
// 모델에 없는 번호는 무시
assert.deepEqual([...litPersonTree(persons, new Set(['ZZ'])).keep], []);
// 켜지 않은 사람의 코드 3개가 모두 제외 집합에 들어간다
const out = codesOutsidePicks(persons, new Set(['100','400']));
assert.deepEqual([...out].sort(), ['200','201','202','300']);
// 그 집합으로 기존 표시 로직(visibleChildrenMap)을 쓰면 D의 코드가 A의 서브 코드 밑에 붙는다
assert.deepEqual(visibleChildrenMap(pm, out, '100').get('101').map((r) => r.userId), ['400']);
console.log('Person selection tests passed: 3-code bodies, lit-only tree, promotion, outside codes.');
