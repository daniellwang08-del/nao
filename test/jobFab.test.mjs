// "Open in NAO" corner button: which tabs get it, what it shows, and that pressing it opens
// the side panel on the job (or the web app when the panel cannot open).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../background.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (head) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `missing ${head}`);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j + 3);
};
const body = [
  grab("async function handOffEntry(tabId) {"),
  grab("async function jobForTab(tabId) {"),
  grab("async function rememberJobTab(tabId, jobId) {"),
  grab("async function fabState(tabId) {"),
  grab("function expandJob(tabId, windowId, sendResponse) {"),
  grab("async function repaintJobFab(tabId) {"),
  grab("async function fabActions(job) {"),
  grab("async function fabAction(tabId, action) {"),
].join("\n");

function area(initial = {}) {
  let data = { ...initial };
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(patch) {
      data = { ...data, ...patch };
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    dump: () => data,
  };
}

function load({ session = {}, local = {}, panelOpens = true, consoleOpen = false, panelOpen = false, replies = {} } = {}) {
  const calls = { order: [], messages: [], created: [], painted: [], api: [] };
  const chrome = {
    storage: { session: area(session), local: area(local) },
    sidePanel: {
      open: (opts) => {
        calls.order.push("open");
        calls.openedWindow = opts.windowId;
        return panelOpens ? Promise.resolve() : Promise.reject(new Error("no gesture"));
      },
    },
    runtime: { sendMessage: (m, cb) => { calls.messages.push(m); if (cb) cb(replies[m.type]); }, lastError: null },
    tabs: {
      create: async (t) => { calls.created.push(t.url); return { id: 99 }; },
      sendMessage: async (tabId, m) => { calls.painted.push([tabId, m]); },
    },
  };
  const api = {
    markApplied: async (ids) => { calls.api.push(["markApplied", ids]); return { marked: ids.length }; },
    reportJobInvalid: async (id, reason) => { calls.api.push(["reportJobInvalid", id, reason]); return {}; },
    updateSession: async () => ({}),
  };
  const make = new Function(
    "chrome", "getBackendUrl", "isAutoApplyConsoleOpen", "isPanelOpen", "api",
    `const AA_HANDOFF_PREFIX = "aaHandoff:"; const AA_TAB_PREFIX = "aaTab:"; const AA_FAB_PREFIX = "aaFab:";
     const AA_HISTORY_KEY = "aaHistory"; const PENDING_JOB_KEY = "pendingWebappJob";
     const APPLY_TAB_MAX_AGE_MS = 6 * 60 * 60 * 1000;
     ${body}
     return { jobForTab, rememberJobTab, fabState, expandJob, repaintJobFab, fabActions, fabAction };`,
  );
  const fns = make(chrome, async () => "https://nao.it.com", async () => consoleOpen, async () => panelOpen, api);
  return { ...fns, chrome, calls };
}

const now = Date.now();

test("every tab NAO opened for a job gets the button, not only hand-offs", async () => {
  const { jobForTab } = load({
    session: {
      "aaHandoff:1": { jobId: "j-hand" },
      "aaTab:2": { jobId: "j-run" },
      applyTabJobs: { 3: { jobId: "j-apply", at: now }, 4: { jobId: "j-old", at: now - 7 * 3600_000 } },
    },
  });
  assert.deepEqual(await jobForTab(1), { jobId: "j-hand", source: "handoff" });
  assert.deepEqual(await jobForTab(2), { jobId: "j-run", source: "autoapply" });
  assert.deepEqual(await jobForTab(3), { jobId: "j-apply", source: "apply" }); // opened from the panel or web app
  assert.equal(await jobForTab(4), null); // stale binding
  assert.equal(await jobForTab(5), null); // not a NAO tab
});

test("the button shows filling while auto-apply drives the tab, and how it left the job afterwards", async () => {
  const { fabState } = load({
    session: { "aaTab:2": { jobId: "j-run" }, "aaHandoff:1": { jobId: "j-hand" }, applyTabJobs: { 3: { jobId: "j3", at: now } } },
    local: { aaHistory: { "j-hand": { status: "needs_you", message: "CAPTCHA on the page." } } },
  });
  assert.equal((await fabState(2)).state, "running");
  assert.deepEqual(await fabState(1), { show: true, state: "needs", status: "needs_you", message: "CAPTCHA on the page." });
  assert.equal((await fabState(3)).state, "idle");
  assert.deepEqual(await fabState(7), { show: false });
});

test("Open in NAO opens the side panel first, then lands on the job", async () => {
  const { expandJob, calls, chrome } = load({ session: { applyTabJobs: { 3: { jobId: "j3", at: now } } } });
  const res = await new Promise((resolve) => {
    expandJob(3, 11, resolve);
    calls.order.push("returned"); // the panel must open before the handler yields
  });
  assert.deepEqual(calls.order.slice(0, 2), ["open", "returned"]);
  assert.equal(calls.openedWindow, 11);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.messages, [{ type: "WEBAPP_OPEN_PENDING_JOB", jobId: "j3" }]);
  assert.equal(chrome.storage.session.dump().pendingWebappJob.jobId, "j3"); // a panel that is still starting reads it
});

test("when the side panel cannot open, the job opens in the web app", async () => {
  const { expandJob, calls, chrome } = load({ session: { "aaHandoff:1": { jobId: "j1" } }, panelOpens: false });
  const res = await new Promise((resolve) => expandJob(1, 11, resolve));
  assert.deepEqual(res, { ok: true, fallback: true });
  assert.deepEqual(calls.created, ["https://nao.it.com/app/jobs?job=j1"]);
  assert.equal(chrome.storage.session.dump().pendingWebappJob, undefined);
});

test("a tab NAO no longer tracks gets a clear message", async () => {
  const { expandJob } = load();
  const res = await new Promise((resolve) => expandJob(5, 11, resolve));
  assert.equal(res.ok, false);
  assert.match(res.error, /no longer tracks/);
});

test("when auto-apply finishes, the button stops showing Filling and shows the outcome", async () => {
  const { repaintJobFab, chrome, calls } = load({ session: { "aaTab:2": { jobId: "j2" } } });
  await repaintJobFab(2);
  assert.equal(calls.painted.at(-1)[1].state, "running");
  // The run ends: the tab is no longer driven, it becomes a hand-off, history has the outcome.
  await chrome.storage.session.remove("aaTab:2");
  await chrome.storage.session.set({ "aaHandoff:2": { jobId: "j2" } });
  await chrome.storage.local.set({ aaHistory: { j2: { status: "needs_you", message: "2 fields need you." } } });
  await repaintJobFab(2);
  assert.deepEqual(calls.painted.at(-1), [
    2,
    { type: "AA_FAB_STATUS", state: "needs", message: "2 fields need you.", actions: { applied: true, invalid: true, skip: false } },
  ]);
});

test("tabs without a job button are left alone", async () => {
  const { repaintJobFab, calls } = load();
  await repaintJobFab(5);
  assert.equal(calls.painted.length, 0);
});

test("toolbar actions on an auto-apply tab go to the console, which closes the tab and moves the queue", async () => {
  const reply = { ok: true, state: "done", message: "Marked applied.", closing: true };
  const { fabAction, fabActions, calls } = load({ session: { "aaHandoff:1": { jobId: "j1" } }, consoleOpen: true, replies: { AA_TAB_ACTION: reply } });
  assert.deepEqual(await fabActions({ jobId: "j1", source: "handoff" }), { applied: true, invalid: true, skip: true });
  assert.deepEqual(await fabAction(1, "applied"), reply);
  assert.deepEqual(calls.messages.at(-1), { type: "AA_TAB_ACTION", jobId: "j1", tabId: 1, action: "applied" });
  assert.deepEqual(calls.api, []); // the console records it
});

test("a job the side panel opened is acted on by the panel", async () => {
  const reply = { ok: true, state: "idle", message: "Skipped." };
  const { fabAction, calls } = load({ session: { applyTabJobs: { 3: { jobId: "j3", at: now } } }, panelOpen: true, replies: { PAGE_JOB_ACTION: reply } });
  assert.deepEqual(await fabAction(3, "skip"), reply);
  assert.deepEqual(calls.messages.at(-1), { type: "PAGE_JOB_ACTION", jobId: "j3", tabId: 3, action: "skip" });
});

test("with neither the console nor the panel open, Applied and Invalid are recorded directly and Skip is not offered", async () => {
  const { fabAction, fabActions, calls } = load({ session: { applyTabJobs: { 3: { jobId: "j3", at: now } } } });
  assert.deepEqual(await fabActions({ jobId: "j3", source: "apply" }), { applied: true, invalid: true, skip: false });
  assert.equal((await fabAction(3, "applied")).ok, true);
  assert.equal((await fabAction(3, "invalid")).ok, true);
  assert.equal((await fabAction(3, "skip")).ok, false);
  assert.deepEqual(calls.api.map((c) => c[0]), ["markApplied", "reportJobInvalid"]);
  assert.equal((await fabAction(9, "applied")).ok, false); // not a NAO tab
});
