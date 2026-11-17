import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const storage = await import("../src/storage.js");
const { createRecorder, fieldSummary, profileTerms, recordingEnabled } = await import("../src/autoapply/recorder.js");

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const [status, body] = handler(String(url), init);
    return new Response(body == null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

async function fresh() {
  await chrome.storage.session.clear();
  await storage.setToken("tok");
}

test("recording is off when the server says so, errors, or lacks the endpoint", async () => {
  for (const [status, body] of [[200, { enabled: false }], [404, { detail: "Not Found" }], [500, null]]) {
    await fresh();
    stubFetch(() => [status, body]);
    assert.equal(await recordingEnabled(), false);
  }
});

test("the answer is cached for a few minutes", async () => {
  await fresh();
  const calls = stubFetch(() => [200, { enabled: true }]);
  assert.equal(await recordingEnabled(), true);
  assert.equal(await recordingEnabled(), true);
  assert.equal(calls.filter((c) => c.url.includes("/extension/run-recording")).length, 1);
});

test("a run that is not recorded sends nothing and takes no snapshots", async () => {
  await fresh();
  const calls = stubFetch(() => [200, { enabled: false }]);
  let scripted = 0;
  chrome.scripting = { executeScript: async () => (scripted++, []) };
  const rec = createRecorder({ jobId: "job-1" });
  rec.start();
  rec.step("Opening the job…");
  await rec.snapshot(7, "form");
  assert.equal(await rec.finish({ status: "failed", message: "boom" }), false);
  assert.equal(scripted, 0);
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname.replace(/^.*\/api\/v1/, "")), ["/extension/run-recording"]);
});

test("a recorded failure uploads steps, the field summary and snapshots", async () => {
  await fresh();
  const calls = stubFetch((url) => {
    if (url.includes("/extension/run-recording")) return [200, { enabled: true }];
    if (url.endsWith("/profile")) return [200, { email: "pat@example.com", phone: "+1 (512) 555-0100", name: "Pat Lee" }];
    return [200, { stored: true, id: "r1" }];
  });
  let args;
  chrome.scripting = {
    executeScript: async (opts) => {
      args = opts.args;
      return [{ frameId: 0, result: { url: "https://acme.example/apply", top: true, html: "<form>Email</form>" } }];
    },
  };
  const rec = createRecorder({ jobId: "job-1" });
  rec.start();
  rec.step("Filling the application…");
  await rec.snapshot(7, "form", { wait: true });
  const af = {
    specs: [{ handle: "h", controls: [{ cid: "c1", label: "Email", kind: "text", required: true }] }],
    statuses: { c1: "filled" },
    needsUser: [{ cid: "x", label: "Salary", reason: "No answer saved" }],
  };
  assert.equal(await rec.finish({ status: "needs_you", message: "Needs your input" }, { platform: "oracle", pageUrl: "https://acme.example/apply", autofill: af }), true);
  assert.ok(args[0].includes("pat@example.com") && args[0].includes("15125550100"), "profile terms reach the page masker");
  const sent = JSON.parse(calls.find((c) => c.url.endsWith("/extension/run-reports")).init.body);
  assert.equal(sent.outcome, "needs_you");
  assert.equal(sent.platform, "oracle");
  assert.deepEqual(sent.steps.map((s) => s.text), ["Filling the application…"]);
  assert.equal(sent.snapshots[0].label, "form");
  assert.deepEqual(sent.fields.map((f) => [f.label, f.status]), [["Email", "filled"], ["Salary", "needs_user"]]);
});

test("successful runs are never uploaded", async () => {
  await fresh();
  const calls = stubFetch(() => [200, { enabled: true }]);
  const rec = createRecorder({ jobId: "job-1" });
  rec.start();
  assert.equal(await rec.finish({ status: "applied" }), false);
  assert.equal(calls.some((c) => c.url.endsWith("/extension/run-reports")), false);
});

test("profile terms keep contact details, not employers", () => {
  const terms = profileTerms({ email: "pat@example.com", phone: "512-555-0100", first_name: "Pat", company: "Acme", contact: { linkedin: "linkedin.com/in/pat" } });
  assert.ok(terms.includes("pat@example.com") && terms.includes("5125550100") && terms.includes("Pat"));
  assert.ok(terms.includes("linkedin.com/in/pat"));
  assert.ok(!terms.includes("Acme"));
});

test("field summary never carries values", () => {
  const out = fieldSummary({ specs: [{ controls: [{ cid: "a", label: "Phone", value: "512-555-0100" }] }], statuses: { a: "filled" } });
  assert.equal(JSON.stringify(out).includes("555"), false);
});
