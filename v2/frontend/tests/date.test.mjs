import assert from "node:assert/strict";
import { localDate, monthRange } from "../js/date.js";

const sample = new Date("2026-08-28T15:30:00.000Z");
const expectedLocalDate = [
  sample.getFullYear(),
  String(sample.getMonth() + 1).padStart(2, "0"),
  String(sample.getDate()).padStart(2, "0"),
].join("-");

assert.equal(localDate(sample), expectedLocalDate);
assert.deepEqual(monthRange("2026-08"), {
  start: "2026-08-01",
  end: "2026-08-31",
});
assert.deepEqual(monthRange("2028-02"), {
  start: "2028-02-01",
  end: "2028-02-29",
});
assert.throws(() => monthRange("2026-13"), /1~12/);

console.log("date tests passed");
