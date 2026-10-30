import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/engine/drivers/native.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (name) => {
  const i = src.indexOf(`  function ${name}(`);
  const j = src.indexOf("\n  }\n", i);
  return src.slice(i, j + 4);
};
const consts = src.slice(src.indexOf("  const DEFAULT_DATE_FORMAT"), src.indexOf("  function isDatePickerInput("));
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const { parseDateAnswer, formatDate, isDatePickerInput, datePickerFormat } = new Function(
  "clean",
  `${consts}\n${["isDatePickerInput", "datePickerFormat", "validParts", "parseDateAnswer", "formatDate"].map(grab).join("\n")}\n` +
    "return { parseDateAnswer, formatDate, isDatePickerInput, datePickerFormat };",
)(clean);

const US = "MM/DD/YYYY";
const asUs = (text) => {
  const p = parseDateAnswer(text, US);
  return p && formatDate(p, US);
};

test("answers in any common shape become the picker's MM/DD/YYYY", () => {
  assert.equal(asUs("2026-10-29"), "10/29/2026");
  assert.equal(asUs("10/29/2026"), "10/29/2026");
  assert.equal(asUs("1/5/2027"), "01/05/2027");
  assert.equal(asUs("October 29, 2026"), "10/29/2026");
  assert.equal(asUs("November 12th, 2026"), "11/12/2026");
  assert.equal(asUs("29/10/2026"), "10/29/2026");
});

test("impossible or non-date answers are not turned into dates", () => {
  assert.equal(parseDateAnswer("2026-02-30", US), null);
  assert.equal(parseDateAnswer("13/13/2026", US), null);
  assert.equal(parseDateAnswer("2 weeks after an offer", US), null);
  assert.equal(parseDateAnswer("", US), null);
});

test("today resolves to the local date", () => {
  const t = new Date();
  assert.deepEqual(parseDateAnswer("today", US), { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() });
});

test("a placeholder that spells a format wins over the US default", () => {
  const input = (placeholder, className = "") => ({
    className,
    getAttribute: (k) => (k === "placeholder" ? placeholder : null),
    closest: (sel) => (sel.includes("react-datepicker") ? {} : null),
  });
  assert.equal(datePickerFormat(input("Pick date...")), "MM/DD/YYYY");
  assert.equal(datePickerFormat(input("dd/mm/yyyy")), "DD/MM/YYYY");
  assert.equal(formatDate({ y: 2026, m: 10, d: 29 }, "DD/MM/YYYY"), "29/10/2026");
  assert.equal(formatDate({ y: 2026, m: 10, d: 29 }, "YYYY-MM-DD"), "2026-10-29");
  assert.equal(isDatePickerInput(input("Pick date...")), true);
  assert.equal(isDatePickerInput({ className: "", closest: () => null }), false);
});
