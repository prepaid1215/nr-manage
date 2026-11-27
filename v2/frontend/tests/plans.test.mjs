import assert from "node:assert/strict";
import { PLANS, plansFor, planLabel, findPlanByShort } from "../js/plans.js";
import { contactName } from "../js/contact-name.js";

assert.equal(PLANS.length, 74);
assert.equal(plansFor("KT").length, 59);
assert.equal(plansFor("LG U+").length, 15);
assert.equal(plansFor("").length, 74);

// 통신사 안에서 짧은 표기는 겹치지 않는다
for (const network of ["KT", "LG U+"]) {
  const shorts = plansFor(network).map((plan) => plan.short);
  assert.equal(new Set(shorts).size, shorts.length, `${network} short duplicated`);
  assert.ok(shorts.every((short) => short.trim() && !/\s/.test(short)));
}

assert.equal(findPlanByShort("396", "LG U+").price, 39600);
assert.equal(findPlanByShort("기본1", "KT").price, 12100);
assert.equal(findPlanByShort("2.5", "LG U+").name, "L망 선불 데이터 2.5GB");
assert.equal(findPlanByShort("없는요금제", "KT"), null);
assert.match(planLabel(findPlanByShort("464", "LG U+")), /46,400원/);

// 고른 요금제가 이름에 붙는 모습
const named = (short, network) =>
  contactName({ name: "홍길동", network, plan: short, activation_date: "2026-11-27" });
assert.equal(named("396", "LG U+"), "홍길동 L396 261127");
assert.equal(named("기본1", "KT"), "홍길동 K기본1 261127");
assert.equal(named("2.5", "LG U+"), "홍길동 L2.5 261127");
assert.equal(named("후불15G네이버", "KT"), "홍길동 K후불15G네이버 261127");
assert.equal(named("패드6.4", "KT"), "홍길동 K패드6.4 261127");

console.log("plans tests passed");
