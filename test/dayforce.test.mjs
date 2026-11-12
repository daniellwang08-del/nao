import assert from "node:assert/strict";
import { test } from "node:test";

import { isApplyText } from "../src/applyForm.js";
import { ENGINES, detectPlatform } from "../src/engines.js";

test("Dayforce candidate portals use the Dayforce engine", () => {
  for (const url of [
    "https://jobs.dayforcehcm.com/en-US/diversified/candidateportal/jobs/21538",
    "https://jobs.dayforcehcm.com/en-US/diversified/candidateportal/jobs/21538/apply?flowSelection=true",
    "https://jobs.dayforcehcm.com/diversified/candidateportal/jobs/21538/apply/manualApplication?applicationSource=Manual&step=1&q=2",
  ]) {
    assert.equal(detectPlatform({ pageUrl: url }), "dayforce", url);
  }
  assert.equal(ENGINES.dayforce.available, true);
  assert.equal(ENGINES.dayforce.autoDiscover, true);
});

test("the guest application is an Apply button; signing in is not", () => {
  for (const t of ["Apply without an Account", "Apply without account", "Continue as guest", "Apply as a guest"]) assert.ok(isApplyText(t), t);
  for (const t of ["Apply With LinkedIn", "Sign In", "Create one now.", "Create account"]) assert.ok(!isApplyText(t), t);
});
