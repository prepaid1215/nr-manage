import assert from "node:assert/strict";
import { closingRound, withDeltas, toPeopleCsv, labelCodes, groupPeople } from "../js/records-logic.js";

assert.equal(closingRound("2026-11-08"), 1);
assert.equal(closingRound("2026-11-15"), 2);
assert.equal(closingRound("2026-11-23"), 3);
assert.equal(closingRound("2026-11-30"), 4);
assert.equal(closingRound("2026-02-28"), 4);
assert.equal(closingRound("2024-02-29"), 4);
assert.equal(closingRound("2026-11-24"), 0);

const now = [
  { user_id: "1", max_pv: 120, min_pv: 50, real_lines: 5 },
  { user_id: "2", max_pv: 10, min_pv: 0, real_lines: null },
  { user_id: "3", max_pv: 7, min_pv: 7, real_lines: 0 },
];
const before = [
  { user_id: "1", max_pv: 100, min_pv: 50, real_lines: 3 },
  { user_id: "2", max_pv: 10, min_pv: 0, real_lines: 4 },
];
const out = withDeltas(now, before);
assert.deepEqual([out[0].d_max, out[0].d_min, out[0].d_real], [20, 0, 2]);
assert.equal(out[1].d_real, null, "미수집은 증감을 만들지 않는다");
assert.equal(out[2].d_max, null, "이전 기록이 없는 코드는 증감 없음");
assert.equal(withDeltas(now, [])[0].d_max, null);

const people = [
  { user_id: "2913195", user_name: "김정경" },
  { user_id: "2913196", user_name: "김정경" },
  { user_id: "2913197", user_name: "김정경" },
  { user_id: "2918875", user_name: "신주영" },
  { user_id: "2918876", user_name: "신주영" },
  { user_id: "2918877", user_name: "다른사람" },
  { user_id: "2920633", user_name: "진순정" },
];
const labels = labelCodes(people);
assert.deepEqual(["2913195", "2913196", "2913197"].map((id) => labels.get(id)), ["본", "서브1", "서브2"]);
assert.equal(labels.get("2918875"), "단독", "이름이 다르면 묶지 않는다");
assert.equal(labels.get("2918876"), "단독");
assert.equal(labels.get("2920633"), "단독");

const day = [
  { user_id: "10", user_name: "홍,길동", rank_name: "GD", max_pv: 9, min_pv: 1, real_lines: 4, d_max: 1, d_min: 0, d_real: 1 },
  { user_id: "11", user_name: "홍,길동", rank_name: "GD", max_pv: 5, min_pv: 2, real_lines: 0, d_max: 2, d_min: 0, d_real: 0 },
  { user_id: "12", user_name: "홍,길동", rank_name: "GD", max_pv: 6, min_pv: 3, real_lines: null, d_max: null, d_min: null, d_real: null },
  { user_id: "99", user_name: "단독인", rank_name: "회원", max_pv: 1, min_pv: 0, real_lines: 2 },
];
const grouped = groupPeople(day);
assert.equal(grouped.people.length, 1);
assert.equal(grouped.people[0].s1.user_id, "11");
assert.equal(grouped.people[0].s2.user_id, "12");
assert.equal(grouped.singles.length, 1);
const csv = toPeopleCsv(grouped.people, grouped.singles, "2026-11-23", "acct");
const lines = csv.split("\r\n");
assert.ok(csv.startsWith("\uFEFF날짜,"));
assert.equal(lines.length, 3, "머리글 + 사람 1줄 + 단독 1줄");
assert.ok(lines[1].includes('"홍,길동"'), "쉼표가 든 이름은 따옴표로 감싼다");
assert.ok(lines[1].includes(",11,5,2,0,"), "서브1의 실제 0 회선은 0으로 남는다");
assert.ok(lines[1].includes(",12,6,3,,"), "미수집은 빈칸");
assert.equal(lines[0].split(",").length, lines[2].split(",").length, "열 수가 모두 같다");

console.log("Records tab tests passed: closing rounds, deltas, csv.");

import { monthDates, nextDate, gridValue, buildGrid, toGridCsv, matchPeople, trackedPeople, kstDate, snapshotRows, withProvisional, FINAL_RULE_START, kstHour, finalPreviewRows } from "../js/records-logic.js";
assert.equal(monthDates("2026-11").length, 30);
assert.equal(monthDates("2026-11")[7], "2026-11-08");
assert.equal(gridValue({ ord_pv: 10, max_pv: 100, min_pv: 5 }, "total"), 115);
assert.equal(gridValue({ real_lines: 0 }, "real_lines"), 0, "실제 0 회선은 0");
assert.equal(gridValue({ real_lines: null }, "real_lines"), null, "미수집은 null");
assert.equal(gridValue(undefined, "max_pv"), null, "기록 없는 날은 null");
const gridRows = [
  { metric_date: "2026-11-08", user_id: "11", ord_pv: 0, max_pv: 50, min_pv: 5, real_lines: 3 },
  { metric_date: "2026-11-08", user_id: "12", ord_pv: 1, max_pv: 60, min_pv: 6, real_lines: null },
];
const g = buildGrid(gridRows, [{ code: "10", name: "홍길동", s1: "11", s2: "12" }], monthDates("2026-11"), "total");
assert.equal(g[7].round, 1);
assert.deepEqual(g[7].cells, [55, 67]);
assert.deepEqual(g[0].cells, [null, null]);
// 마감일 아래 "최종마감" 줄: 다음날 0시 기록을 쓰고, 그 기록이 없으면 빈칸
assert.equal(g[8].final, true);
assert.equal(g[8].round, 1);
assert.deepEqual(g[8].cells, [null, null], "다음날 기록이 없으면 null");
assert.equal(g.length, 30 + 4, "마감일 4번마다 최종마감 줄 1개씩");
const g2 = buildGrid([...gridRows, { metric_date: "2026-11-09", user_id: "11", ord_pv: 0, max_pv: 70, min_pv: 7, real_lines: 3 }], [{ code: "10", name: "홍길동", s1: "11", s2: "12" }], monthDates("2026-11"), "total");
assert.deepEqual(g2[8].cells, [77, null], "최종마감 1차 = 9일 기록");
assert.deepEqual(g2[7].cells, [55, 67], "마감일 줄은 그날 기록 그대로");
const lastFinal = buildGrid([{ metric_date: "2026-12-01", user_id: "11", ord_pv: 0, max_pv: 1, min_pv: 1, real_lines: 0 }], [{ code: "10", s1: "11", s2: "" }], monthDates("2026-11"), "max_pv").pop();
assert.equal(lastFinal.final, true);
assert.deepEqual(lastFinal.cells, [1, null], "말일 마감은 다음 달 1일 기록");
assert.equal(nextDate("2026-12-31"), "2027-01-01");
const gcsv = toGridCsv(g, [{ code: "10", name: "홍길동" }], "총실적");
assert.ok(gcsv.includes("홍길동 서브1 총실적"));
assert.ok(gcsv.includes("2026-11-08,1차 마감,55,67"));
const ppl = [{ code: "100", name: "홍길동" }, { code: "200", name: "김철수" }, { code: "300", name: "김철민" }];
assert.deepEqual(matchPeople(ppl, "홍길동").map((p) => p.code), ["100"], "이름 전체 입력");
assert.deepEqual(matchPeople(ppl, "홍길동 (100)").map((p) => p.code), ["100"], "목록에서 고른 값");
assert.deepEqual(matchPeople(ppl, "철수").map((p) => p.code), ["200"], "일부만 입력해도 한 명이면 찾는다");
assert.equal(matchPeople(ppl, "김철").length, 2, "여러 명이면 정하지 않는다");
assert.equal(matchPeople(ppl, "없는사람").length, 0);
assert.deepEqual(matchPeople(ppl, "300").map((p) => p.code), ["300"], "코드로도 찾는다");
assert.equal(matchPeople(ppl, "  ").length, 0);
const tracked = [
  { user_id: "2893496", user_name: "주영돈", rank_name: "GD", role: "본", group_id: "2893496" },
  { user_id: "2893497", user_name: "주영돈", rank_name: "GD", role: "서브1", group_id: "2893496" },
  { user_id: "2893498", user_name: "주영돈", rank_name: "GD", role: "서브2", group_id: "2893496" },
  { user_id: "2999000", user_name: "홍단독", rank_name: "회원", role: "단독", group_id: "2999000" },
];
const tp = trackedPeople(tracked);
assert.equal(tp.length, 2, "본·서브1·서브2는 한 사람으로 묶인다");
assert.deepEqual([tp[0].code, tp[0].name, tp[0].s1.user_id, tp[0].s2.user_id], ["2893496", "주영돈", "2893497", "2893498"]);
assert.equal(tp[0].tracked, true);
assert.deepEqual([tp[1].code, tp[1].s1.user_id, tp[1].s2], ["2999000", "2999000", undefined], "단독 코드는 서브1 열 하나");
assert.equal(trackedPeople(tracked, new Set(["2893496"])).length, 1, "이미 기록에 있는 사람은 중복해서 만들지 않는다");
assert.deepEqual(trackedPeople(null), []);
assert.equal(matchPeople(tp, "주영돈")[0].code, "2893496", "등록한 사람도 이름으로 찾는다");
// 오늘 칸 미리 보기
assert.equal(kstDate("2026-11-24T10:00:00Z"), "2026-11-24");
assert.equal(kstDate("2026-11-24T16:00:00Z"), "2026-11-25", "한국시간 자정이 지나면 다음 날");
const snap = {
  collected_at: "2026-11-24T10:44:25Z",
  payload: {
    members: [{ userId: "11", ordPv: "5", maxPv: "100", minPv: "20", lineMetricsVersion: 2, lineMetricsAvailable: { realLines: true, consumerTotalLines: false }, realLines: 0, consumerTotalLines: 9 }],
    trackedMembers: [{ userId: "2893497", ordPv: 0, maxPv: 125000, minPv: 8100, lineMetricsVersion: 2, lineMetricsAvailable: { realLines: true }, realLines: 4 }],
  },
};
const pr = snapshotRows(snap, ["11", "2893497", "999", "", null], "2026-11-24");
assert.deepEqual(pr.map((r) => r.user_id), ["11", "2893497"], "수집 결과에 없는 코드는 만들지 않는다");
assert.equal(pr[0].real_lines, 0, "표시된 실제 0 회선은 0");
assert.equal(pr[0].consumer_total_lines, null, "읽지 못한 값은 null");
assert.equal(pr[1].max_pv, 125000, "등록한 사람(trackedMembers)도 읽는다");
assert.deepEqual(snapshotRows(snap, ["11"], "2026-11-25"), [], "수집이 오늘이 아니면 미리 보기를 만들지 않는다");
assert.deepEqual(snapshotRows(null, ["11"], "2026-11-24"), []);
assert.deepEqual(snapshotRows({ collected_at: snap.collected_at, payload: "{bad" }, ["11"], "2026-11-24"), []);
assert.equal(snapshotRows({ collected_at: snap.collected_at, payload: JSON.stringify(snap.payload) }, ["11"], "2026-11-24").length, 1, "payload가 문자열이어도 읽는다");
const official = [{ metric_date: "2026-11-24", user_id: "11", ord_pv: 1, max_pv: 777, min_pv: 1, real_lines: 1 }];
const merged = withProvisional(official, pr);
assert.equal(merged.rows.find((r) => r.user_id === "11").max_pv, 777, "공식 기록은 덮어쓰지 않는다");
assert.deepEqual([...merged.provisional], ["2026-11-24|2893497"], "공식 기록이 없는 칸만 미리 보기");
// 최종마감 기록 규칙
const pp = [{ code: "10", name: "홍길동", s1: "11", s2: "12" }];
const dailyRows = [
  { metric_date: "2026-11-16", user_id: "11", ord_pv: 0, max_pv: 100, min_pv: 1, real_lines: 1 },
  { metric_date: "2026-11-24", user_id: "11", ord_pv: 0, max_pv: 200, min_pv: 2, real_lines: 1 },
  { metric_date: "2026-11-30", user_id: "11", ord_pv: 0, max_pv: 300, min_pv: 3, real_lines: 1 },
  { metric_date: "2026-12-01", user_id: "11", ord_pv: 0, max_pv: 999, min_pv: 9, real_lines: 1 },
];
const finals = [{ metric_date: "2026-11-30", user_id: "11", ord_pv: 0, max_pv: 350, min_pv: 5, real_lines: 1 }];
const dates = monthDates("2026-11");
const grid1 = buildGrid(dailyRows, pp, dates, "max_pv", finals);
const finalOf = (grid, date) => grid.find((row) => row.final && row.date === date);
assert.equal(FINAL_RULE_START, "2026-11-23");
assert.equal(finalOf(grid1, "2026-11-15").cells[0], 100, "규칙 시작 전 마감일(11/15)은 이전 규칙(다음 날 기록)을 그대로 보여 준다");
assert.equal(finalOf(grid1, "2026-11-15").strict, false);
assert.equal(finalOf(grid1, "2026-11-23").strict, true, "3차(11/23)부터 새 규칙");
assert.equal(finalOf(grid1, "2026-11-23").cells[0], null, "3차는 새벽 수집이 없으면 다음 날(11/24) 값으로 채우지 않고 비운다");
assert.equal(finalOf(grid1, "2026-11-30").cells[0], 350, "새 규칙 마감일은 최종마감 기록만 쓴다");
assert.equal(grid1.find((row) => !row.final && row.date === "2026-11-30").cells[0], 300, "마감일의 일반 줄은 일반 기록");
const grid2 = buildGrid(dailyRows, pp, dates, "max_pv", []);
assert.equal(finalOf(grid2, "2026-11-30").cells[0], null, "시간대에 수집이 없으면 다음 날 일반 기록으로 채우지 않고 비운다");
assert.equal(finalOf(buildGrid(dailyRows, pp, dates, "max_pv"), "2026-11-30").cells[0], 999, "RUN_053 적용 전(finalRows 없음)에는 이전 규칙");
// 새벽 시간대 미리 보기
assert.equal(kstHour("2026-11-30T16:30:00Z"), 1, "한국시간 새벽 1시");
const dawn = { collected_at: "2026-11-30T16:30:00Z", payload: { members: [{ userId: "11", ordPv: 0, maxPv: 777, minPv: 7 }] } };
assert.equal(finalPreviewRows(dawn, ["11"], "2026-11-30")[0].max_pv, 777, "마감 다음날 0~6시 수집은 최종마감 미리 보기");
assert.equal(finalPreviewRows(dawn, ["11"], "2026-11-30")[0].metric_date, "2026-11-30");
assert.deepEqual(finalPreviewRows({ ...dawn, collected_at: "2026-11-30T21:30:00Z" }, ["11"], "2026-11-30"), [], "오전 6시 30분 수집은 시간대 밖");
assert.deepEqual(finalPreviewRows({ ...dawn, collected_at: "2026-11-30T10:00:00Z" }, ["11"], "2026-11-30"), [], "마감 당일 저녁 수집은 최종마감이 아님");
console.log("Records grid tests passed.");

import { moveCode, dropCode } from "../js/records-logic.js";
assert.deepEqual(moveCode(["a", "b", "c"], "b", -1), ["b", "a", "c"], "앞으로 한 칸");
assert.deepEqual(moveCode(["a", "b", "c"], "b", 1), ["a", "c", "b"], "뒤로 한 칸");
assert.deepEqual(moveCode(["a", "b", "c"], "a", -1), ["a", "b", "c"], "맨 앞은 더 못 감");
assert.deepEqual(moveCode(["a", "b", "c"], "c", 1), ["a", "b", "c"], "맨 뒤는 더 못 감");
assert.deepEqual(moveCode(["a", "b", "c"], "x", 1), ["a", "b", "c"], "없는 코드는 그대로");
assert.deepEqual(dropCode(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"], "뒤에서 앞으로 끌면 놓은 자리 앞");
assert.deepEqual(dropCode(["a", "b", "c", "d"], "a", "c"), ["b", "c", "a", "d"], "앞에서 뒤로 끌면 놓은 자리 뒤");
assert.deepEqual(dropCode(["a", "b", "c"], "b", "b"), ["a", "b", "c"], "제자리");
assert.deepEqual(dropCode(["a", "b"], "x", "b"), ["a", "b"], "없는 코드는 그대로");
console.log("Records order tests passed.");

import { weekSummaries, lineNames } from "../js/records-logic.js";
{
  const dates = monthDates("2026-11");
  const people = [{ code: "100", name: "A", s1: "101", s2: "102" }];
  const row = (date, id, total) => ({ metric_date: date, user_id: id, ord_pv: 0, max_pv: total, min_pv: 0 });
  const daily = [row("2026-11-08", "101", 10), row("2026-11-08", "102", 20), row("2026-11-23", "101", 813726), row("2026-11-23", "102", 465520)];
  const finals = [row("2026-11-23", "101", 7), row("2026-11-23", "102", 9)];
  const weeks = weekSummaries(buildGrid(daily, people, dates, "total", finals), dates);
  assert.deepEqual(weeks.map((w) => [w.round, w.from, w.to]), [[1, "2026-11-01", "2026-11-08"], [2, "2026-11-09", "2026-11-15"], [3, "2026-11-16", "2026-11-23"], [4, "2026-11-24", "2026-11-30"]], "주차 기간");
  assert.deepEqual(weeks[0].before, [10, 20], "1주차 마감 전");
  assert.deepEqual(weeks[0].after, [null, null], "1주차는 새 규칙 이전이라 다음 날 기록(없음)을 씀");
  assert.deepEqual(weeks[2].before, [813726, 465520], "3주차 마감 전");
  assert.deepEqual(weeks[2].after, [7, 9], "3주차 마감 후(최종마감 기록)");
  assert.equal(weeks[2].afterStrict, true);
  assert.deepEqual(weeks[3].before, [null, null], "기록이 없으면 비움");
}
assert.deepEqual(lineNames(813726, 465520), ["대실적", "소실적"]);
assert.deepEqual(lineNames(300000, 500000), ["소실적", "대실적"]);
assert.deepEqual(lineNames(5, 5), ["대실적", "소실적"], "같으면 앞쪽이 대실적");
assert.deepEqual(lineNames(null, 5), ["", ""], "한쪽이 비면 알 수 없음");
console.log("Records weekly tests passed.");

import { weekAt, weekDashboard } from "../js/records-logic.js";
assert.deepEqual(weekAt("2026-11-28", 0), { month: "2026-11", round: 4, from: "2026-11-24", to: "2026-11-30" }, "오늘이 속한 주차");
assert.deepEqual(weekAt("2026-11-28", -1), { month: "2026-11", round: 3, from: "2026-11-16", to: "2026-11-23" }, "이전 주차");
assert.deepEqual(weekAt("2026-11-28", -3), { month: "2026-11", round: 1, from: "2026-11-01", to: "2026-11-08" });
assert.deepEqual(weekAt("2026-11-28", -4), { month: "2026-10", round: 4, from: "2026-10-24", to: "2026-10-31" }, "달을 넘어 이전 달 4주차");
assert.deepEqual(weekAt("2026-01-05", -1), { month: "2025-12", round: 4, from: "2025-12-24", to: "2025-12-31" }, "해를 넘어 이동");
assert.deepEqual(weekAt("2026-11-23", 0).round, 3, "마감일 당일은 그 주차");
assert.deepEqual(weekAt("2026-11-24", 0).round, 4);
assert.deepEqual(weekAt("2026-11-28", -48).month, "2025-11", "12개월 전");
assert.deepEqual(weekAt("2026-11-28", 1), { month: "2026-12", round: 1, from: "2026-12-01", to: "2026-12-08" }, "다음 주차");
{
  const r = (date, id, o, max, min, rank = "GD", lines = 5, total = 9) => ({ metric_date: date, user_id: String(id), ord_pv: o, max_pv: max, min_pv: min, rank_name: rank, real_lines: lines, consumer_total_lines: total });
  const rows = [r("2026-11-23", 2893496, 32400, 0, 0), r("2026-11-23", 2893497, 0, 813726, 0), r("2026-11-23", 2893498, 0, 465520, 0)];
  const w = weekDashboard({ rows, finalRows: [], memberNo: 2893496, month: "2026-11", round: 3 });
  assert.equal(w.closing, "2026-11-23");
  assert.deepEqual([w.before.own, w.before.major, w.before.minor, w.before.rank, w.before.realLines, w.before.totalLines], [32400, 813726, 465520, "GD", 5, 9], "NRC 3주차 화면과 같은 값");
  assert.equal(w.after, null, "최종마감 기록이 없으면 마감 후 없음");
  assert.equal(w.afterStrict, true);
  const swapped = weekDashboard({ rows: [r("2026-11-23", 2893497, 0, 300000, 0), r("2026-11-23", 2893498, 0, 500000, 0)], finalRows: [], memberNo: 2893496, month: "2026-11", round: 3 });
  assert.deepEqual([swapped.before.major, swapped.before.minor], [500000, 300000], "서브1이 작아도 큰 값이 대실적");
  const old = weekDashboard({ rows: [r("2026-11-09", 2893497, 0, 7, 0), r("2026-11-09", 2893498, 0, 3, 0)], finalRows: [], memberNo: 2893496, month: "2026-11", round: 1 });
  assert.deepEqual([old.afterStrict, old.after && old.after.major], [false, 7], "규칙 이전 주차는 다음 날 기록을 마감 후로 씀");
  const mainOnly = weekDashboard({ rows: [r("2026-11-08", 2893496, 10, 400, 100)], finalRows: null, memberNo: 2893496, month: "2026-11", round: 1 });
  assert.deepEqual([mainOnly.before.major, mainOnly.before.minor], [400, 100], "서브 기록이 없으면 본코드 줄의 대·소실적");
  const none = weekDashboard({ rows: [], finalRows: [], memberNo: 2893496, month: "2026-11", round: 2 });
  assert.deepEqual([none.before, none.after], [null, null]);
}
console.log("Records dashboard week tests passed.");
