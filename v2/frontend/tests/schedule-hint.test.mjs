import assert from "node:assert/strict";
import { scheduleTimeNote } from "../js/schedule-hint.js";

// 일일 예약: 저녁 6시~자정만 기록에 쓰인다
for (const time of ["18:00", "20:30", "23:59"]) {
  const note = scheduleTimeNote("daily", time);
  assert.equal(note.warn, false, `${time}은 기록에 쓰이는 시간`);
  assert.match(note.text, /일반 기록/);
}
for (const time of ["17:59", "09:00", "00:10"]) {
  const note = scheduleTimeNote("daily", time);
  assert.equal(note.warn, true, `${time}은 기록에 쓰이지 않는 시간`);
  assert.match(note.text, /저장해도 됩니다/, "막지 않고 저장 가능하다고 안내한다");
}
// 마감일 예약: 새벽 0~6시만 최종마감 기록에 쓰인다
for (const time of ["00:00", "00:10", "05:59"]) assert.equal(scheduleTimeNote("closing", time).warn, false, time);
for (const time of ["06:00", "12:00", "23:00"]) assert.equal(scheduleTimeNote("closing", time).warn, true, time);
assert.match(scheduleTimeNote("closing", "00:10").text, /최종마감/);
// 주간·월간은 경고 없이 안내만, 시간이 없으면 안내 없음
assert.equal(scheduleTimeNote("weekly", "10:00").warn, false);
assert.match(scheduleTimeNote("monthly", "10:00").text, /기록으로 쓰입니다/);
assert.deepEqual(scheduleTimeNote("daily", ""), { text: "", warn: false });
console.log("Schedule hint tests passed.");
