import assert from "node:assert/strict";
import { test } from "node:test";

await import("../content/engine/input-values.js");
const valueFor = globalThis.__NAO_inputValueFor;
const input = (type) => ({ tagName: "INPUT", type });

test("date inputs get yyyy-MM-dd (Chrome refuses anything else)", () => {
  assert.equal(valueFor(input("date"), "08/01/2011"), "2011-08-01");
  assert.equal(valueFor(input("date"), "11/24/2026"), "2026-11-24");
  assert.equal(valueFor(input("date"), "2015-05-01"), "2015-05-01");
  assert.equal(valueFor(input("date"), "24/11/2026"), "2026-11-24"); // first number cannot be a month
  assert.equal(valueFor(input("date"), "8/1/11"), "2011-08-01");
  assert.equal(valueFor(input("date"), "May 2015"), "2015-05-01");
  assert.equal(valueFor(input("date"), "August 1, 2011"), "2011-08-01");
  assert.equal(valueFor(input("date"), "05/2015"), "2015-05-01");
  assert.equal(valueFor(input("date"), "not a date"), "");
  assert.equal(valueFor(input("date"), "02/30/2020"), "");
});

test("month, datetime-local, time, week, number", () => {
  assert.equal(valueFor(input("month"), "05/01/2015"), "2015-05");
  assert.equal(valueFor(input("month"), "2015-05"), "2015-05");
  assert.equal(valueFor(input("datetime-local"), "2026-11-24 9:30 AM"), "2026-11-24T09:30");
  assert.equal(valueFor(input("datetime-local"), "11/24/2026"), "2026-11-24T00:00");
  assert.equal(valueFor(input("time"), "9:30 PM"), "21:30");
  assert.equal(valueFor(input("time"), "12 am"), "00:00");
  assert.equal(valueFor(input("time"), "14:05"), "14:05");
  assert.equal(valueFor(input("week"), "2026-W05"), "2026-W05");
  assert.equal(valueFor(input("week"), "week 5"), "");
  assert.equal(valueFor(input("number"), "5 years"), "5");
  assert.equal(valueFor(input("number"), "$120,000"), "120000");
  assert.equal(valueFor(input("number"), "undefined"), "");
  assert.equal(valueFor(input("range"), "7.5"), "7.5");
});

test("text and other controls are untouched", () => {
  assert.equal(valueFor(input("text"), "08/01/2011"), "08/01/2011");
  assert.equal(valueFor({ tagName: "TEXTAREA" }, "5 years"), "5 years");
  assert.equal(valueFor(input("date"), ""), "");
  assert.equal(valueFor(input("date"), null), "");
});
