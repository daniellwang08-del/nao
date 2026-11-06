import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const src = readFileSync(new URL("../content/workday/wd-steps.js", import.meta.url), "utf8");
const start = src.indexOf("const WORK_AUTH_Q_RE");
const end = src.indexOf("function isReasonableAccommodationLabel");
assert.ok(start > 0 && end > start, "workEligibilityAnswer block not found in wd-steps.js");
const workEligibilityAnswer = vm.runInNewContext(`${src.slice(start, end)}\nworkEligibilityAnswer`);

const citizen = { authorized: true, sponsorship: false };

test("authorized candidates answer Yes to every work-authorization wording", () => {
  for (const label of [
    "Are you legally authorized to work in the United States?",
    "Are you legally authorized to work in the United States without sponsorship?",
    "Are you authorized to work in the US for any employer without the need for visa sponsorship?",
    "Are you legally authorized to work in the U.S. prior to your start date?",
    "Are you currently eligible to work in the United States?",
    "Do you have the legal right to work in the USA?",
    "Will you be legally authorized to work in the U.S. before you start?",
  ]) {
    assert.equal(workEligibilityAnswer(label, citizen), "Yes", label);
  }
});

test("sponsorship need questions answer No for candidates who need none", () => {
  for (const label of [
    "Will you now or in the future require sponsorship for employment visa status?",
    "Do you now or in the future require any immigration filing or visa sponsorship?",
    "Will you require sponsorship to be authorized to work in the United States?",
  ]) {
    assert.equal(workEligibilityAnswer(label, citizen), "No", label);
  }
});

test("candidates who need sponsorship answer truthfully", () => {
  const visa = { authorized: true, sponsorship: true };
  assert.equal(workEligibilityAnswer("Are you authorized to work in the US without sponsorship?", visa), "No");
  assert.equal(workEligibilityAnswer("Will you now or in the future require sponsorship?", visa), "Yes");
  assert.equal(workEligibilityAnswer("Are you legally authorized to work in the United States?", visa), "Yes");
});

test("unsaved answers are never assumed: the question is left for the candidate", () => {
  assert.equal(workEligibilityAnswer("Are you legally authorized to work in the United States?", {}), undefined);
  assert.equal(workEligibilityAnswer("Will you now or in the future require visa sponsorship?", {}), undefined);
  // "Authorized without sponsorship" needs both answers saved.
  assert.equal(workEligibilityAnswer("Are you authorized to work in the US without sponsorship?", { authorized: true }), undefined);
  assert.equal(workEligibilityAnswer("Are you legally authorized to work in the United States?", { authorized: true }), "Yes");
  assert.equal(workEligibilityAnswer("Will you now or in the future require visa sponsorship?", { sponsorship: false }), "No");
});

test("other countries and unrelated questions are left alone", () => {
  assert.equal(workEligibilityAnswer("Are you legally authorized to work in Canada?", citizen), undefined);
  assert.equal(workEligibilityAnswer("Have you previously worked for this company?", citizen), undefined);
});
