import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/workday/wd-steps.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (name) => {
  const i = src.indexOf(`  function ${name}(`);
  const j = src.indexOf("\n  }\n", i);
  return src.slice(i, j + 4);
};
const D = { norm: (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim() };
const containsWordStart = new Function(`${grab("containsWordStart")}; return containsWordStart;`)();
const campusCityAliases = new Function("D", `${grab("campusCityAliases")}; return campusCityAliases;`)(D);
const pickNearbyCampus = new Function(
  "D",
  "containsWordStart",
  "campusCityAliases",
  `${grab("pickNearbyCampus")}; return pickNearbyCampus;`,
)(D, containsWordStart, campusCityAliases);

const UW = [
  "University of Mary Washington",
  "University of Phoenix - Eastern Washington",
  "University of Washington Bothell",
  "University of Washington-Seattle Campus",
  "University of Washington-Tacoma Campus",
];

test("Kent WA picks University of Washington Seattle campus", () => {
  assert.equal(
    pickNearbyCampus("University of Washington", UW, { city: "Kent", state: "WA" }),
    "University of Washington-Seattle Campus",
  );
});

test("Tacoma WA picks the Tacoma campus", () => {
  assert.equal(
    pickNearbyCampus("University of Washington", UW, { city: "Tacoma", state: "WA" }),
    "University of Washington-Tacoma Campus",
  );
});

test("Bothell picks the Bothell campus", () => {
  assert.equal(
    pickNearbyCampus("University of Washington", UW, { city: "Bothell", state: "WA" }),
    "University of Washington Bothell",
  );
});

test("no location still prefers the UW flagship Seattle campus over Bothell", () => {
  assert.equal(
    pickNearbyCampus("University of Washington", UW, {}),
    "University of Washington-Seattle Campus",
  );
});

test("never treats Mary Washington as University of Washington", () => {
  assert.equal(containsWordStart("university of mary washington", "university of washington"), false);
  assert.equal(pickNearbyCampus("University of Washington", ["University of Mary Washington"], { city: "Kent" }), null);
});
