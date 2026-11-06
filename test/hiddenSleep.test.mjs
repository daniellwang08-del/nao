// Hidden (auto-apply) tabs: Chrome throttles page timers, so page waits run in the service worker
// (content/engine/dom.js sleep -> background.js NAO_SLEEP) and stay plain timers in a visible tab.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const dom = readFileSync(new URL("../content/engine/dom.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = dom.indexOf("  function sleep(ms) {");
const end = dom.indexOf("\n  }\n", start) + 4;
assert.ok(start > 0, "sleep() not found in dom.js");

function makeSleep({ visibility, runtime }) {
  const timers = [];
  const ctx = {
    document: { visibilityState: visibility },
    chrome: runtime ? { runtime } : undefined,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    Math,
    Number,
    Promise,
  };
  const sleep = vm.runInNewContext(`${dom.slice(start, end)}\nsleep`, ctx);
  return { sleep, timers };
}

test("a visible tab keeps plain timers", async () => {
  const sent = [];
  const { sleep, timers } = makeSleep({ visibility: "visible", runtime: { id: "x", sendMessage: (m) => sent.push(m) } });
  const p = sleep(150);
  assert.equal(sent.length, 0);
  assert.equal(timers[0].ms, 150);
  timers[0].fn();
  await p;
});

test("a hidden tab waits in the service worker and resumes on its reply", async () => {
  const sent = [];
  const { sleep } = makeSleep({
    visibility: "hidden",
    runtime: { id: "x", sendMessage: (m, cb) => { sent.push(m); cb(true); } },
  });
  await sleep(450);
  assert.equal(JSON.stringify(sent), JSON.stringify([{ type: "NAO_SLEEP", ms: 450 }]));
});

test("no reply from the worker still ends the wait (throttled fallback timer)", async () => {
  const { sleep, timers } = makeSleep({ visibility: "hidden", runtime: { id: "x", sendMessage: () => {} } });
  const p = sleep(100);
  assert.equal(timers.length, 1);
  timers[0].fn();
  await p;
});

test("the service worker answers NAO_SLEEP only for this extension's pages", () => {
  const bg = readFileSync(new URL("../background.js", import.meta.url), "utf8");
  assert.match(bg, /msg\.type === "NAO_SLEEP"/);
  assert.match(bg, /sender\.id !== chrome\.runtime\.id\) return false/);
});
