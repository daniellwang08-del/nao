// Workable refuses to submit ("You have unsaved changes") while its unsaved-changes context reports
// an Education / Experience group. page-bridge.js reads that context from the React fiber and
// answers in data-af-wb-unsaved; picker.js repairs flagged groups (reopen + Update).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const bridge = readFileSync(new URL("../content/engine/page-bridge.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = bridge.indexOf("  function workableUnsavedGroups(form) {");
const end = bridge.indexOf("\n  }\n", start) + 4;
assert.ok(start > 0, "workableUnsavedGroups not found in page-bridge.js");
const workableUnsavedGroups = vm.runInNewContext(`${bridge.slice(start, end)}\nworkableUnsavedGroups`);

function formWithProvider(value) {
  const provider = { memoizedProps: { value }, return: null };
  const mid = { memoizedProps: {}, return: provider };
  return { __reactFiber$abc: { memoizedProps: {}, return: mid } };
}

test("reads Workable's own unsaved groups from the React context", () => {
  const flagged = formWithProvider({ getGroupsWithUnsavedChanges: () => ({ experience: true }) });
  assert.deepEqual(workableUnsavedGroups(flagged), { experience: true });
  const clean = formWithProvider({ getGroupsWithUnsavedChanges: () => ({}) });
  assert.deepEqual(workableUnsavedGroups(clean), {});
});

test("an older form without that context answers null (unknown), never clean", () => {
  assert.equal(workableUnsavedGroups({ __reactFiber$abc: { memoizedProps: {}, return: null } }), null);
  assert.equal(workableUnsavedGroups({}), null);
});

test("the prep waits for each Update's debounced report before the next editor opens", () => {
  const picker = readFileSync(new URL("../content/picker.js", import.meta.url), "utf8");
  assert.match(picker, /const WB_SETTLE_MS = (\d+);/);
  assert.ok(Number(picker.match(/const WB_SETTLE_MS = (\d+);/)[1]) >= 400, "must outlast Workable's 200 ms debounce");
  assert.match(picker, /msg\.type === "AF_WB_SETTLE"/);
});
