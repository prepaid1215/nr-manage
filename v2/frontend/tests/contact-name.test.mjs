import assert from "node:assert/strict";
import { contactName } from "../js/contact-name.js";

assert.equal(
  contactName({ name: "홍길동", network: "LG U+", plan: "396", activation_date: "2026-11-27" }),
  "홍길동 L396 261127",
);
assert.equal(
  contactName({ name: "김철수", network: "KT", plan: "459", activation_date: "2026-01-05" }),
  "김철수 K459 260105",
);
assert.equal(
  contactName({ name: "이영희", network: "K망", plan: "기본1", activation_date: "2026-03-09" }),
  "이영희 K기본1 260309",
);
assert.equal(
  contactName({ name: "박민수", network: "LG U+", plan: "L464", activation_date: "2026-11-27" }),
  "박민수 L464 261127",
);
assert.equal(
  contactName({ name: "최지우", network: "", plan: "39 6 요금제", activation_date: "2026-11-27" }),
  "최지우 396 261127",
);
assert.equal(contactName({ name: "정수진", network: "KT", plan: "", activation_date: "2026-11-27" }), "정수진 261127");
assert.equal(contactName({ name: "강하나", network: "KT", plan: "396", activation_date: null }), "강하나 K396");
assert.equal(contactName({ name: "  오공  " }), "오공");
assert.equal(contactName({}), "");

// 이미 요금제·날짜를 적어 둔 이름은 그대로 둔다 (화면 예시 그대로)
const kept = (name, plan, network) =>
  contactName({ name, plan, network, activation_date: "2026-10-16" });
assert.equal(kept("이종휘 L396 1016", "396", "LG U+"), "이종휘 L396 1016");
assert.equal(kept("신승빈 K기본2 1016", "기본2", "KT"), "신승빈 K기본2 1016");
assert.equal(kept("김명기 K396 1016", "396", "KT"), "김명기 K396 1016");
assert.equal(kept("김민주 L 300분 1026", "300분", "LG U+"), "김민주 L 300분 1026");
assert.equal(kept("황종대 L2.5 11.22", "2.5", "LG U+"), "황종대 L2.5 11.22");
// 날짜만 없는 이름은 날짜만 붙이고, 요금제만 없으면 요금제만 붙인다
assert.equal(kept("이종휘 L396", "396", "LG U+"), "이종휘 L396 261016");
assert.equal(kept("이종휘 1016", "396", "LG U+"), "이종휘 1016 L396");
// 두 번 적용해도 같은 결과
const once = contactName({ name: "홍길동", plan: "396", network: "KT", activation_date: "2026-11-27" });
assert.equal(contactName({ name: once, plan: "396", network: "KT", activation_date: "2026-11-27" }), once);
// 월.일 처럼 보이지만 요금제인 2.5는 날짜로 보지 않는다
assert.equal(kept("황종대 L2.5", "2.5", "LG U+"), "황종대 L2.5 261016");

console.log("contact name tests passed");
