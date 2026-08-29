import assert from "node:assert/strict";
import {
  buildPerformanceModel,
  calculatePerformance,
} from "../js/performance-calculator.js";

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
