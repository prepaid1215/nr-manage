import assert from "node:assert/strict";
import {
  allocateClosingTargets,
  applyClosingCompletion,
  buildPerformanceModel,
  calculatePerformance,
  cancelClosingCompletion,
  cancelCompletionCascade,
  planClosing,
  planSignature,
  projectClosingCompletion,
  pruneInvalidCompletions,
  salesTopUpForDeficit,
  sortMembersDeepestFirst,
} from "../js/performance-calculator.js";

assert.deepEqual(salesTopUpForDeficit(0), {
  salesWon: 0,
  addedNv: 0,
  excessNv: 0,
});
assert.deepEqual(salesTopUpForDeficit(1), {
  salesWon: 10000,
  addedNv: 8100,
  excessNv: 8099,
});
assert.deepEqual(salesTopUpForDeficit(8100), {
  salesWon: 10000,
  addedNv: 8100,
  excessNv: 0,
});
assert.deepEqual(salesTopUpForDeficit(8101), {
  salesWon: 11000,
  addedNv: 8910,
  excessNv: 809,
});
assert.deepEqual(salesTopUpForDeficit(25959), {
  salesWon: 33000,
  addedNv: 26730,
  excessNv: 771,
});

const payload = {
  rstLst: [
    { userId: "root", userName: "루트", ppId: "", abPos: 0 },
    { userId: "sub-a", userName: "서브A", ppId: "root", abPos: 1 },
    { userId: "sub-b", userName: "서브B", ppId: "root", abPos: 2 },
    { userId: "leaf-a", userName: "A최하위", ppId: "sub-a", abPos: 1 },
  ],
  members: [
    { userId: "root", ordPv: 1000, maxPv: 30000, minPv: 17000 },
    { userId: "sub-a", ordPv: 10000, maxPv: 5000, minPv: 2000 },
    { userId: "sub-b", ordPv: 5000, maxPv: 20000, minPv: 5000 },
    { userId: "leaf-a", ordPv: 1000, maxPv: 0, minPv: 0 },
  ],
};

const model = buildPerformanceModel(payload);
const result = calculatePerformance(model, "root", 20000);

assert.deepEqual(
  result.branches.map((branch) => branch.total),
  [17000, 30000],
);
assert.deepEqual(result.deficits, [2000, 0]);
assert.deepEqual(result.effectiveTotals, [18000, 30000]);
assert.equal(result.priority, 0);
assert.equal(result.candidate.userId, "leaf-a");
assert.deepEqual(result.warnings, []);

const deepestModel = buildPerformanceModel({
  rstLst: [
    { userId: "root", userName: "루트", ppId: "" },
    { userId: "short", userName: "얕은 회원", ppId: "root", abPos: 1 },
    { userId: "other", userName: "반대 라인", ppId: "root", abPos: 2 },
    { userId: "middle", userName: "중간 회원", ppId: "short", abPos: 2 },
    { userId: "deep", userName: "가장 아래 회원", ppId: "middle", abPos: 1 },
    {
      userId: "shallow",
      userName: "NV가 작은 얕은 회원",
      ppId: "short",
      abPos: 1,
    },
  ],
  members: [
    { userId: "root", ordPv: 0 },
    { userId: "short", ordPv: 1000 },
    { userId: "other", ordPv: 50000 },
    { userId: "middle", ordPv: 1000 },
    { userId: "deep", ordPv: 9000 },
    { userId: "shallow", ordPv: 0 },
  ],
});
const deepestResult = calculatePerformance(deepestModel, "root", 100000);
assert.equal(deepestResult.priority, 0);
assert.equal(deepestResult.candidate.userId, "deep");
assert.deepEqual(
  sortMembersDeepestFirst(deepestModel, ["root", "short", "deep"]).map(
    (row) => row.userId,
  ),
  ["deep", "short", "root"],
);

const unequalTargetModel = buildPerformanceModel({
  rstLst: [
    { userId: "root", userName: "루트", ppId: "" },
    { userId: "major", userName: "대실적", ppId: "root", abPos: 1 },
    { userId: "minor", userName: "소실적", ppId: "root", abPos: 2 },
  ],
  members: [
    { userId: "root", ordPv: -92924, maxPv: 248265, minPv: 97200 },
    { userId: "major", ordPv: 248265, maxPv: 0, minPv: 0 },
    { userId: "minor", ordPv: 97200, maxPv: 0, minPv: 0 },
  ],
});
const unequalResult = calculatePerformance(unequalTargetModel, "root", {
  majorTarget: 300000,
  minorTarget: 150000,
});
assert.equal(unequalResult.majorIndex, 0);
assert.equal(unequalResult.minorIndex, 1);
assert.deepEqual(unequalResult.branchTargets, [300000, 150000]);
assert.deepEqual(unequalResult.deficits, [51735, 52800]);
assert.equal(unequalResult.priority, 1);

const screenshotResult = calculatePerformance(unequalTargetModel, "root", {
  majorTarget: 200000,
  minorTarget: 200000,
});
assert.deepEqual(screenshotResult.deficits, [0, 102800]);
assert.equal(screenshotResult.priority, 1);

const achievedResult = calculatePerformance(unequalTargetModel, "root", {
  majorTarget: 200000,
  minorTarget: 90000,
});
assert.equal(achievedResult.achieved, true);
assert.equal(achievedResult.priority, null);
assert.equal(achievedResult.candidate, null);

const ownNvResult = calculatePerformance(
  buildPerformanceModel({
    rstLst: [
      { userId: "root", userName: "한수진", ppId: "" },
      { userId: "major", userName: "서브1", ppId: "root", abPos: 1 },
      { userId: "minor", userName: "서브2", ppId: "root", abPos: 2 },
    ],
    members: [
      { userId: "root", ordPv: 105300 },
      { userId: "major", ordPv: 118908, maxPv: 177876, minPv: 88776 },
      { userId: "minor", ordPv: 16200, maxPv: 252541, minPv: 0 },
    ],
  }),
  "root",
  { majorTarget: 400000, minorTarget: 400000 },
);
assert.equal(ownNvResult.minorRequiredTarget, 294700);
assert.deepEqual(ownNvResult.effectiveTotals, [385560, 374041]);
assert.deepEqual(ownNvResult.deficits, [14440, 25959]);
const ownNvCompletion = projectClosingCompletion(ownNvResult);
assert.deepEqual(ownNvCompletion.topUps, [
  { salesWon: 18000, addedNv: 14580, excessNv: 140 },
  { salesWon: 33000, addedNv: 26730, excessNv: 771 },
]);
assert.equal(ownNvCompletion.majorNv, 400140);
assert.equal(ownNvCompletion.minorNv, 400771);
assert.equal(ownNvCompletion.completedNv, 800911);

const propagationModel = buildPerformanceModel({
  rstLst: [
    { userId: "parent", userName: "상위", ppId: "" },
    { userId: "root", userName: "한수진", ppId: "parent", abPos: 1 },
    { userId: "other", userName: "반대 라인", ppId: "parent", abPos: 2 },
  ],
  members: [
    { userId: "parent", ordPv: 0 },
    { userId: "root", ordPv: 105300, maxPv: 248265, minPv: 97200 },
    { userId: "other", ordPv: 100000 },
  ],
});
applyClosingCompletion(propagationModel, "root", ownNvCompletion);
const propagatedResult = calculatePerformance(
  propagationModel,
  "parent",
  1000000,
);
assert.equal(propagatedResult.branches[0].total, 800911);
assert.equal(propagatedResult.branches[0].completed, true);
assert.equal(propagatedResult.majorIndex, 0);

const deepPropagationModel = buildPerformanceModel({
  rstLst: [
    { userId: "top", userName: "한수진", ppId: "" },
    { userId: "line", userName: "중간 라인", ppId: "top", abPos: 1 },
    { userId: "other", userName: "반대 라인", ppId: "top", abPos: 2 },
    { userId: "closer", userName: "주영돈", ppId: "line", abPos: 1 },
  ],
  members: [
    { userId: "top", ordPv: 0 },
    { userId: "line", ordPv: 100000, maxPv: 200000, minPv: 100000 },
    { userId: "other", ordPv: 300000 },
    { userId: "closer", ordPv: 100000, maxPv: 100000, minPv: 100000 },
  ],
});
applyClosingCompletion(deepPropagationModel, "closer", {
  majorNv: 400545,
  minorNv: 400140,
});
assert.equal(
  deepPropagationModel.byId.get("line").closingDescendantDeltaNv,
  500685,
);
const deepPropagatedResult = calculatePerformance(
  deepPropagationModel,
  "top",
  1000000,
);
assert.equal(deepPropagatedResult.branches[0].total, 900685);
assert.equal(deepPropagatedResult.effectiveTotals[0], 900685);

const oneLineModel = buildPerformanceModel({
  rstLst: [
    { userId: "gd", userName: "주윤돈", ppId: "" },
    { userId: "member", userName: "김민제", ppId: "gd", abPos: 1 },
  ],
  members: [
    { userId: "gd", ordPv: 120000 },
    { userId: "member", ordPv: 100000 },
  ],
});
const oneLineResult = calculatePerformance(oneLineModel, "gd", 150000);
assert.deepEqual(oneLineResult.effectiveTotals, [100000, 120000]);
assert.equal(oneLineResult.majorIndex, 1);
assert.equal(oneLineResult.minorIndex, 0);
assert.deepEqual(oneLineResult.deficits, [50000, 30000]);

const emptyLineModel = buildPerformanceModel({
  rstLst: [{ userId: "solo", userName: "단독", ppId: "" }],
  members: [{ userId: "solo", ordPv: 1000, maxPv: 0, minPv: 0 }],
});
const emptyLineResult = calculatePerformance(emptyLineModel, "solo", 20000);
assert.deepEqual(emptyLineResult.deficits, [20000, 19000]);
assert.equal(emptyLineResult.candidate, null);
assert.throws(
  () => calculatePerformance(emptyLineModel, "solo", 0),
  /0보다 커야/,
);

console.log("performance calculator tests passed");

// ───────────────────────── TC01 — 하위 라인 0개: 마감 불가 ─────────────────────────
const tc01Model = buildPerformanceModel({
  rstLst: [{ userId: "solo", userName: "단독", ppId: "" }],
  members: [{ userId: "solo", ordPv: 1000 }],
});
const tc01 = calculatePerformance(tc01Model, "solo", 20000);
assert.equal(tc01.feasible, false);
assert.equal(tc01.placements[0].kind, "none");
assert.equal(tc01.placements[1].kind, "self");
assert.equal(tc01.placements[1].target.userId, "solo");
const tc01Projection = projectClosingCompletion(tc01);
assert.equal(tc01Projection.feasible, false);
assert.equal(tc01Projection.completedNv, 0);
assert.throws(
  () => applyClosingCompletion(tc01Model, "solo", tc01Projection),
  /올바르지 않습니다/,
);

// ─────────────────── TC02 — 일반 회원 하위 한 줄: 배치 위치 명시 ───────────────────
const tc02Model = buildPerformanceModel({
  rstLst: [
    { userId: "gd", userName: "GD", ppId: "" },
    { userId: "regular-b", userName: "일반B", ppId: "gd", abPos: 1 },
  ],
  members: [
    { userId: "gd", ordPv: 20000 },
    { userId: "regular-b", ordPv: 80000 },
  ],
});
const tc02 = calculatePerformance(tc02Model, "gd", 200000);
assert.deepEqual(tc02.effectiveTotals, [80000, 20000]);
assert.deepEqual(tc02.deficits, [120000, 180000]);
assert.equal(tc02.feasible, true);
assert.equal(tc02.placements[0].kind, "line");
assert.equal(tc02.placements[0].target.userId, "regular-b");
assert.equal(tc02.placements[1].kind, "self");
assert.equal(tc02.placements[1].target.userId, "gd");
const tc02Projection = projectClosingCompletion(tc02);
assert.deepEqual(tc02Projection.topUps, [
  { salesWon: 149000, addedNv: 120690, excessNv: 690 },
  { salesWon: 223000, addedNv: 180630, excessNv: 630 },
]);
assert.equal(tc02Projection.majorNv, 200690);
assert.equal(tc02Projection.minorNv, 200630);
assert.equal(tc02Projection.completedNv, 401320);

// ──────────────── TC03 — 마감 사업자 하위 한 줄: 2단계 순차 마감 ────────────────
const tc03Model = buildPerformanceModel({
  rstLst: [
    { userId: "parent-gd", userName: "상위GD", ppId: "" },
    { userId: "child-gd", userName: "하위GD", ppId: "parent-gd", abPos: 1 },
    { userId: "d", userName: "D", ppId: "child-gd", abPos: 1 },
    { userId: "e", userName: "E", ppId: "child-gd", abPos: 2 },
  ],
  members: [
    { userId: "parent-gd", ordPv: 20000 },
    { userId: "child-gd", ordPv: 30000, maxPv: 100000, minPv: 80000 },
    { userId: "d", ordPv: 100000 },
    { userId: "e", ordPv: 80000 },
  ],
});
const tc03Step1 = calculatePerformance(tc03Model, "child-gd", 200000);
assert.deepEqual(tc03Step1.effectiveTotals, [100000, 110000]);
assert.deepEqual(tc03Step1.deficits, [100000, 90000]);
const tc03Step1Projection = projectClosingCompletion(tc03Step1);
assert.equal(tc03Step1Projection.majorNv, 200720);
assert.equal(tc03Step1Projection.minorNv, 200440);
assert.equal(tc03Step1Projection.completedNv, 401160);
applyClosingCompletion(tc03Model, "child-gd", tc03Step1Projection);
assert.equal(
  tc03Model.byId.get("parent-gd").closingDescendantDeltaNv,
  191160,
);
const tc03Step2 = calculatePerformance(tc03Model, "parent-gd", 400000);
assert.equal(tc03Step2.branches[0].completed, true);
assert.equal(tc03Step2.branches[0].total, 401160);
assert.deepEqual(tc03Step2.deficits, [0, 380000]);
assert.equal(tc03Step2.placements[1].kind, "self");
const tc03Step2Projection = projectClosingCompletion(tc03Step2);
assert.deepEqual(tc03Step2Projection.topUps[1], {
  salesWon: 470000,
  addedNv: 380700,
  excessNv: 700,
});
assert.equal(tc03Step2Projection.majorNv, 401160);
assert.equal(tc03Step2Projection.minorNv, 400700);
assert.equal(tc03Step2Projection.completedNv, 801860);

// ──────────────────── TC04 — 하위 두 줄 모두 일반 회원 ────────────────────
const tc04Model = buildPerformanceModel({
  rstLst: [
    { userId: "gd", userName: "GD", ppId: "" },
    { userId: "b", userName: "B", ppId: "gd", abPos: 1 },
    { userId: "c", userName: "C", ppId: "gd", abPos: 2 },
  ],
  members: [
    { userId: "gd", ordPv: 30000 },
    { userId: "b", ordPv: 100000 },
    { userId: "c", ordPv: 80000 },
  ],
});
const tc04 = calculatePerformance(tc04Model, "gd", 200000);
assert.deepEqual(tc04.effectiveTotals, [100000, 110000]);
assert.deepEqual(tc04.deficits, [100000, 90000]);
assert.equal(tc04.placements[0].target.userId, "b");
assert.equal(tc04.placements[1].target.userId, "c");
const tc04Projection = projectClosingCompletion(tc04);
assert.equal(tc04Projection.majorNv, 200720);
assert.equal(tc04Projection.minorNv, 200440);
assert.equal(tc04Projection.completedNv, 401160);

// ──────── TC05 — 한쪽만 마감 사업자: 일반 회원 라인에도 매출 배치 ────────
const tc05Payload = {
  rstLst: [
    { userId: "gd-a", userName: "GD_A", ppId: "" },
    { userId: "b-closer", userName: "B마감", ppId: "gd-a", abPos: 1 },
    { userId: "c-regular", userName: "C일반", ppId: "gd-a", abPos: 2 },
    { userId: "d", userName: "D", ppId: "b-closer", abPos: 1 },
    { userId: "e", userName: "E", ppId: "b-closer", abPos: 2 },
    { userId: "f", userName: "F", ppId: "c-regular", abPos: 1 },
  ],
  members: [
    { userId: "gd-a", ordPv: 50000 },
    { userId: "b-closer", ordPv: 20000, maxPv: 100000, minPv: 80000 },
    { userId: "c-regular", ordPv: 60000, maxPv: 20000, minPv: 0 },
    { userId: "d", ordPv: 100000 },
    { userId: "e", ordPv: 80000 },
    { userId: "f", ordPv: 20000 },
  ],
};
const tc05Model = buildPerformanceModel(tc05Payload);
const tc05Step1 = calculatePerformance(tc05Model, "b-closer", 200000);
assert.deepEqual(tc05Step1.effectiveTotals, [100000, 100000]);
assert.deepEqual(tc05Step1.deficits, [100000, 100000]);
const tc05Step1Projection = projectClosingCompletion(tc05Step1);
assert.equal(tc05Step1Projection.completedNv, 400880);
applyClosingCompletion(tc05Model, "b-closer", tc05Step1Projection);
const tc05Step2 = calculatePerformance(tc05Model, "gd-a", 400000);
assert.deepEqual(tc05Step2.effectiveTotals, [400880, 130000]);
assert.deepEqual(tc05Step2.deficits, [0, 270000]);
assert.equal(tc05Step2.placements[1].kind, "line");
assert.equal(tc05Step2.placements[1].target.userId, "f");
const tc05Step2Projection = projectClosingCompletion(tc05Step2);
assert.deepEqual(tc05Step2Projection.topUps[1], {
  salesWon: 334000,
  addedNv: 270540,
  excessNv: 540,
});
assert.equal(tc05Step2Projection.majorNv, 400880);
assert.equal(tc05Step2Projection.minorNv, 400540);
assert.equal(tc05Step2Projection.completedNv, 801420);

// ──────────────────── TC06 — 양쪽 모두 마감 사업자 ────────────────────
const tc06Payload = {
  rstLst: [
    { userId: "gd-a", userName: "GD_A", ppId: "" },
    { userId: "b-closer", userName: "B마감", ppId: "gd-a", abPos: 1 },
    { userId: "c-closer", userName: "C마감", ppId: "gd-a", abPos: 2 },
    { userId: "b1", userName: "B1", ppId: "b-closer", abPos: 1 },
    { userId: "b2", userName: "B2", ppId: "b-closer", abPos: 2 },
    { userId: "c1", userName: "C1", ppId: "c-closer", abPos: 1 },
    { userId: "c2", userName: "C2", ppId: "c-closer", abPos: 2 },
  ],
  members: [
    { userId: "gd-a", ordPv: 10000 },
    { userId: "b-closer", ordPv: 20000, maxPv: 80000, minPv: 60000 },
    { userId: "c-closer", ordPv: 15000, maxPv: 70000, minPv: 50000 },
    { userId: "b1", ordPv: 80000 },
    { userId: "b2", ordPv: 60000 },
    { userId: "c1", ordPv: 70000 },
    { userId: "c2", ordPv: 50000 },
  ],
};
const tc06Model = buildPerformanceModel(tc06Payload);
const tc06B = projectClosingCompletion(
  calculatePerformance(tc06Model, "b-closer", 200000),
);
assert.equal(tc06B.completedNv, 401380);
applyClosingCompletion(tc06Model, "b-closer", tc06B);
const tc06C = projectClosingCompletion(
  calculatePerformance(tc06Model, "c-closer", 200000),
);
assert.equal(tc06C.majorNv, 200410);
assert.equal(tc06C.minorNv, 200270);
assert.equal(tc06C.completedNv, 400680);
applyClosingCompletion(tc06Model, "c-closer", tc06C);
const tc06Top = calculatePerformance(tc06Model, "gd-a", 400000);
assert.deepEqual(tc06Top.effectiveTotals, [401380, 410680]);
assert.equal(tc06Top.majorIndex, 1);
assert.equal(tc06Top.achieved, true);
const tc06TopProjection = projectClosingCompletion(tc06Top);
assert.equal(tc06TopProjection.majorNv, 410680);
assert.equal(tc06TopProjection.minorNv, 401380);
assert.equal(tc06TopProjection.completedNv, 812060);

// ─────────── TC07 — 본인 매출 합산 후 대·소실적 역전 ───────────
const tc07Model = buildPerformanceModel({
  rstLst: [
    { userId: "gd", userName: "GD", ppId: "" },
    { userId: "b", userName: "B", ppId: "gd", abPos: 1 },
    { userId: "c", userName: "C", ppId: "gd", abPos: 2 },
  ],
  members: [
    { userId: "gd", ordPv: 100000 },
    { userId: "b", ordPv: 150000 },
    { userId: "c", ordPv: 140000 },
  ],
});
const tc07 = calculatePerformance(tc07Model, "gd", 250000);
assert.equal(tc07.ownContributionIndex, 1);
assert.deepEqual(tc07.effectiveTotals, [150000, 240000]);
assert.equal(tc07.majorIndex, 1);
assert.deepEqual(tc07.deficits, [100000, 10000]);
const tc07Projection = projectClosingCompletion(tc07);
assert.equal(tc07Projection.majorNv, 250530);
assert.equal(tc07Projection.minorNv, 250440);
assert.equal(tc07Projection.completedNv, 500970);

// ──── TC08 — 다단계 상위 반영 + 완료된 마감 하위 배치 제외 ────
const tc08Model = buildPerformanceModel({
  rstLst: [
    { userId: "top", userName: "Top", ppId: "" },
    { userId: "mid", userName: "Mid", ppId: "top", abPos: 1 },
    { userId: "other", userName: "Other", ppId: "top", abPos: 2 },
    { userId: "bottom", userName: "Bottom마감", ppId: "mid", abPos: 1 },
    { userId: "d", userName: "D", ppId: "bottom", abPos: 1 },
    { userId: "e", userName: "E", ppId: "bottom", abPos: 2 },
  ],
  members: [
    { userId: "top", ordPv: 0 },
    { userId: "mid", ordPv: 50000, maxPv: 200000, minPv: 100000 },
    { userId: "other", ordPv: 300000 },
    { userId: "bottom", ordPv: 10000, maxPv: 100000, minPv: 80000 },
    { userId: "d", ordPv: 100000 },
    { userId: "e", ordPv: 80000 },
  ],
});
const tc08Bottom = projectClosingCompletion(
  calculatePerformance(tc08Model, "bottom", 200000),
);
assert.equal(tc08Bottom.majorNv, 200440);
assert.equal(tc08Bottom.minorNv, 200160);
assert.equal(tc08Bottom.completedNv, 400600);
applyClosingCompletion(tc08Model, "bottom", tc08Bottom);
assert.equal(tc08Model.byId.get("mid").closingDescendantDeltaNv, 210600);
assert.equal(tc08Model.byId.get("top").closingDescendantDeltaNv, 210600);
const tc08Top = calculatePerformance(tc08Model, "top", 1000000);
assert.equal(tc08Top.branches[0].total, 560600);
assert.deepEqual(tc08Top.deficits, [439400, 700000]);
assert.equal(tc08Top.placements[0].kind, "line");
assert.equal(tc08Top.placements[0].target.userId, "mid"); // 완료된 bottom 하위 제외
assert.equal(tc08Top.placements[1].target.userId, "other");
const tc08TopProjection = projectClosingCompletion(tc08Top);
assert.deepEqual(tc08TopProjection.topUps, [
  { salesWon: 543000, addedNv: 439830, excessNv: 430 },
  { salesWon: 865000, addedNv: 700650, excessNv: 650 },
]);
assert.equal(tc08TopProjection.completedNv, 2001080);

// TC09~TC11(1·8100·8101 NV 부족)와 TC12(초과 NV 상위 반영 800911)는
// 파일 상단의 salesTopUpForDeficit / ownNvCompletion 검증으로 커버됨.

// ─────────── TC13 — 하위 마감 취소 후 상위 원상복구 ───────────
const tc13Model = buildPerformanceModel({
  rstLst: [
    { userId: "gd-a", userName: "GD_A", ppId: "" },
    { userId: "child-gd", userName: "하위GD", ppId: "gd-a", abPos: 1 },
    { userId: "d", userName: "D", ppId: "child-gd", abPos: 1 },
    { userId: "e", userName: "E", ppId: "child-gd", abPos: 2 },
  ],
  members: [
    { userId: "gd-a", ordPv: 50000, maxPv: 200000, minPv: 80000 },
    { userId: "child-gd", ordPv: 20000, maxPv: 100000, minPv: 80000 },
    { userId: "d", ordPv: 100000 },
    { userId: "e", ordPv: 80000 },
  ],
});
applyClosingCompletion(tc13Model, "child-gd", {
  majorNv: 200720,
  minorNv: 200440,
});
assert.equal(tc13Model.byId.get("gd-a").closingDescendantDeltaNv, 201160);
cancelClosingCompletion(tc13Model, "child-gd");
assert.equal(tc13Model.byId.get("gd-a").closingDescendantDeltaNv, 0);
const tc13Branch = calculatePerformance(tc13Model, "gd-a", 400000).branches[0];
assert.equal(tc13Branch.completed, false);
assert.equal(tc13Branch.total, 200000);
assert.throws(
  () => cancelClosingCompletion(tc13Model, "child-gd"),
  /취소할 마감 완료 기록이 없습니다/,
);

// ──── TC14 — 양쪽 모두 마감 사업자: 최상위 목표만 입력, 자동 배분 ────
const tc14Model = buildPerformanceModel(tc06Payload);
const tc14Plan = planClosing(tc14Model, "gd-a", 400000, [
  "gd-a",
  "b-closer",
  "c-closer",
]);
const tc14BAlloc = tc14Plan.allocation.lines[0].childAllocation;
const tc14CAlloc = tc14Plan.allocation.lines[1].childAllocation;
assert.equal(tc14BAlloc.memberId, "b-closer");
assert.equal(tc14BAlloc.majorTarget, 200000);
assert.equal(tc14BAlloc.minorTarget, 200000);
assert.equal(tc14CAlloc.memberId, "c-closer");
assert.equal(tc14CAlloc.majorTarget, 195000);
assert.equal(tc14CAlloc.minorTarget, 195000);
assert.equal(tc14Plan.allocation.lines[1].passthroughNv, 10000);
assert.deepEqual(
  tc14Plan.placements.map((p) => [p.placementMemberId, p.salesWon]),
  [
    ["b1", 149000],
    ["b2", 149000],
    ["c1", 155000],
    ["c2", 161000],
  ],
);
assert.equal(tc14Plan.totalSalesWon, 614000);
assert.equal(tc14Plan.topMajorNv, 401380);
assert.equal(tc14Plan.topMinorNv, 400960);
assert.equal(tc14Plan.topCompletedNv, 802340);
assert.equal(tc14Plan.verified, true);

// ──── TC15 — 한쪽만 마감 사업자: 일반 라인 NV 차감 후 자동 배분 ────
const tc15Model = buildPerformanceModel(tc05Payload);
const tc15Plan = planClosing(tc15Model, "gd-a", 400000, ["gd-a", "b-closer"]);
const tc15BAlloc = tc15Plan.allocation.lines[0].childAllocation;
assert.equal(tc15BAlloc.memberId, "b-closer");
assert.equal(tc15BAlloc.majorTarget, 200000);
assert.equal(tc15BAlloc.minorTarget, 200000);
assert.equal(tc15Plan.allocation.lines[1].childAllocation, null);
assert.equal(tc15Plan.allocation.lines[1].passthroughNv, 130000);
assert.deepEqual(
  tc15Plan.placements.map((p) => [p.placementMemberId, p.salesWon]),
  [
    ["d", 124000],
    ["e", 124000],
    ["f", 334000],
  ],
);
assert.equal(tc15Plan.totalSalesWon, 582000);
assert.equal(tc15Plan.topMajorNv, 400880);
assert.equal(tc15Plan.topMinorNv, 400540);
assert.equal(tc15Plan.verified, true);

// ──── TC16·TC17 — 3단계 재귀 배분(½→다시 ½) + 최종 검산 ────
const tc16Model = buildPerformanceModel({
  rstLst: [
    { userId: "top-gd", userName: "TopGD", ppId: "" },
    { userId: "mid-closer", userName: "Mid마감", ppId: "top-gd", abPos: 1 },
    { userId: "c-regular", userName: "C일반", ppId: "top-gd", abPos: 2 },
    { userId: "d-closer", userName: "D마감", ppId: "mid-closer", abPos: 1 },
    { userId: "e-regular", userName: "E일반", ppId: "mid-closer", abPos: 2 },
    { userId: "g", userName: "G", ppId: "d-closer", abPos: 1 },
    { userId: "h", userName: "H", ppId: "d-closer", abPos: 2 },
  ],
  members: [
    { userId: "top-gd", ordPv: 0 },
    { userId: "mid-closer", ordPv: 40000, maxPv: 90000, minPv: 60000 },
    { userId: "c-regular", ordPv: 300000 },
    { userId: "d-closer", ordPv: 10000, maxPv: 50000, minPv: 30000 },
    { userId: "e-regular", ordPv: 60000 },
    { userId: "g", ordPv: 50000 },
    { userId: "h", ordPv: 30000 },
  ],
});
const tc16Plan = planClosing(tc16Model, "top-gd", 800000, [
  "top-gd",
  "mid-closer",
  "d-closer",
]);
const tc16MidAlloc = tc16Plan.allocation.lines[0].childAllocation;
assert.equal(tc16MidAlloc.memberId, "mid-closer");
assert.equal(tc16MidAlloc.majorTarget, 400000); // N2 = N1/2
assert.equal(tc16MidAlloc.minorTarget, 400000);
const tc16DAlloc = tc16MidAlloc.lines[0].childAllocation;
assert.equal(tc16DAlloc.memberId, "d-closer");
assert.equal(tc16DAlloc.majorTarget, 200000); // O12 = N2/2 (다시 ½)
assert.equal(tc16DAlloc.minorTarget, 200000);
assert.equal(tc16MidAlloc.lines[1].childAllocation, null);
assert.equal(tc16MidAlloc.lines[1].passthroughNv, 100000);
assert.equal(tc16Plan.allocation.lines[1].childAllocation, null);
assert.equal(tc16Plan.allocation.lines[1].passthroughNv, 300000);
const tc16Steps = new Map(
  tc16Plan.steps.map((step) => [step.memberId, step]),
);
assert.equal(tc16Steps.get("d-closer").projection.completedNv, 401040);
assert.equal(tc16Steps.get("mid-closer").projection.completedNv, 801550);
assert.equal(tc16Steps.get("top-gd").projection.completedNv, 1602130);
assert.deepEqual(
  tc16Plan.placements.map((p) => [p.placementMemberId, p.salesWon, p.addedNv]),
  [
    ["g", 186000, 150660],
    ["h", 198000, 160380],
    ["e-regular", 371000, 300510],
    ["c-regular", 618000, 500580],
  ],
);
assert.equal(tc16Plan.totalSalesWon, 1373000);
assert.equal(tc16Plan.topMajorNv, 801550);
assert.equal(tc16Plan.topMinorNv, 800580);
assert.equal(tc16Plan.verified, true); // 대·소 모두 800,000 이상

// ──── TC18 — 일반 회원 라인 실적이 이미 충분: 추가 매출 없음 ────
const tc18Model = buildPerformanceModel({
  rstLst: [
    { userId: "gd-a", userName: "GD_A", ppId: "" },
    { userId: "b-closer", userName: "B마감", ppId: "gd-a", abPos: 1 },
    { userId: "c-regular", userName: "C일반", ppId: "gd-a", abPos: 2 },
    { userId: "d", userName: "D", ppId: "b-closer", abPos: 1 },
    { userId: "e", userName: "E", ppId: "b-closer", abPos: 2 },
  ],
  members: [
    { userId: "gd-a", ordPv: 20000 },
    { userId: "b-closer", ordPv: 10000, maxPv: 60000, minPv: 40000 },
    { userId: "c-regular", ordPv: 450000 },
    { userId: "d", ordPv: 60000 },
    { userId: "e", ordPv: 40000 },
  ],
});
const tc18Plan = planClosing(tc18Model, "gd-a", 400000, ["gd-a", "b-closer"]);
const tc18BAlloc = tc18Plan.allocation.lines[0].childAllocation;
assert.equal(tc18BAlloc.memberId, "b-closer");
assert.equal(tc18BAlloc.majorTarget, 190000); // (400000 − 본인 20000) / 2
assert.equal(tc18BAlloc.minorTarget, 190000);
assert.equal(tc18Plan.allocation.lines[0].passthroughNv, 20000);
assert.equal(tc18Plan.allocation.lines[1].childAllocation, null);
assert.equal(tc18Plan.allocation.lines[1].passthroughNv, 450000);
assert.deepEqual(
  tc18Plan.placements.map((p) => [p.placementMemberId, p.salesWon]),
  [
    ["d", 161000],
    ["e", 173000],
  ],
);
assert.ok(
  tc18Plan.placements.every((p) => p.placementMemberId !== "c-regular"),
);
assert.equal(tc18Plan.totalSalesWon, 334000);
assert.equal(
  tc18Plan.steps.find((step) => step.memberId === "b-closer").projection
    .completedNv,
  380540,
);
assert.equal(tc18Plan.topMajorNv, 450000);
assert.equal(tc18Plan.topMinorNv, 400540);
assert.equal(tc18Plan.topCompletedNv, 850540);
assert.equal(tc18Plan.verified, true);

console.log("closing plan tests (TC01-TC18) passed");

// ──── 회귀 1 — 완료 후 최상위 목표 400K→800K 변경 시 과거 완료값 무효화 ────
const sig400 = planSignature("gd-a", 400000, ["gd-a", "b-closer"]);
const sig800 = planSignature("gd-a", 800000, ["gd-a", "b-closer"]);
assert.notEqual(sig400, sig800);
assert.equal(
  sig400,
  planSignature(
    "gd-a",
    { majorTarget: 400000, minorTarget: 400000 },
    ["b-closer", "gd-a", "b-closer"], // 순서·중복 무관
  ),
);
const targetChangeCompletions = {
  "b-closer": {
    majorNv: 200440,
    minorNv: 200440,
    completedNv: 400880,
    signature: sig400,
  },
  "gd-a": {
    majorNv: 400880,
    minorNv: 400540,
    completedNv: 801420,
    signature: sig400,
  },
};
assert.deepEqual(
  pruneInvalidCompletions(targetChangeCompletions, sig400),
  targetChangeCompletions,
);
assert.deepEqual(pruneInvalidCompletions(targetChangeCompletions, sig800), {});

// ──── 회귀 2 — 하위 마감 사업자 선택 해제 시 관련 완료값 제거 ────
const sigThree = planSignature("gd-a", 400000, ["gd-a", "b-closer", "c-closer"]);
const sigTwo = planSignature("gd-a", 400000, ["gd-a", "c-closer"]);
const deselectCompletions = {
  "b-closer": { majorNv: 1, minorNv: 1, completedNv: 2, signature: sigThree },
  "c-closer": { majorNv: 1, minorNv: 1, completedNv: 2, signature: sigThree },
};
assert.deepEqual(pruneInvalidCompletions(deselectCompletions, sigTwo), {});
assert.deepEqual(pruneInvalidCompletions({ "b-closer": {} }, sigTwo), {}); // 서명 없는 옛 완료도 무효

// ──── 회귀 3 — 형제 B·C 완료 후 B 취소: C 유지, B의 상위만 연쇄 취소 ────
const siblingModel = buildPerformanceModel(tc06Payload);
const siblingCompletions = {
  "b-closer": { majorNv: 200690, minorNv: 200690, completedNv: 401380 },
  "c-closer": { majorNv: 200410, minorNv: 200270, completedNv: 400680 },
  "gd-a": { majorNv: 410680, minorNv: 401380, completedNv: 812060 },
};
const afterSiblingCancel = cancelCompletionCascade(
  siblingModel,
  siblingCompletions,
  "b-closer",
);
assert.deepEqual(Object.keys(afterSiblingCancel), ["c-closer"]);
assert.deepEqual(
  afterSiblingCancel["c-closer"],
  siblingCompletions["c-closer"],
);
const afterLeafCancel = cancelCompletionCascade(
  siblingModel,
  siblingCompletions,
  "c1", // 마감 사업자가 아닌 하위 코드 취소도 그 계보 위만 지움
);
assert.deepEqual(Object.keys(afterLeafCancel).sort(), ["b-closer"]);

// ──── 회귀 4 — 최상위 사업자 변경 시 이전 계보 완료값이 새 계획에 미반영 ────
const sigTopA = planSignature("gd-a", 400000, ["gd-a", "b-closer"]);
const sigTopB = planSignature("b-closer", 400000, ["b-closer"]);
const topChangeCompletions = {
  "b-closer": { majorNv: 1, minorNv: 1, completedNv: 2, signature: sigTopA },
};
assert.deepEqual(pruneInvalidCompletions(topChangeCompletions, sigTopB), {});

console.log("completion invalidation regression tests passed");
