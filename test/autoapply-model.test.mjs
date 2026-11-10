import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RETRYABLE,
  appliedToday,
  arrangeQueue,
  closedWithoutSubmit,
  companyKey,
  easeLabel,
  filterHistory,
  formatDuration,
  nextRunnable,
  stageOf,
  successStats,
  timeAgo,
} from "../src/autoapply/model.js";

const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime();
const q = (id, tier, score, extra = {}) => ({ id, tier, score, title: id, company: "", platform: "greenhouse", ...extra });

test("arrangeQueue orders by ease, match or newest", () => {
  const queue = [q("a", 2, 90, { createdAt: 1 }), q("b", 1, 60, { createdAt: 3 }), q("c", 1, 80, { createdAt: 2 })];
  assert.deepEqual(arrangeQueue(queue, { order: "ease" }).map((j) => j.id), ["c", "b", "a"]);
  assert.deepEqual(arrangeQueue(queue, { order: "match" }).map((j) => j.id), ["a", "c", "b"]);
  assert.deepEqual(arrangeQueue(queue, { order: "newest" }).map((j) => j.id), ["b", "c", "a"]);
  assert.deepEqual(queue.map((j) => j.id), ["a", "b", "c"], "input untouched");
});

test("arrangeQueue puts pinned jobs first and keeps them past the score filter", () => {
  const queue = [q("a", 1, 90), q("b", 1, 40), q("c", 1, -1), q("d", 3, 75)];
  const out = arrangeQueue(queue, { order: "ease", minScore: 70, pinned: ["c"] });
  assert.deepEqual(out.map((j) => j.id), ["c", "a", "d"]);
});

test("arrangeQueue runs apply-later jobs after every other job, pins still first", () => {
  const queue = [q("a", 1, 90), q("b", 1, 80), q("c", 3, 50), q("d", 2, 70)];
  const later = new Set(["a", "d"]);
  assert.deepEqual(arrangeQueue(queue, { order: "ease", later }).map((j) => j.id), ["b", "c", "a", "d"]);
  assert.deepEqual(arrangeQueue(queue, { order: "match", later }).map((j) => j.id), ["b", "c", "a", "d"]);
  assert.deepEqual(arrangeQueue(queue, { order: "ease", later, pinned: ["d"] }).map((j) => j.id), ["d", "b", "c", "a"]);
});

test("apply-later and failed jobs are retryable, later does not count as an attempt", () => {
  assert.ok(RETRYABLE.has("later") && RETRYABLE.has("failed"));
  assert.ok(!RETRYABLE.has("invalid") && !RETRYABLE.has("needs_you"));
  const history = {
    a: { status: "later", at: NOW - 1000 },
    b: { status: "applied", at: NOW - 1000 },
    c: { status: "invalid", at: NOW - 1000 },
  };
  assert.deepEqual(successStats(history, { now: NOW }), { attempts: 1, applied: 1, filled: 0, rate: 100 });
});

test("a dry run's filled forms count as successes", () => {
  const history = {
    a: { status: "filled", at: NOW - 1000 },
    b: { status: "filled", at: NOW - 1000 },
    c: { status: "needs_you", at: NOW - 1000 },
    d: { status: "applied", at: NOW - 1000 },
  };
  assert.deepEqual(successStats(history, { now: NOW }), { attempts: 4, applied: 1, filled: 2, rate: 75 });
});

test("nextRunnable respects the per-company daily cap", () => {
  const queue = [q("a", 1, 90, { company: "Acme" }), q("b", 1, 80, { company: "Beta" })];
  const history = { x: { status: "applied", at: NOW - 1000, company: "acme " } };
  assert.equal(nextRunnable(queue, { history, runs: {}, perCompany: 0, now: NOW }), 0);
  assert.equal(nextRunnable(queue, { history, runs: {}, perCompany: 1, now: NOW }), 1);
  assert.equal(nextRunnable(queue, { history, runs: { y: { company: "Beta" } }, perCompany: 1, now: NOW }), -1);
  assert.equal(nextRunnable([], { perCompany: 0 }), -1);
});

test("nextRunnable never starts a second run at a company with a live run", () => {
  const queue = [q("a", 1, 90, { company: "Anika Systems, Inc." }), q("b", 1, 80, { company: "Beta" })];
  const runs = { live: { company: "Anika Systems" } };
  assert.equal(nextRunnable(queue, { history: {}, runs, perCompany: 0, now: NOW }), 1);
  assert.equal(nextRunnable(queue.slice(0, 1), { history: {}, runs, perCompany: 0, now: NOW }), -1);
  assert.equal(nextRunnable(queue, { history: {}, runs: {}, perCompany: 0, now: NOW }), 0);
});

test("companyKey ignores case, punctuation and legal suffixes", () => {
  assert.equal(companyKey("Anika Systems, Inc."), "anika systems");
  assert.equal(companyKey(" ANIKA systems "), "anika systems");
  assert.equal(companyKey("Idenhaus Consulting, Inc."), "idenhaus consulting");
  assert.equal(companyKey(""), "");
});

test("a submitted job whose tab is closed does not go back to the queue", () => {
  const left = { status: "needs_you", at: NOW - 1000, tabOpen: true };
  assert.equal(closedWithoutSubmit(left, NOW).status, "later");
  assert.equal(closedWithoutSubmit({ ...left, submitted: true }, NOW), null);
  assert.equal(closedWithoutSubmit({ status: "applied" }, NOW), null);
});

test("stageOf follows the runner's messages", () => {
  assert.equal(stageOf({ message: "Starting..." }), "open");
  assert.equal(stageOf({ platform: "lever", message: "Opening the job..." }), "open");
  assert.equal(stageOf({ platform: "lever", message: "Filling the application..." }), "fill");
  assert.equal(stageOf({ platform: "lever", message: "Submitting..." }), "submit");
  assert.equal(stageOf({ platform: "lever", message: "Waiting for the emailed verification code..." }), "verify");
  assert.equal(stageOf({ platform: "lever", message: "Marking applied..." }), "done");
});

test("history helpers count today, success rate and filters", () => {
  const history = {
    a: { status: "applied", at: NOW - 60_000, title: "Data Engineer", company: "Acme" },
    b: { status: "failed", at: NOW - 3600_000, title: "Analyst", company: "Beta", message: "No form" },
    c: { status: "skipped", at: NOW - 3600_000 },
    d: { status: "applied", at: NOW - 3 * 86400_000 },
  };
  assert.equal(appliedToday(history, NOW), 1);
  assert.deepEqual(successStats(history, { now: NOW }), { attempts: 3, applied: 2, filled: 0, rate: 67 });
  assert.deepEqual(successStats({}, { now: NOW }), { attempts: 0, applied: 0, filled: 0, rate: null });
  const entries = Object.entries(history);
  assert.deepEqual(filterHistory(entries, { status: "applied" }).map(([id]) => id), ["a", "d"]);
  assert.deepEqual(filterHistory(entries, { q: "no form" }).map(([id]) => id), ["b"]);
});

test("formatting helpers", () => {
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(timeAgo(NOW - 10_000, NOW), "just now");
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW), "5m ago");
  assert.equal(timeAgo(NOW - 3 * 3600_000, NOW), "3h ago");
  assert.equal(easeLabel("greenhouse"), "Easy");
  assert.equal(easeLabel("workday"), "Manual");
  assert.equal(easeLabel("board"), "Manual");
});

test("unqueue sends waiting jobs back to the queue, never an already submitted one", async () => {
  const { splitUnqueue } = await import("../src/autoapply/model.js");
  const history = {
    a: { status: "filled", tabOpen: true },
    b: { status: "needs_you", tabOpen: true },
    c: { status: "failed", tabOpen: true, submitted: true },
  };
  assert.deepEqual(splitUnqueue(history, ["a", "b", "c", "gone"]), { requeue: ["a", "b"], kept: ["c"] });
  assert.deepEqual(splitUnqueue(history, []), { requeue: [], kept: [] });
});

test("arrangeQueue by interview chance: tier first, then easier sites, then likelihood", async () => {
  const { chanceLabel } = await import("../src/autoapply/model.js");
  const queue = [
    q("lowEasy", 1, 95, { likelihoodTier: "low", likelihood: 0.004 }),
    q("highHard", 4, 60, { likelihoodTier: "high", likelihood: 0.03 }),
    q("highEasy", 1, 50, { likelihoodTier: "high", likelihood: 0.026 }),
    q("medium", 1, 99, { likelihoodTier: "medium", likelihood: 0.012 }),
    q("unknown", 1, 99),
  ];
  assert.deepEqual(arrangeQueue(queue, { order: "callback" }).map((j) => j.id), ["highEasy", "highHard", "medium", "lowEasy", "unknown"]);
  assert.deepEqual(arrangeQueue(queue).map((j) => j.id)[0], "highEasy", "interview chance is the default order");
  assert.equal(chanceLabel("high"), "High chance");
  assert.equal(chanceLabel(null), null);
});
