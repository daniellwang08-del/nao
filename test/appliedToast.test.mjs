// "You applied" notifications: the background names the job, adds today's count, shows each application once,
// and shows it in the tab the user is looking at (or the auto-apply console page when that tab cannot take it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../background.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (head) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `missing ${head}`);
  return src.slice(i, src.indexOf("\n}\n", i) + 3);
};
const body = [
  grab("async function jobLabel(jobId, meta) {"),
  grab("async function appliedToday() {"),
  grab("async function showAppliedToast(payload) {"),
  grab("async function announceApplied(event) {"),
].join("\n");

function load({ activeUrl = "https://boards.greenhouse.io/acme/jobs/1", injectFails = false, history = {}, today = 7 } = {}) {
  const calls = { injected: [], toTab: [], broadcast: [] };
  const chrome = {
    storage: { local: { get: async () => ({ aaHistory: history }) } },
    tabs: {
      query: async () => [{ id: 5, url: activeUrl }],
      sendMessage: async (tabId, m) => calls.toTab.push([tabId, m]),
    },
    scripting: {
      executeScript: async (o) => {
        if (injectFails) throw new Error("no host permission");
        calls.injected.push(o.files[0]);
      },
    },
    runtime: { sendMessage: (m, cb) => { calls.broadcast.push(m); if (cb) cb(); }, lastError: null },
  };
  const api = {
    getHome: async () => ({ counts: { applied_today: today } }),
    getJob: async (id) => ({ title: `Title ${id}`, company: `Company ${id}` }),
  };
  const make = new Function(
    "chrome", "api",
    `const AA_HISTORY_KEY = "aaHistory"; const APPLIED_TOAST_FILE = "content/applied-toast.js"; const recentlyAnnounced = new Map();
     ${body}
     return { announceApplied };`,
  );
  return { ...make(chrome, api), calls };
}

test("an application shows once in the page the user is looking at, named and with today's count", async () => {
  const { announceApplied, calls } = load();
  await announceApplied({ jobIds: ["j1"], title: "Software Engineer", company: "Acme" });
  await announceApplied({ jobIds: ["j1"] }); // the same application reported twice
  assert.deepEqual(calls.injected, ["content/applied-toast.js"]);
  assert.deepEqual(calls.toTab, [[5, { type: "NAO_APPLIED_TOAST", title: "Software Engineer", company: "Acme", today: 7, count: 1 }]]);
});

test("the job is named from auto-apply history, then from the server", async () => {
  const { announceApplied, calls } = load({ history: { j2: { title: "Data Engineer", company: "Initech" } } });
  await announceApplied({ jobIds: ["j2"] });
  await announceApplied({ jobIds: ["j3"] });
  assert.deepEqual(calls.toTab.map(([, m]) => [m.title, m.company]), [["Data Engineer", "Initech"], ["Title j3", "Company j3"]]);
});

test("several jobs marked at once make one card", async () => {
  const { announceApplied, calls } = load();
  await announceApplied({ jobIds: ["a", "b", "c"] });
  assert.deepEqual(calls.toTab[0][1], { type: "NAO_APPLIED_TOAST", count: 3, today: 7 });
});

test("an extension page or a site NAO cannot reach gets it through the console page", async () => {
  const onConsole = load({ activeUrl: "chrome-extension://abc/autoapply.html" });
  await onConsole.announceApplied({ jobIds: ["j1"], title: "T", company: "C" });
  assert.equal(onConsole.calls.toTab.length, 0);
  assert.equal(onConsole.calls.broadcast[0].type, "NAO_APPLIED_TOAST");
  const blocked = load({ injectFails: true });
  await blocked.announceApplied({ jobIds: ["j1"], title: "T", company: "C" });
  assert.equal(blocked.calls.broadcast.length, 1);
});
