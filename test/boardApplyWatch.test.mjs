import assert from "node:assert/strict";
import { test } from "node:test";

import { attachBoardApplyWatch, isBoardJobPage, isEmployerPage } from "../src/boardApplyWatch.js";

function event() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), fire: (...args) => listeners.forEach((fn) => fn(...args)) };
}

function setup() {
  const tabs = new Map();
  const chromeApi = {
    webNavigation: { onCommitted: event(), onCreatedNavigationTarget: event() },
    tabs: { onRemoved: event(), get: async (id) => ({ id, url: tabs.get(id) }) },
  };
  let clock = 1_000;
  const reports = [];
  attachBoardApplyWatch({ report: async (b, u) => reports.push([b, u]), now: () => clock, settleMs: 5, chromeApi });
  const commit = (tabId, url, transitionType = "link", transitionQualifiers = []) => {
    tabs.set(tabId, url);
    chromeApi.webNavigation.onCommitted.fire({ tabId, frameId: 0, url, transitionType, transitionQualifiers });
  };
  return {
    chromeApi,
    reports,
    commit,
    advance: (ms) => (clock += ms),
    settle: () => new Promise((r) => setTimeout(r, 30)),
  };
}

const DETAILS = "https://www.adzuna.com/details/5955317875";
const LAND = "https://www.adzuna.com/land/ad/5955317875?se=abc&utm_medium=api&v=1";
const ICAPITAL = "https://job-boards.greenhouse.io/icapitalnetwork/jobs/8919341002?utm_source=adzuna&utm_medium=adzuna";

test("board job pages and employer pages", () => {
  assert.ok(isBoardJobPage(DETAILS));
  assert.ok(isBoardJobPage(LAND));
  assert.ok(isBoardJobPage("https://jobright.ai/jobs/info/6aca522ad113c967e3c77995"));
  assert.ok(!isBoardJobPage("https://www.adzuna.com/search?q=engineer"));
  assert.ok(isEmployerPage(ICAPITAL));
  assert.ok(!isEmployerPage("https://www.adzuna.com/details/1234567"));
  assert.ok(!isEmployerPage("https://www.linkedin.com/jobs/view/1"));
  assert.ok(!isEmployerPage("chrome://newtab/"));
});

test("Apply on Adzuna, same tab: details -> land/ad -> employer page is reported once", async () => {
  const w = setup();
  w.commit(7, DETAILS, "typed");
  w.commit(7, LAND, "link");
  w.commit(7, ICAPITAL, "link", ["server_redirect"]);
  await w.settle();
  assert.deepEqual(w.reports, [[LAND, ICAPITAL]]);
});

test("Apply on Adzuna opening a new tab", async () => {
  const w = setup();
  w.commit(7, DETAILS, "link");
  w.chromeApi.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: 7, tabId: 9, url: LAND });
  w.commit(9, LAND, "link");
  w.commit(9, ICAPITAL, "link", ["server_redirect"]);
  await w.settle();
  assert.deepEqual(w.reports, [[LAND, ICAPITAL]]);
});

test("an Adzuna link that is not Apply (an ad, a company site) is never reported", async () => {
  const w = setup();
  w.commit(7, DETAILS, "link");
  w.commit(7, "https://www.icapitalnetwork.com/", "link");
  await w.settle();
  assert.deepEqual(w.reports, []);
});

test("typing an address, going back, or waiting too long ends the watch", async () => {
  const w = setup();
  w.commit(7, LAND, "link");
  w.commit(7, "https://example.com/careers/1", "typed");
  w.commit(8, LAND, "link");
  w.advance(200_000);
  w.commit(8, ICAPITAL, "link", ["server_redirect"]);
  w.commit(10, LAND, "link");
  w.commit(10, ICAPITAL, "link", ["forward_back"]);
  await w.settle();
  assert.deepEqual(w.reports, []);
});

test("a redirector hop keeps the watch and the settled employer page is reported", async () => {
  const w = setup();
  w.commit(7, LAND, "link");
  w.commit(7, "https://www.indeed.com/rc/clk?jk=1", "link", ["server_redirect"]);
  w.commit(7, ICAPITAL, "link", ["client_redirect"]);
  await w.settle();
  assert.deepEqual(w.reports, [[LAND, ICAPITAL]]);
});

test("Jobright Apply goes straight to the employer", async () => {
  const w = setup();
  const jr = "https://jobright.ai/jobs/info/6aca522ad113c967e3c77995";
  w.commit(3, jr, "link");
  w.chromeApi.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: 3, tabId: 4, url: "https://jobs.lever.co/acme/1" });
  w.commit(4, "https://jobs.lever.co/acme/1", "link");
  await w.settle();
  assert.deepEqual(w.reports, [[jr, "https://jobs.lever.co/acme/1"]]);
});
