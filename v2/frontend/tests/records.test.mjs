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

import { monthDates, nextDate, gridValue, buildGrid, toGridCsv, matchPeople, trackedPeople } from "../js/records-logic.js";
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
console.log("Records grid tests passed.");
