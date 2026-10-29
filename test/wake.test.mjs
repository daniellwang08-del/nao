import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const calls = [];
globalThis.chrome = {
  scripting: { executeScript: async (opts) => calls.push(["executeScript", opts]) },
  tabs: { update: async (...a) => calls.push(["tabs.update", a]) },
  windows: { update: async (...a) => calls.push(["windows.update", a]) },
  webNavigation: {
    onCommitted: {
      listeners: new Set(),
      addListener(fn) {
        this.listeners.add(fn);
      },
      removeListener(fn) {
        this.listeners.delete(fn);
      },
    },
  },
};

const { installShim, keepAwake, wakeTab } = await import("../src/autoapply/wake.js");

test("waking a tab injects into the page world and never activates a tab or window", async () => {
  calls.length = 0;
  await wakeTab(7);
  assert.equal(calls.length, 1);
  const [kind, opts] = calls[0];
  assert.equal(kind, "executeScript");
  assert.deepEqual(opts.target, { tabId: 7, allFrames: true });
  assert.equal(opts.world, "MAIN");
});

test("each new document in the run's tab gets the shim, other tabs do not", async () => {
  calls.length = 0;
  const stop = keepAwake(7);
  for (const fn of chrome.webNavigation.onCommitted.listeners) {
    fn({ tabId: 7, frameId: 3 });
    fn({ tabId: 8, frameId: 0 });
  }
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.map(([, o]) => o.target), [{ tabId: 7, frameIds: [3] }]);
  stop();
  assert.equal(chrome.webNavigation.onCommitted.listeners.size, 0);
});

test("the shim runs animation-frame callbacks while the tab is hidden", async () => {
  const nativeCalls = [];
  const doc = { visibilityState: "hidden" };
  const win = {
    requestAnimationFrame: (cb) => nativeCalls.push(cb) && 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const prev = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win;
  globalThis.document = doc;
  try {
    installShim();
    const ran = await new Promise((resolve) => win.requestAnimationFrame((t) => resolve(typeof t)));
    assert.equal(ran, "number");
    assert.equal(nativeCalls.length, 0);
    doc.visibilityState = "visible";
    win.requestAnimationFrame(() => {});
    assert.equal(nativeCalls.length, 1);
  } finally {
    globalThis.window = prev.window;
    globalThis.document = prev.document;
  }
});

test("auto-apply code never brings a tab or window to the front", () => {
  for (const file of ["../src/autoapply/runner.js", "../src/autoapply/wake.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /active:\s*true|focused:\s*true/, file);
    assert.doesNotMatch(src, /focusTab/, file);
  }
  const consoleSrc = readFileSync(new URL("../src/autoapply/console.js", import.meta.url), "utf8");
  const hooks = consoleSrc.slice(consoleSrc.indexOf("window.naoAutoApply"), consoleSrc.indexOf("// ── scheduling"));
  assert.doesNotMatch(hooks, /tabs\.update|windows\.update/);
  const workday = readFileSync(new URL("../src/panel/autofill/workday.js", import.meta.url), "utf8");
  const flush = workday.slice(workday.indexOf("async function focusPageAndFlush"));
  assert.ok(flush.indexOf("focusGate()") < flush.indexOf("chrome.windows.update"));
});
