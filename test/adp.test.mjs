import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { ENGINES, detectPlatform } from "../src/engines.js";

const { adpPhone } = await import("../src/panel/autofill/platforms.js");

test("ADP Workforce Now recruitment pages use the ADP engine", () => {
  const url = "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=279a6044-3c46-48f4-a5b2-ff66c44b2808&jobId=595185&ccId=19000101_000003";
  assert.equal(detectPlatform({ pageUrl: url }), "adp");
  assert.equal(ENGINES.adp.available, true);
  assert.notEqual(detectPlatform({ pageUrl: "https://www.adp.com/about.aspx" }), "adp");
});

test("the mobile number for ADP's sign-in never carries the country code twice", () => {
  assert.equal(adpPhone("+1 253-220-9979", "1"), "+12532209979");
  assert.equal(adpPhone("2532209979", "1"), "+12532209979");
  assert.equal(adpPhone("(253) 220-9979", ""), "+12532209979");
  assert.equal(adpPhone("7911 123456", "44"), "+447911123456");
  assert.equal(adpPhone("", "1"), "");
});
