import assert from "node:assert/strict";
import { test } from "node:test";

import { passJobviteConsent } from "../src/applyForm.js";

function consentPage(policies, { acceptAfter = 1 } = {}) {
  const events = [];
  let changes = 0;
  const accept = { innerText: "Accept", value: "", disabled: false, clicks: 0, getBoundingClientRect: () => ({ width: changes >= acceptAfter ? 80 : 0, height: 20 }), click() { this.clicks++; } };
  const back = { innerText: "Back", value: "", disabled: false, getBoundingClientRect: () => ({ width: 80, height: 20 }), click() { throw new Error("must not go back"); } };
  const form = { querySelectorAll: () => [back, accept] };
  const sel = {
    value: "",
    options: [{ value: "", textContent: "Select your location of residence and language" }, ...policies.map((t, i) => ({ value: `p${i}`, textContent: t }))],
    closest: () => form,
    dispatchEvent(e) {
      events.push(e.type);
      if (e.type === "change") changes++;
    },
  };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  globalThis.document = { getElementById: (id) => (id === "jv-country-select" ? sel : null) };
  return { sel, accept, events };
}

test("Jobvite consent: picks the Global policy and accepts", async () => {
  const p = consentPage(["Data Privacy Acknowledgement -- Global"]);
  const res = await passJobviteConsent();
  assert.equal(res.clicked, true);
  assert.equal(p.sel.value, "p0");
  assert.equal(p.accept.clicks, 1);
  assert.ok(p.events.includes("change"));
});

test("Jobvite consent: prefers the United States policy", async () => {
  const p = consentPage(["Germany - Deutsch", "United States - English", "Global"]);
  await passJobviteConsent();
  assert.equal(p.sel.value, "p1");
});

test("Jobvite consent: no suitable policy leaves the page alone (no residence)", async () => {
  const p = consentPage(["Germany - Deutsch", "France - Français"]);
  const res = await passJobviteConsent();
  assert.ok(res.error);
  assert.equal(p.sel.value, "");
  assert.equal(p.accept.clicks, 0);
});

test("Jobvite consent: California / Non-California follows the residence", async () => {
  let p = consentPage(["Non-California", "California"]);
  await passJobviteConsent("california, CA, united states");
  assert.equal(p.sel.value, "p1");
  p = consentPage(["Non-California", "California"]);
  await passJobviteConsent("ohio, OH, united states");
  assert.equal(p.sel.value, "p0");
  // Unknown residence: no guess between state-specific policies.
  p = consentPage(["Non-California", "California"]);
  const res = await passJobviteConsent("");
  assert.ok(res.error);
  assert.equal(p.sel.value, "");
});

test("Jobvite consent: India / Other picks Other for a US resident", async () => {
  const p = consentPage(["Other", "India"]);
  await passJobviteConsent("texas, TX, united states");
  assert.equal(p.sel.value, "p0");
});
