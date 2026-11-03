import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

globalThis.window ??= { screen: { width: 1920, height: 1080 } };
globalThis.navigator ??= { userAgent: "node", language: "en-US" };

const api = await import("../src/api.js");
const storage = await import("../src/storage.js");
const { setState, state } = await import("../src/panel/state.js");
const { checkAppliedAlongside } = await import("../src/panel/autofill/form.js");

const flush = () => new Promise((r) => setTimeout(r, 0));

/** fetch answers with the queued apply-check bodies in order and records each request. */
function stubChecks(...bodies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    const body = bodies.length > 1 ? bodies.shift() : bodies[0];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

const JOB = { job_id: "j1", title: "Data Engineer", company: "Acme" };

beforeEach(async () => {
  await storage.setToken("tok");
  setState({ job: JOB, modal: null, toast: null });
});

test("applyCheck can ask the server not to wait for the inbox", async () => {
  const calls = stubChecks({ ok: true });
  await api.applyCheck("j1", { timezone: "UTC", wait: false });
  assert.match(calls[0].url, /\/assistant\/jobs\/j1\/apply-check$/);
  assert.deepEqual(calls[0].body, { sync_inbox: true, wait_for_inbox: false, timezone: "UTC" });
});

test("the applied check runs alongside the fill and stays quiet when clear", async () => {
  const calls = stubChecks({ ok: true, inbox_syncing: false });
  const result = await checkAppliedAlongside(JOB, { recheckMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(state.modal, null);
});

test("while the inbox syncs it looks again, then offers Stop or Continue", async () => {
  const calls = stubChecks(
    { ok: true, inbox_syncing: true },
    { ok: false, reason: "applied_company", message: "You applied to Acme on Oct 30, 2026, found in your email." },
  );
  const pending = checkAppliedAlongside(JOB, { recheckMs: 1 });
  for (let i = 0; i < 50 && !state.modal; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(calls.length, 2);
  assert.ok(state.modal, "a notice is shown");
  assert.equal(state.modal.title, "You already applied at this company");
  assert.equal(state.modal.confirmLabel, "Continue");
  assert.equal(state.modal.cancelLabel, "Stop");
  assert.match(state.modal.message, /Data Engineer at Acme: You applied to Acme/);
  state.modal.onConfirm(); // keep filling
  await pending;
  assert.equal(state.modal, null);
});

test("it gives up re-checking after a few tries and never blocks", async () => {
  const calls = stubChecks({ ok: true, inbox_syncing: true });
  const result = await checkAppliedAlongside(JOB, { retries: 2, recheckMs: 1 });
  assert.equal(result.inbox_syncing, true);
  assert.equal(calls.length, 3);
  await flush();
  assert.equal(state.modal, null);
});

test("a result for a job the user already left is ignored", async () => {
  stubChecks({ ok: false, reason: "already_applied", message: "You already applied." });
  const pending = checkAppliedAlongside(JOB, { recheckMs: 1 });
  setState({ job: { job_id: "other" } });
  await pending;
  assert.equal(state.modal, null);
});
