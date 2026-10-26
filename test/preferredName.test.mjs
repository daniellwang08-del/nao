import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/workday/wd-steps.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (name) => {
  const i = src.indexOf(`  function ${name}(`);
  const j = src.indexOf("\n  }\n", i);
  return src.slice(i, j + 4);
};
const regexLine = src.split("\n").find((l) => l.includes("const PREFERRED_NAME_RE ="));
const D = { norm: (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim() };
const stub = "const isSkillsField = () => false; const isDisabilitySelfIdLabel = () => false;";
const { preferredFirstName, profileWantForField } = new Function(
  "D",
  `${regexLine}\n${stub}\n${grab("preferredFirstName")}\n${grab("profileWantForField")}\n` +
    "return { preferredFirstName, profileWantForField };",
)(D);

const profile = (preferred) => ({ name: { first: "Zeyu", middle: "", last: "Wang", preferred } });
const want = (key, label, p) => profileWantForField(key, label, p, {});

test("preferred first name fields use the stored preferred name", () => {
  const p = profile("Alex");
  assert.equal(want("preferredName--firstName", "First Name", p), "Alex");
  assert.equal(want("", "Preferred First Name", p), "Alex");
  assert.equal(want("", "Preferred Name", p), "Alex");
  assert.equal(want("", "Nickname", p), "Alex");
});

test("a preferred last name field gets the last name", () => {
  assert.equal(want("preferredName--lastName", "Last Name", profile("Alex")), "Wang");
});

test("without a preferred name the legal first name is used", () => {
  assert.equal(want("", "Preferred First Name", profile("")), "Zeyu");
});

test("legal and unrelated fields are untouched", () => {
  const p = profile("Alex");
  assert.equal(want("legalName--firstName", "First Name", p), undefined);
  assert.equal(want("", "Preferred work location", p), undefined);
  assert.equal(want("", "Preferred contact method", p), undefined);
});

test("a preferred name equal to the legal first name counts as none", () => {
  assert.equal(preferredFirstName(profile("Alex")), "Alex");
  assert.equal(preferredFirstName(profile(" zeyu ")), "");
  assert.equal(preferredFirstName(profile("")), "");
});
