// Auto-apply console: picks ready-to-apply jobs in the order the user chose and
// runs several applications at once. Each application runs in its own hidden
// runner iframe (runner.js); this page schedules them, hands out the shared
// window focus, and keeps the history so a job is not attempted twice.

import * as api from "../api.js";
import { localTimezone } from "../panel/format.js";
import * as storage from "../storage.js";
import { html, render, useEffect, useState } from "../lib/preact.js";
import { Badge, Banner, Button, Empty, IconButton, Modal, Score, Segmented, Spinner, Toggle } from "../panel/ui/components.js";
import { Icon } from "../panel/ui/icons.js";
import {
  ORDERS,
  STAGES,
  appliedToday,
  CLOSED_UNSUBMITTED,
  RETRYABLE,
  closedWithoutSubmit,
  arrangeQueue,
  chanceLabel,
  easeLabel,
  easeTier,
  filterHistory,
  formatDuration,
  isWaiting,
  splitUnqueue,
  nextRunnable,
  stageIndex,
  stageOf,
  successStats,
  timeAgo,
} from "./model.js";
import { DEFAULT_SUBMIT_PLATFORMS, EASE_TIER, NEEDS_ACCOUNT, PLATFORM_LABEL, SPLIT_FROM_GENERIC, rankJobs } from "./platforms.js";

const SETTINGS_KEY = "aaSettings";
const HISTORY_KEY = "aaHistory";
const HISTORY_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const READY_PAGES = 3;
const LOG_MAX = 120;
const QUEUE_SHOWN = 60;

const FILL_PLATFORMS = Object.keys(EASE_TIER);
const ALL_PLATFORMS = [...FILL_PLATFORMS, ...NEEDS_ACCOUNT, "board"].sort((a, b) => easeTier(a) - easeTier(b));
// iCIMS makes an account per employer before every form, so it stays opt-in.
const RECOMMENDED_FILL = ALL_PLATFORMS.filter((p) => p !== "icims");
// The site default before every site but iCIMS was on.
const OLD_DEFAULT_FILL = FILL_PLATFORMS.filter((p) => p !== "generic" && !SPLIT_FROM_GENERIC.includes(p));
const SETTINGS_VERSION = 4;

const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  parallel: 3,
  dryRun: true,
  maxWaiting: 10,
  closeOnSuccess: true,
  platforms: RECOMMENDED_FILL,
  submitPlatforms: DEFAULT_SUBMIT_PLATFORMS,
  order: "callback",
  minScore: 0,
  perCompany: 0,
  runTimeoutMin: 14,
  showGuide: true,
};

// ── store ───────────────────────────────────────────────────────────────────

let store = {
  user: null,
  backendUrl: "",
  mail: null,
  settings: DEFAULT_SETTINGS,
  history: {},
  // Every ready job not yet attempted, ranked, on any site. The queue is the
  // part of it on enabled sites, minus skips, in the chosen order.
  available: [],
  pinned: [],
  skipped: [],
  runs: {},
  phase: "idle", // idle | running | paused
  pauseReason: null, // "waiting" when paused by the waiting-on-you limit
  loading: false,
  loadedAt: 0,
  account: null, // { appliedToday, ready } from the server
  notice: null,
  windowId: null,
  log: [],
  modal: null,
  sessionStartedAt: 0,
};
const listeners = new Set();

function set(patch) {
  store = { ...store, ...(typeof patch === "function" ? patch(store) : patch) };
  for (const fn of listeners) fn(store);
}

function useStore() {
  const [snap, setSnap] = useState(store);
  useEffect(() => {
    listeners.add(setSnap);
    setSnap(store);
    return () => listeners.delete(setSnap);
  }, []);
  return snap;
}

function useNow(fast) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

const label = (p) => PLATFORM_LABEL[p] || p || "Unknown site";

function log(tone, text) {
  set((s) => ({ log: [{ id: `${Date.now()}-${Math.random()}`, at: Date.now(), tone, text }, ...s.log].slice(0, LOG_MAX) }));
}

function notify(tone, text) {
  set({ notice: { tone, text } });
  log(tone, text);
}

function queueOf(s) {
  const enabled = new Set(s.settings.platforms);
  const skipped = new Set(s.skipped);
  return arrangeQueue(
    s.available.filter((q) => enabled.has(q.platform) && !skipped.has(q.id)),
    { order: s.settings.order, minScore: s.settings.minScore, pinned: s.pinned, later: laterIds(s.history) },
  );
}

function laterIds(history) {
  return new Set(Object.keys(history).filter((id) => history[id].status === "later"));
}

function waitingOnYou(history, runs) {
  const open = Object.values(history).filter((h) => (h.status === "needs_you" || h.status === "filled") && h.tabOpen).length;
  return open + Object.values(runs).filter((r) => r.status === "needs_you").length;
}

/** Saved settings over the defaults. Sites still on the old default move to the new one. */
function loadedSettings(saved) {
  const { dailyCap: _retired, ...kept } = saved || {};
  const settings = { ...DEFAULT_SETTINGS, ...kept, version: SETTINGS_VERSION };
  const untouched =
    Array.isArray(kept.platforms) &&
    kept.platforms.length === OLD_DEFAULT_FILL.length &&
    OLD_DEFAULT_FILL.every((p) => kept.platforms.includes(p));
  if ((kept.version || 1) < 2 && untouched) settings.platforms = RECOMMENDED_FILL;
  // Version 3 made interview chance the default order; move the old default with it.
  if ((kept.version || 1) < 3 && (kept.order || "ease") === "ease") settings.order = "callback";
  // Version 4: Dayforce, ADP and Oracle got their own engines; their jobs used to count as Career sites, so whoever
  // had Career sites on keeps applying to them.
  if ((kept.version || 1) < 4 && Array.isArray(settings.platforms) && settings.platforms.includes("generic")) {
    settings.platforms = [...new Set([...settings.platforms, ...SPLIT_FROM_GENERIC])];
  }
  return settings;
}

async function saveSettings(patch) {
  const settings = { ...store.settings, ...patch };
  set({ settings });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  if (store.phase === "running") pump();
}

async function saveHistory(history) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const kept = Object.fromEntries(Object.entries(history).filter(([, h]) => h.at >= cutoff));
  set({ history: kept });
  await chrome.storage.local.set({ [HISTORY_KEY]: kept });
}

// ── runner hooks (called from runner iframes) ───────────────────────────────

const otpWaiting = new Set();
const frames = new Map();
const timers = new Map();
// A runner that never reports (its page failed to load) must not hold a slot until the run times out.
const bootTimers = new Map();
const RUNNER_BOOT_MS = 45_000;

let deadBoots = 0;

function markAlive(jobId) {
  const t = bootTimers.get(jobId);
  if (!t) return;
  clearTimeout(t);
  bootTimers.delete(jobId);
  deadBoots = 0;
}

window.naoAutoApply = {
  config(jobId) {
    if (jobId) markAlive(jobId);
    return {
      dryRun: store.settings.dryRun,
      submitPlatforms: store.settings.submitPlatforms,
      windowId: store.windowId,
    };
  },
  update(jobId, patch) {
    markAlive(jobId);
    set((s) => (s.runs[jobId] ? { runs: { ...s.runs, [jobId]: { ...s.runs[jobId], ...patch } } } : {}));
    const run = store.runs[jobId];
    if (run && run.refillTabId != null && patch.message) tellPage(run.refillTabId, "running", patch.message);
  },
  finish(jobId, outcome) {
    void finishRun(jobId, outcome);
  },
  otpWait(jobId, on) {
    if (on) otpWaiting.add(jobId);
    else otpWaiting.delete(jobId);
  },
  otpWaiters() {
    return otpWaiting.size;
  },
};

// ── scheduling ──────────────────────────────────────────────────────────────

async function ensureWindow() {
  if (store.windowId != null) {
    try {
      await chrome.windows.get(store.windowId);
      return store.windowId;
    } catch {
      /* closed by the user */
    }
  }
  const win = await chrome.windows.create({ focused: false, state: "normal", width: 1280, height: 900 });
  set({ windowId: win.id });
  return win.id;
}

// The account's own numbers (the panel and web app show these), so the
// console agrees with them instead of counting only its local history.
async function loadAccount() {
  const data = await api.getHome(localTimezone()).catch(() => null);
  if (data && data.counts) set({ account: { appliedToday: Number(data.counts.applied_today) || 0, ready: Number(data.counts.ready) || 0 } });
}

async function loadQueue() {
  set({ loading: true });
  void loadAccount();
  try {
    const rows = [];
    for (let page = 1; page <= READY_PAGES; page++) {
      const data = await api.getJobs({ view: "ready", page, per_page: 200, sort: "created_at", order: "desc" });
      const items = (data && data.items) || [];
      rows.push(...items);
      if (!items.length || rows.length >= Number((data && data.total) || 0)) break;
    }
    const attempted = new Set(Object.keys(store.history).filter((id) => !RETRYABLE.has(store.history[id].status)));
    for (const id of Object.keys(store.runs)) attempted.add(id);
    const available = rankJobs(rows, { allowed: new Set(ALL_PLATFORMS), skip: attempted });
    set({ available, loading: false, loadedAt: Date.now() });
    return available;
  } catch (err) {
    set({ loading: false });
    notify("danger", (err && err.message) || "Could not load ready jobs.");
    return [];
  }
}

/**
 * Bring the inbox up to date without holding the run: jobs were already
 * checked against it before they were scored, the sync only reads mail newer
 * than the last one, and each job is checked again when it is reached.
 */
function refreshInboxInBackground() {
  api
    .refreshInbox(localTimezone())
    .then((res) => {
      if (res && res.connected && !res.fresh) {
        log("info", "Your inbox is still syncing. Each job is checked against it again before submitting.");
      }
    })
    .catch(() => {});
}

function pump() {
  if (store.phase !== "running") return;
  const { settings } = store;
  while (Object.keys(store.runs).length < settings.parallel) {
    const queue = queueOf(store);
    if (!queue.length) break;
    if (waitingOnYou(store.history, store.runs) >= settings.maxWaiting) {
      pause(
        `${settings.maxWaiting} applications are waiting on you. Finish them or set them aside for later, and auto-apply continues.`,
        "warn",
        "waiting",
      );
      return;
    }
    const idx = nextRunnable(queue, { history: store.history, runs: store.runs, perCompany: settings.perCompany });
    if (idx < 0) {
      if (!Object.keys(store.runs).length) {
        set({ phase: "idle" });
        notify("info", "The remaining jobs are held back by the per-company limit for today.");
      }
      return;
    }
    startRun(queue[idx]);
  }
  if (!Object.keys(store.runs).length && !queueOf(store).length) {
    set({ phase: "idle" });
    notify("ok", "Queue finished.");
  }
}

function startRun(job, { refillTabId = null } = {}) {
  set((s) => ({
    available: s.available.filter((q) => q.id !== job.id),
    pinned: s.pinned.filter((id) => id !== job.id),
    runs: {
      ...s.runs,
      [job.id]: {
        ...job,
        status: "running",
        message: "Starting...",
        startedAt: Date.now(),
        ...(refillTabId != null ? { refillTabId, tabId: refillTabId } : {}),
      },
    },
  }));
  const where = `${job.title}${job.company ? ` at ${job.company}` : ""}`;
  log("info", refillTabId != null ? `Filling ${where} again in its tab.` : `Started ${where} (${label(job.platform)}).`);
  const frame = document.createElement("iframe");
  frame.src =
    `autoapply-runner.html?job=${encodeURIComponent(job.id)}` +
    (refillTabId != null ? `&tab=${encodeURIComponent(String(refillTabId))}` : "");
  frame.hidden = true;
  frames.set(job.id, frame);
  document.body.appendChild(frame);
  bootTimers.set(
    job.id,
    setTimeout(() => {
      bootTimers.delete(job.id);
      deadBoots += 1;
      if (deadBoots >= 2 && store.phase === "running") {
        pause("Auto-apply paused: its runner page is not starting. Reload the extension on chrome://extensions, then resume.", "danger");
      }
      void finishRun(job.id, {
        status: "failed",
        message: "The auto-apply runner did not start. Reload the extension on chrome://extensions and try again.",
      });
    }, RUNNER_BOOT_MS),
  );
  const limitMin = store.settings.runTimeoutMin;
  timers.set(
    job.id,
    setTimeout(
      () =>
        void finishRun(job.id, {
          status: "needs_you",
          message: `Took longer than ${limitMin} minutes. The page is left open for you.`,
          // Still waiting on the site after Submit: treat it as sent.
          submitted: Boolean(store.runs[job.id] && store.runs[job.id].submittedAt),
        }),
      limitMin * 60_000,
    ),
  );
}

async function rememberHandOff(tabId, jobId) {
  // The background watches this tab and marks the job applied when the user submits.
  try {
    const { applyTabJobs } = await chrome.storage.session.get("applyTabJobs");
    await chrome.storage.session.set({
      applyTabJobs: { ...(applyTabJobs || {}), [String(tabId)]: { jobId, at: Date.now() } },
      ["aaHandoff:" + tabId]: { jobId, at: Date.now() },
    });
  } catch {
    /* advisory */
  }
  // Not every fill engine leaves the submit watcher on the page.
  await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ["content/submit-watch.js"] })
    .catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/job-fab.js"] }).catch(() => {});
}

// ── "Fill again" from the page's corner button ──────────────────────────────

const FAB_KEY = "aaFab:";

/** Live state for the corner button on a tab; the background serves it after a reload. */
function tellPage(tabId, state, message) {
  if (state === "running") void chrome.storage.session.set({ [FAB_KEY + tabId]: { state, message, at: Date.now() } }).catch(() => {});
  else void chrome.storage.session.remove(FAB_KEY + tabId).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: "AA_FAB_STATUS", state, message }).catch(() => {});
}

const FAB_RESULT = { filled: "done", applied: "done", needs_you: "needs" };

async function refillTab(jobId, tabId) {
  if (!store.user) return { ok: false, error: "Sign in to the NAO extension first." };
  if (store.runs[jobId]) return { ok: false, error: "NAO is already filling this application." };
  if (!(await chrome.tabs.get(tabId).catch(() => null))) return { ok: false, error: "The application tab is gone." };
  const h = entryFor(jobId) || {};
  const job = {
    id: jobId,
    title: h.title || "Application",
    company: h.company || "",
    platform: h.platform || "",
    score: h.score,
    url: h.url || "",
    submitted: Boolean(h.submitted),
  };
  // The run reports into history again when it ends; until then it shows as a live run.
  if (store.history[jobId]) {
    const history = { ...store.history };
    delete history[jobId];
    await saveHistory(history);
  }
  startRun(job, { refillTabId: tabId });
  tellPage(tabId, "running", "Starting...");
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!(msg && msg.type === "AA_REFILL_REQUEST" && msg.jobId && msg.tabId != null)) return false;
  refillTab(String(msg.jobId), Number(msg.tabId))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: (err && err.message) || "Could not start filling." }));
  return true;
});

// The corner buttons on a job's page: Applied / Invalid / Skip, as if pressed here.
async function tabAction(jobId, action) {
  if (!entryFor(jobId) && !store.runs[jobId]) return null; // not this console's job
  if (store.runs[jobId]) await finishRun(jobId, { status: "needs_you", message: "Stopped by you on the page." });
  if (action === "applied") {
    await markEntriesApplied([jobId]);
    return { ok: true, state: "done", message: "Marked applied.", closing: true };
  }
  if (action === "invalid") {
    await markInvalid(jobId);
    return { ok: true, state: "idle", message: "Marked invalid.", closing: true };
  }
  if (action === "skip") {
    await applyLater([jobId]);
    return { ok: true, state: "idle", message: "Set aside to try again after the rest of the queue.", closing: true };
  }
  return { ok: false, error: "Unknown action." };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!(msg && msg.type === "AA_TAB_ACTION" && msg.jobId)) return false;
  tabAction(String(msg.jobId), String(msg.action || ""))
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: (err && err.message) || "Could not do that." }));
  return true;
});

/** A "Fill again" press that opened this console. */
async function takePendingRefill() {
  const { aaRefillPending: p } = await chrome.storage.session.get("aaRefillPending").catch(() => ({}));
  if (!p) return;
  await chrome.storage.session.remove("aaRefillPending").catch(() => {});
  if (Date.now() - Number(p.at || 0) > 60_000) return;
  const res = await refillTab(String(p.jobId), Number(p.tabId));
  if (!res.ok) tellPage(Number(p.tabId), "error", res.error);
}

const OUTCOME_TONE = { applied: "ok", filled: "info", needs_you: "warn", skipped: "muted", failed: "danger", later: "info", invalid: "muted" };

async function finishRun(jobId, outcome) {
  const run = store.runs[jobId];
  if (!run) return;
  clearTimeout(timers.get(jobId));
  timers.delete(jobId);
  markAlive(jobId);
  const frame = frames.get(jobId);
  if (frame) frame.remove();
  frames.delete(jobId);
  otpWaiting.delete(jobId);

  const tabId = outcome.tabId != null ? outcome.tabId : run.tabId;
  if (run.submitted) outcome = { ...outcome, submitted: true };
  let status = outcome.status || "failed";
  const tabGone = tabId != null && !(await chrome.tabs.get(tabId).catch(() => null));
  // The user closed the run's tab mid-way: same as closing a hand-off tab.
  if (tabGone && closedWithoutSubmit({ status, submitted: outcome.submitted })) {
    status = "later";
    outcome = { ...outcome, message: CLOSED_UNSUBMITTED };
  }
  let tabOpen = tabId != null && !tabGone;
  if (status === "applied" && tabId != null && store.settings.closeOnSuccess) {
    await chrome.tabs.remove(tabId).catch(() => {});
    tabOpen = false;
  } else if ((status === "needs_you" || status === "filled" || status === "failed") && tabId != null) {
    await chrome.storage.session.remove("aaTab:" + tabId).catch(() => {});
    await rememberHandOff(tabId, jobId);
  } else if (tabId != null && status === "skipped") {
    await chrome.tabs.remove(tabId).catch(() => {});
    tabOpen = false;
  } else if (status === "invalid") {
    try {
      await api.reportJobInvalid(jobId, `Auto-apply: ${outcome.message || "posting no longer available."}`.slice(0, 500));
    } catch (err) {
      log("warn", `Could not hide ${run.title || "the job"} from your lists: ${(err && err.message) || "request failed"}.`);
    }
    set((s) => ({ available: s.available.filter((q) => q.id !== jobId), pinned: s.pinned.filter((p) => p !== jobId) }));
    if (tabId != null) {
      await chrome.storage.session.remove("aaTab:" + tabId).catch(() => {});
      await chrome.tabs.remove(tabId).catch(() => {});
    }
    tabOpen = false;
  }

  const entry = {
    status,
    message: outcome.message || "",
    at: Date.now(),
    startedAt: run.startedAt,
    title: run.title,
    company: run.company,
    platform: run.platform,
    score: run.score,
    url: run.url,
    tabId,
    tabOpen,
    ...(outcome.submitted ? { submitted: true } : {}),
  };
  const runs = { ...store.runs };
  delete runs[jobId];
  set({ runs });
  if (run.refillTabId != null && tabOpen) tellPage(run.refillTabId, FAB_RESULT[status] || "error", entry.message);
  log(OUTCOME_TONE[status] || "muted", `${STATUS[status] ? STATUS[status].label : status}: ${run.title}. ${entry.message}`.trim());
  await saveHistory({ ...store.history, [jobId]: entry });
  if (store.phase === "paused" && !Object.keys(store.runs).length) notify("info", "Paused. Running applications have finished.");
  if (status === "later") await loadQueue();
  else if (status === "applied") void loadAccount();
  pump();
}

function stopRun(jobId) {
  void finishRun(jobId, { status: "needs_you", message: "Stopped by you. The page is left as it was." });
}

async function laterRun(jobId) {
  await finishRun(jobId, { status: "needs_you", message: "Stopped by you." });
  await applyLater([jobId]);
}

function pause(message, tone = "info", reason = null) {
  set({ phase: "paused", pauseReason: reason });
  if (message) notify(tone, message);
}

/** A run paused only because too many jobs were waiting continues once the user clears some. */
function resumeIfUnblocked() {
  if (store.phase !== "paused" || store.pauseReason !== "waiting") return;
  if (waitingOnYou(store.history, store.runs) >= store.settings.maxWaiting) return;
  set({ notice: null });
  log("info", "Fewer applications are waiting on you, so auto-apply continued.");
  resume();
}

function stopAll(message) {
  set({ phase: "idle", pinned: [], pauseReason: null });
  for (const jobId of Object.keys(store.runs)) {
    void finishRun(jobId, { status: "needs_you", message: "Stopped. The page is left as it was." });
  }
  if (message) notify("warn", message);
}

async function start() {
  // Must be the first await: the permission prompt needs the click's gesture.
  const granted = await chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false);
  if (!granted) {
    notify("danger", "Auto-apply needs access to job sites to fill applications.");
    return;
  }
  set({ phase: "running", notice: null, sessionStartedAt: Date.now() });
  log("info", store.settings.dryRun ? "Started in dry run: forms are filled, never submitted." : "Started live: applications are submitted.");
  try {
    await ensureWindow();
  } catch {
    set({ windowId: null });
  }
  refreshInboxInBackground();
  await loadQueue();
  if (!queueOf(store).length && !Object.keys(store.runs).length) {
    set({ phase: "idle" });
    notify("info", "No ready-to-apply jobs match these settings.");
    return;
  }
  pump();
}

function resume() {
  set({ phase: "running", notice: null, pauseReason: null });
  log("info", "Resumed.");
  pump();
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

async function openEntry(jobId) {
  const h = store.history[jobId];
  if (!h) return;
  if (h.tabId != null && (await focusTab(h.tabId))) return;
  if (h.url) {
    const tab = await chrome.tabs.create({ url: h.url, active: true });
    await rememberHandOff(tab.id, jobId);
    await saveHistory({ ...store.history, [jobId]: { ...h, tabId: tab.id, tabOpen: true } });
  }
}

async function markEntriesApplied(jobIds) {
  if (!jobIds.length) return;
  try {
    await api.markApplied(jobIds, jobIds.length === 1 ? entryFor(jobIds[0]) : null);
  } catch (err) {
    notify("danger", (err && err.message) || "Could not mark them applied.");
    return;
  }
  const history = { ...store.history };
  const tabs = [];
  for (const id of jobIds) {
    const h = history[id] || {};
    api.updateSession(id, "completed").catch(() => {});
    if (h.tabId != null && h.tabOpen) tabs.push(h.tabId);
    history[id] = { ...h, status: "applied", message: "Marked applied by you.", at: Date.now(), tabOpen: false };
  }
  await saveHistory(history);
  for (const tabId of tabs) await chrome.tabs.remove(tabId).catch(() => {});
  log("ok", jobIds.length === 1 ? `Marked applied: ${history[jobIds[0]].title || "job"}.` : `Marked ${jobIds.length} jobs applied.`);
  resumeIfUnblocked();
}

/** Back into the queue at its normal place; open tabs are closed so the retry starts clean. */
async function retryEntries(jobIds) {
  if (!jobIds.length) return;
  const history = { ...store.history };
  const tabs = [];
  for (const id of jobIds) {
    const h = history[id];
    if (h && h.tabOpen && h.tabId != null && isWaiting(h)) tabs.push(h.tabId);
    delete history[id];
  }
  await saveHistory(history);
  for (const tabId of tabs) {
    await chrome.storage.session.remove("aaHandoff:" + tabId).catch(() => {});
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  await loadQueue();
  if (store.phase === "running") pump();
  resumeIfUnblocked();
}

/**
 * Unqueue: waiting jobs leave Waiting on you and go back to the to-do queue at
 * their normal place (not apply later), so they are filled again from scratch
 * when the run reaches them, now or after the user starts again. Their tabs close.
 */
async function unqueueEntries(jobIds) {
  const { requeue, kept } = splitUnqueue(store.history, jobIds);
  if (requeue.length) {
    const title = (store.history[requeue[0]] || {}).title || "job";
    await retryEntries(requeue);
    log("info", requeue.length === 1 ? `Back in the queue: ${title}.` : `${requeue.length} jobs moved back to the queue.`);
  }
  if (kept.length) {
    notify(
      "warn",
      `${kept.length} job${kept.length === 1 ? " was" : "s were"} already submitted, so ${kept.length === 1 ? "it stays" : "they stay"} in Waiting on you. Mark ${kept.length === 1 ? "it" : "them"} applied once you see the confirmation.`,
    );
  }
}

const markEntryApplied = (jobId) => markEntriesApplied([jobId]);
const forgetEntry = (jobId) => retryEntries([jobId]);

function entryFor(jobId) {
  const h = store.history[jobId];
  if (h) return h;
  const q = store.available.find((j) => j.id === jobId);
  return q ? { title: q.title, company: q.company, platform: q.platform, score: q.score, url: q.url, tabId: null } : null;
}

/** Close the jobs' tabs and queue them again after every job not set aside. */
async function applyLater(jobIds) {
  const history = { ...store.history };
  const tabs = [];
  for (const id of jobIds) {
    const h = entryFor(id);
    if (!h) continue;
    if (h.tabOpen && h.tabId != null) tabs.push(h.tabId);
    history[id] = { ...h, status: "later", message: "Set aside to try again after the rest of the queue.", at: Date.now(), tabOpen: false };
  }
  set((s) => ({ pinned: s.pinned.filter((p) => !jobIds.includes(p)), skipped: s.skipped.filter((p) => !jobIds.includes(p)), modal: null }));
  await saveHistory(history);
  for (const tabId of tabs) await chrome.tabs.remove(tabId).catch(() => {});
  log("info", jobIds.length === 1 ? `Apply later: ${history[jobIds[0]]?.title || "job"}.` : `${jobIds.length} jobs moved to apply later.`);
  await loadQueue();
  if (store.phase === "running") pump();
  resumeIfUnblocked();
}

/** Hide the job from the user's lists and never try it again. */
async function markInvalid(jobId) {
  const h = entryFor(jobId);
  if (!h) return;
  try {
    await api.reportJobInvalid(jobId, `Marked invalid from auto-apply${h.message ? `: ${h.message}` : "."}`.slice(0, 500));
  } catch (err) {
    notify("danger", (err && err.message) || "Could not mark the job invalid.");
    return;
  }
  set((s) => ({
    available: s.available.filter((q) => q.id !== jobId),
    pinned: s.pinned.filter((p) => p !== jobId),
  }));
  // Saved before the tab closes, or the close would move it to apply later.
  await saveHistory({
    ...store.history,
    [jobId]: { ...h, status: "invalid", message: "Marked invalid. Hidden from your job lists.", at: Date.now(), tabOpen: false },
  });
  if (h.tabOpen && h.tabId != null) await chrome.tabs.remove(h.tabId).catch(() => {});
  log("muted", `Marked invalid: ${h.title || "job"}.`);
  if (store.phase === "running") pump();
  resumeIfUnblocked();
}

async function clearFinished() {
  const keep = (h) => isWaiting(h) || h.status === "applied" || h.status === "later" || h.status === "invalid";
  const kept = Object.fromEntries(Object.entries(store.history).filter(([, h]) => keep(h)));
  await saveHistory(kept);
  set({ modal: null });
  log("info", "Cleared finished attempts. Skipped and failed jobs can be tried again.");
  await loadQueue();
}

function pinNext(id) {
  set((s) => ({ pinned: [id, ...s.pinned.filter((p) => p !== id)], skipped: s.skipped.filter((x) => x !== id) }));
  if (store.phase === "running") pump();
}

function skipJob(id) {
  set((s) => ({ skipped: [...s.skipped, id], pinned: s.pinned.filter((p) => p !== id) }));
}

function setLive(live) {
  if (!live) return void saveSettings({ dryRun: true });
  set({
    modal: {
      title: "Submit applications for real?",
      message: "Auto-apply will press Submit on the sites you allow, for every job in the queue. Dry run only fills forms so you can review them first.",
      confirmLabel: "Turn on live mode",
      onConfirm: () => {
        set({ modal: null });
        void saveSettings({ dryRun: false });
        log("warn", "Live mode on: applications will be submitted.");
      },
    },
  });
}

// Entries waiting on the user are the background's: it moves them to apply
// later when their tab closes. Any other entry only needs its flag cleared.
chrome.tabs.onRemoved.addListener((tabId) => {
  const hit = Object.entries(store.history).find(([, h]) => h.tabId === tabId && h.tabOpen && !closedWithoutSubmit(h));
  if (hit) void saveHistory({ ...store.history, [hit[0]]: { ...hit[1], tabOpen: false } }).then(resumeIfUnblocked);
});

// The background rewrote the history: the user submitted a handed-off tab, or
// closed one without submitting.
chrome.storage.local.onChanged.addListener((changes) => {
  const next = changes[HISTORY_KEY] && changes[HISTORY_KEY].newValue;
  if (!next) return;
  const before = laterIds(store.history);
  set({ history: next });
  if ([...laterIds(next)].some((id) => !before.has(id))) {
    void loadQueue().then(() => {
      if (store.phase === "running") pump();
    });
  }
  resumeIfUnblocked();
});

// ── UI ──────────────────────────────────────────────────────────────────────

const STATUS = {
  running: { tone: "brand", label: "Working" },
  applied: { tone: "ok", label: "Applied" },
  filled: { tone: "brand", label: "Filled" },
  needs_you: { tone: "warn", label: "Needs you" },
  skipped: { tone: "muted", label: "Skipped" },
  failed: { tone: "danger", label: "Failed" },
  later: { tone: "brand", label: "Apply later" },
  invalid: { tone: "muted", label: "Invalid" },
};

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.failed;
  return html`<${Badge} tone=${s.tone} dot=${status === "running"}>${s.label}</${Badge}>`;
}

function PlatformChip({ platform }) {
  return html`<span class=${`aa-chip aa-tier-${Math.min(easeTier(platform), 5)}`} title=${`${label(platform)}: ${easeLabel(platform)}`}>${label(platform)}</span>`;
}

function Card({ title, icon, meta, action, children, class: cls = "", hint }) {
  return html`<section class=${`aa-card ${cls}`}>
    ${title
      ? html`<header class="aa-card-head">
          <div class="aa-card-heading">
            ${icon ? html`<span class="aa-card-icon"><${Icon} name=${icon} size=${15} /></span>` : null}
            <div>
              <h2>${title}${meta != null ? html` <span class="aa-card-meta">${meta}</span>` : null}</h2>
              ${hint ? html`<p class="aa-card-hint">${hint}</p>` : null}
            </div>
          </div>
          ${action ? html`<div class="aa-card-action">${action}</div>` : null}
        </header>`
      : null}
    ${children}
  </section>`;
}

function RangeField({ label: text, hint, value, min, max, step = 1, format = (v) => String(v), onChange, disabled }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const pct = ((draft - min) / (max - min)) * 100;
  return html`<label class=${`aa-range${disabled ? " is-disabled" : ""}`}>
    <span class="aa-range-top">
      <span class="aa-range-label">${text}</span>
      <span class="aa-range-value">${format(draft)}</span>
    </span>
    <input
      type="range"
      min=${min}
      max=${max}
      step=${step}
      value=${draft}
      disabled=${disabled}
      style=${`--pct:${pct}%`}
      onInput=${(e) => setDraft(Number(e.currentTarget.value))}
      onChange=${(e) => onChange(Number(e.currentTarget.value))}
    />
    ${hint ? html`<span class="aa-range-hint">${hint}</span>` : null}
  </label>`;
}

function Field({ label: text, hint, children }) {
  return html`<div class="aa-field">
    <span class="aa-range-label">${text}</span>
    ${children}
    ${hint ? html`<span class="aa-range-hint">${hint}</span>` : null}
  </div>`;
}

function Meter({ value, max, tone = "brand" }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return html`<span class=${`aa-meter aa-meter-${tone}`} role="progressbar" aria-valuenow=${value} aria-valuemax=${max}>
    <span style=${`width:${pct}%`}></span>
  </span>`;
}

function Stat({ icon, label: text, value, sub, tone = "brand", meter }) {
  return html`<div class=${`aa-stat aa-stat-${tone}`}>
    <span class="aa-stat-icon"><${Icon} name=${icon} size=${16} /></span>
    <div class="aa-stat-body">
      <span class="aa-stat-label">${text}</span>
      <span class="aa-stat-value">${value}</span>
      ${meter || null}
      ${sub ? html`<span class="aa-stat-sub">${sub}</span>` : null}
    </div>
  </div>`;
}

function PhasePill({ phase, dryRun, busy, slots }) {
  const meta = {
    idle: { cls: "idle", text: "Idle" },
    running: { cls: "running", text: `Running, ${busy} of ${slots} slots busy` },
    paused: { cls: "paused", text: busy ? `Pausing, finishing ${busy}` : "Paused" },
  }[phase];
  return html`<span class="aa-pills">
    <span class=${`aa-phase aa-phase-${meta.cls}`}><i></i>${meta.text}</span>
    <span class=${`aa-mode-tag${dryRun ? "" : " is-live"}`}>${dryRun ? "Dry run" : "Live"}</span>
  </span>`;
}

function Header({ s }) {
  const busy = Object.keys(s.runs).length;
  const queued = queueOf(s).length;
  return html`<header class="aa-top">
    <div class="aa-brand">
      <img src="icons/icon48.png" alt="" width="28" height="28" />
      <div>
        <h1>Auto-apply</h1>
        <${PhasePill} phase=${s.phase} dryRun=${s.settings.dryRun} busy=${busy} slots=${s.settings.parallel} />
      </div>
    </div>
    <div class="aa-top-controls">
      <div class=${`aa-mode${s.phase !== "idle" ? " is-locked" : ""}`} title=${s.phase !== "idle" ? "Stop auto-apply to change the mode." : ""}>
        <span class="aa-mode-label">Mode</span>
        <${Segmented}
          label="Mode"
          value=${s.settings.dryRun ? "dry" : "live"}
          options=${[
            { value: "dry", label: "Dry run" },
            { value: "live", label: "Live" },
          ]}
          onChange=${(v) => s.phase === "idle" && setLive(v === "live")}
        />
      </div>
      ${!s.settings.showGuide
        ? html`<${Button} variant="ghost" icon="info" onClick=${() => void saveSettings({ showGuide: true })}>How it works</${Button}>`
        : null}
      ${s.phase === "idle"
        ? html`<${Button} variant="primary" icon="play" busy=${s.loading} disabled=${!queued && !s.loading && s.loadedAt > 0} onClick=${() => void start()}>
            Start${queued ? ` (${queued})` : ""}
          </${Button}>`
        : html`
            ${s.phase === "running"
              ? html`<${Button} variant="secondary" icon="pause" onClick=${() => pause("Pausing: running applications will finish, no new ones start.")}>Pause</${Button}>`
              : html`<${Button} variant="primary" icon="play" onClick=${resume}>Resume</${Button}>`}
            <${Button} variant="danger" icon="stop" onClick=${() => stopAll("Stopped. Open tabs are left as they were.")}>Stop</${Button}>
          `}
    </div>
  </header>`;
}

const GUIDE = [
  { icon: "layers", title: "Pick", text: "Takes jobs whose tailored resume is ready, in the order and filters you set." },
  { icon: "wand", title: "Fill", text: "Opens each in a background tab and fills it from your profile and documents." },
  { icon: "send", title: "Submit", text: "Live mode submits on the sites you allow and enters emailed codes when your inbox is connected." },
  { icon: "flag", title: "Hand off", text: "Anything it cannot finish stays open in its tab under Waiting on you." },
];

function Guide() {
  return html`<section class="aa-guide" aria-label="How auto-apply works">
    <ol>
      ${GUIDE.map(
        (g, i) => html`<li>
          <span class="aa-guide-icon"><${Icon} name=${g.icon} size=${16} /></span>
          <div>
            <p class="aa-guide-title"><span>${i + 1}</span>${g.title}</p>
            <p class="aa-guide-text">${g.text}</p>
          </div>
        </li>`,
      )}
    </ol>
    <${IconButton} icon="x" label="Hide this guide" size=${14} onClick=${() => void saveSettings({ showGuide: false })} />
  </section>`;
}

function Stats({ s }) {
  const queue = queueOf(s);
  const enabled = new Set(s.settings.platforms);
  const onSites = s.available.filter((q) => enabled.has(q.platform)).length;
  const hidden = onSites - queue.length;
  const sites = new Set(queue.map((q) => q.platform)).size;
  const busy = Object.keys(s.runs).length;
  const today = appliedToday(s.history);
  const waiting = Object.values(s.history).filter(isWaiting).length;
  const openTabs = waitingOnYou(s.history, s.runs);
  const week = successStats(s.history);
  const offSites = s.available.length - onSites;
  const accountReady = s.account ? s.account.ready : null;
  const accountToday = s.account ? Math.max(s.account.appliedToday, today) : today;
  return html`<div class="aa-stats">
    <${Stat}
      icon="layers"
      label="Ready to apply"
      value=${s.loading && !s.loadedAt ? html`<${Spinner} size=${16} />` : queue.length}
      sub=${hidden > 0
        ? `${hidden} hidden by your filters`
        : accountReady != null && accountReady > queue.length
          ? `Of ${accountReady} ready, ${accountReady - queue.length} are on sites that are off or already tried`
          : offSites > 0
          ? `${offSites} more on sites that are off`
          : sites
            ? `Across ${sites} site${sites === 1 ? "" : "s"}`
            : "Build resumes to add more"}
    />
    <${Stat}
      icon="bolt"
      label="Running now"
      value=${html`${busy}<small> / ${s.settings.parallel}</small>`}
      meter=${html`<span class="aa-slots">${Array.from({ length: s.settings.parallel }, (_, i) => html`<i class=${i < busy ? "is-on" : ""}></i>`)}</span>`}
      sub=${s.phase === "running" ? "Applications at once" : s.phase === "paused" ? "Paused" : "Not running"}
    />
    <${Stat}
      icon="check"
      tone="ok"
      label="Applied today"
      value=${accountToday}
      sub=${s.settings.dryRun ? `${today} by auto-apply, dry run is on` : `${today} by auto-apply`}
    />
    <${Stat}
      icon="flag"
      tone=${waiting ? "warn" : "muted"}
      label="Waiting on you"
      value=${waiting}
      meter=${html`<${Meter} value=${openTabs} max=${s.settings.maxWaiting} tone="warn" />`}
      sub=${`${openTabs} of ${s.settings.maxWaiting} open tabs before pausing`}
    />
    <${Stat}
      icon="chart"
      tone="info"
      label="Success, last 7 days"
      value=${week.rate == null ? "-" : `${week.rate}%`}
      sub=${week.attempts
        ? week.filled
          ? `${week.applied} applied, ${week.filled} filled of ${week.attempts} tried`
          : `${week.applied} applied of ${week.attempts} tried`
        : "No attempts yet"}
    />
  </div>`;
}

function RunSettings({ s }) {
  const st = s.settings;
  const order = ORDERS.find((o) => o.value === st.order) || ORDERS[0];
  return html`<${Card} title="Run settings" icon="settings" hint="Changes apply to the next application that starts.">
    <div class="aa-form">
      <${Field} label="Order" hint=${order.hint}>
        <${Segmented}
          label="Queue order"
          value=${st.order}
          options=${[
            { value: "callback", label: "Interview chance" },
            { value: "ease", label: "Easiest" },
            { value: "match", label: "Best match" },
            { value: "newest", label: "Newest" },
          ]}
          onChange=${(v) => void saveSettings({ order: v })}
        />
      </${Field}>
      <${RangeField}
        label="Minimum match score"
        hint="Jobs below this score, or not scored yet, stay out of the queue."
        value=${st.minScore}
        min=${0}
        max=${95}
        step=${5}
        format=${(v) => (v ? `${v}+` : "Any")}
        onChange=${(v) => void saveSettings({ minScore: v })}
      />
      <${RangeField}
        label="Applications at once"
        hint="More is faster; each one runs in its own background tab."
        value=${st.parallel}
        min=${1}
        max=${5}
        onChange=${(v) => void saveSettings({ parallel: v })}
      />
      <${RangeField}
        label="Pause when waiting on you"
        hint="Stops starting new ones while this many need your hand."
        value=${st.maxWaiting}
        min=${1}
        max=${50}
        onChange=${(v) => void saveSettings({ maxWaiting: v })}
      />
      <${RangeField}
        label="Time limit per application"
        hint="After this, the tab is handed to you."
        value=${st.runTimeoutMin}
        min=${5}
        max=${30}
        format=${(v) => `${v} min`}
        onChange=${(v) => void saveSettings({ runTimeoutMin: v })}
      />
      <${Field} label="Per company per day" hint="Spreads applications so one employer does not get many at once.">
        <${Segmented}
          label="Applications per company per day"
          value=${String(st.perCompany)}
          options=${[
            { value: "0", label: "No limit" },
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
          ]}
          onChange=${(v) => void saveSettings({ perCompany: Number(v) })}
        />
      </${Field}>
      <div class="aa-toggles">
        <${Toggle}
          label="Close tabs after applying"
          hint="Keeps the window tidy; failed and waiting tabs stay open."
          checked=${st.closeOnSuccess}
          onChange=${(v) => void saveSettings({ closeOnSuccess: v })}
        />
      </div>
    </div>
  </${Card}>`;
}

function SiteRow({ id, st, count, disabled }) {
  const fill = st.platforms.includes(id);
  const manual = NEEDS_ACCOUNT.has(id) || id === "board";
  const submit = fill && !manual && st.submitPlatforms.includes(id);
  const toggle = (key, on) => {
    const list = new Set(st[key]);
    if (on) list.add(id);
    else list.delete(id);
    void saveSettings({ [key]: [...list] });
  };
  return html`<div class=${`aa-site${fill ? " is-on" : ""}`}>
    <div class="aa-site-name">
      <span class="aa-site-title">${label(id)}</span>
      <span class=${`aa-ease aa-tier-${Math.min(easeTier(id), 5)}`}>${easeLabel(id)}</span>
      ${count ? html`<span class="aa-site-count" title=${`${count} ready`}>${count}</span>` : null}
    </div>
    <label class="aa-switch" title=${manual ? "Opens the page for you to finish" : "Fill the form"}>
      <input type="checkbox" class="toggle" checked=${fill} disabled=${disabled} onChange=${(e) => toggle("platforms", e.currentTarget.checked)} />
      <span>Fill</span>
    </label>
    ${manual
      ? html`<span class="aa-site-manual">Opens for you</span>`
      : html`<label class="aa-switch" title="Submit automatically in live mode">
          <input type="checkbox" class="toggle" checked=${submit} disabled=${disabled || !fill} onChange=${(e) => toggle("submitPlatforms", e.currentTarget.checked)} />
          <span>Submit</span>
        </label>`}
  </div>`;
}

function Sites({ s }) {
  const st = s.settings;
  const counts = s.available.reduce((m, q) => ((m[q.platform] = (m[q.platform] || 0) + 1), m), {});
  const disabled = s.phase !== "idle";
  const preset = (platforms, submitPlatforms) => void saveSettings({ platforms, submitPlatforms });
  return html`<${Card}
    title="Sites"
    icon="globe"
    meta=${`${st.platforms.length} on`}
    hint="Fill opens and completes the form. Submit sends it in live mode. Sites are listed easiest first."
  >
    <div class="aa-presets">
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset(RECOMMENDED_FILL, DEFAULT_SUBMIT_PLATFORMS)}>Recommended</${Button}>
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset(ALL_PLATFORMS, DEFAULT_SUBMIT_PLATFORMS)}>All sites</${Button}>
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset(st.platforms, [])}>Never submit</${Button}>
      <${Button} size="sm" variant="ghost" disabled=${disabled} onClick=${() => preset([], [])}>None</${Button}>
    </div>
    <div class="aa-sites">
      ${ALL_PLATFORMS.map((id) => html`<${SiteRow} key=${id} id=${id} st=${st} count=${counts[id] || 0} disabled=${disabled} />`)}
    </div>
    ${disabled ? html`<p class="aa-card-hint aa-pad">Stop auto-apply to change sites.</p>` : null}
  </${Card}>`;
}

function Stepper({ stage }) {
  const at = stageIndex(stage);
  return html`<ol class="aa-steps" aria-label=${`Step ${at + 1} of ${STAGES.length}: ${STAGES[at].label}`}>
    ${STAGES.map((st, i) => html`<li class=${i < at ? "is-done" : i === at ? "is-now" : ""}><i></i><span>${st.label}</span></li>`)}
  </ol>`;
}

function LiveRuns({ s, now }) {
  const runs = Object.entries(s.runs).sort((a, b) => a[1].startedAt - b[1].startedAt);
  return html`<${Card}
    title="Live"
    icon="bolt"
    meta=${runs.length ? `${runs.length} running` : null}
    hint="Each application runs in a background tab in the auto-apply window."
  >
    ${s.phase !== "idle" || s.sessionStartedAt ? html`<${SessionStrip} s=${s} now=${now} />` : null}
    ${runs.length
      ? html`<div class="aa-runs">
          ${runs.map(([id, r]) => {
            const stage = stageOf(r);
            return html`<article class="aa-run" key=${id}>
              <div class="aa-run-head">
                <div class="aa-run-title">
                  <strong title=${r.title}>${r.title}</strong>
                  <span>${r.company || "Company not listed"}</span>
                </div>
                <${Score} value=${r.score >= 0 ? r.score : null} />
              </div>
              <div class="aa-run-meta">
                <${PlatformChip} platform=${r.platform} />
                <span class="aa-run-time"><${Icon} name="clock" size=${12} />${formatDuration(now - r.startedAt)}</span>
              </div>
              <${Stepper} stage=${stage} />
              <p class="aa-run-msg" title=${r.message}>${r.message || "Working..."}</p>
              <div class="aa-run-actions">
                ${r.tabId != null ? html`<${Button} size="sm" icon="external" onClick=${() => void focusTab(r.tabId)}>View tab</${Button}>` : null}
                <${Button} size="sm" variant="ghost" icon="x" onClick=${() => stopRun(id)}>Stop this one</${Button}>
                <${IconButton} icon="clock" label="Stop and apply later" size=${14} onClick=${() => void laterRun(id)} />
              </div>
            </article>`;
          })}
        </div>`
      : html`<${Empty} icon="bolt" title=${s.phase === "running" ? "Starting..." : "Nothing running"}>
          ${s.phase === "idle" ? "Press Start to work through the queue. You can pause or stop at any time." : "Waiting for the next job in the queue."}
        </${Empty}>`}
  </${Card}>`;
}

function Queue({ s }) {
  const [q, setQ] = useState("");
  const queue = queueOf(s);
  const term = q.trim().toLowerCase();
  const shown = term
    ? queue.filter((j) => [j.title, j.company, label(j.platform)].some((v) => String(v || "").toLowerCase().includes(term)))
    : queue;
  const pinned = new Set(s.pinned);
  const later = laterIds(s.history);
  return html`<${Card}
    title="Queue"
    icon="list"
    meta=${queue.length}
    hint=${ORDERS.find((o) => o.value === s.settings.order)?.label + (s.settings.minScore ? `, match ${s.settings.minScore}+` : "")}
    action=${html`<div class="aa-card-tools">
      <label class="aa-search">
        <${Icon} name="search" size=${14} />
        <input type="search" placeholder="Filter queue" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Filter queue" />
      </label>
      <${IconButton} icon="refresh" label="Reload ready jobs" disabled=${s.loading} onClick=${() => void loadQueue()} />
    </div>`}
  >
    ${s.skipped.length
      ? html`<p class="aa-card-hint aa-pad">
          ${s.skipped.length} skipped for this session.
          <button type="button" class="aa-link" onClick=${() => set({ skipped: [] })}>Bring them back</button>
        </p>`
      : null}
    ${shown.length
      ? html`<div class="aa-table" role="table" aria-label="Queued jobs">
          ${shown.slice(0, QUEUE_SHOWN).map(
            (j, i) => html`<div class=${`aa-tr${pinned.has(j.id) ? " is-pinned" : ""}`} role="row" key=${j.id}>
              <span class="aa-td aa-td-num">${pinned.has(j.id) ? html`<${Icon} name="pin" size=${12} />` : i + 1}</span>
              <span class="aa-td aa-td-main">
                <strong title=${j.title}>${j.title}</strong>
                <span>${later.has(j.id) && !pinned.has(j.id) ? html`<em class="aa-later-tag">Later</em>` : null}${chanceLabel(j.likelihoodTier) ? html`<em class=${`aa-chance-tag is-${j.likelihoodTier}`} title="Estimated chance of an interview">${chanceLabel(j.likelihoodTier)}</em>` : null}${j.company || "Company not listed"}</span>
              </span>
              <span class="aa-td"><${PlatformChip} platform=${j.platform} /></span>
              <span class="aa-td"><${Score} value=${j.score >= 0 ? j.score : null} /></span>
              <span class="aa-td aa-td-actions">
                <${IconButton} icon="bolt" label="Run next" size=${14} disabled=${pinned.has(j.id) && i === 0} onClick=${() => pinNext(j.id)} />
                <${IconButton} icon="clock" label="Apply later" size=${14} disabled=${later.has(j.id)} onClick=${() => void applyLater([j.id])} />
                <${IconButton} icon="external" label="Open posting" size=${14} onClick=${() => void chrome.tabs.create({ url: j.url })} />
                <${IconButton} icon="x" label="Skip for this session" size=${14} onClick=${() => skipJob(j.id)} />
              </span>
            </div>`,
          )}
        </div>
        ${shown.length > QUEUE_SHOWN ? html`<p class="aa-card-hint aa-pad">And ${shown.length - QUEUE_SHOWN} more.</p>` : null}`
      : html`<${Empty} icon="inbox" title=${s.loading ? "Loading ready jobs..." : term ? "No match" : "Queue is empty"}>
          ${s.loading
            ? null
            : term
              ? "Nothing in the queue matches that filter."
              : "Jobs appear here once their tailored resume is built. Turn on more sites or lower the minimum score to include more."}
        </${Empty}>`}
  </${Card}>`;
}

function Waiting({ s, now }) {
  const waiting = Object.entries(s.history)
    .filter(([, h]) => isWaiting(h))
    .sort((a, b) => b[1].at - a[1].at);
  const [picked, setPicked] = useState(() => new Set());
  const ids = waiting.map(([id]) => id);
  const selected = ids.filter((id) => picked.has(id));
  // With nothing ticked the bar acts on every waiting job.
  const targets = selected.length ? selected : ids;
  const allPicked = ids.length > 0 && selected.length === ids.length;
  const toggle = (id) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const done = () => setPicked(new Set());
  const scope = (n) => (selected.length ? `${n} selected job${n === 1 ? "" : "s"}` : `all ${n} job${n === 1 ? "" : "s"}`);
  const bulk = (kind) => {
    const n = targets.length;
    const ACTIONS = {
      unqueue: {
        title: `Unqueue ${scope(n)}?`,
        message:
          "Their tabs close and they go back to the to-do queue at their normal place (not apply later). They are filled again from scratch when the run reaches them. Already submitted jobs stay here.",
        confirmLabel: "Unqueue",
        run: () => unqueueEntries(targets),
      },
      later: {
        title: `Move ${scope(n)} to apply later?`,
        message: "Their tabs close and they go to the end of the queue, after every other job.",
        confirmLabel: "Apply later",
        run: () => applyLater(targets),
      },
      applied: {
        title: `Mark ${scope(n)} applied?`,
        message: "Use this for applications you submitted yourself in their tabs. Their tabs close.",
        confirmLabel: "Mark applied",
        run: () => markEntriesApplied(targets),
      },
      invalid: {
        title: `Mark ${scope(n)} invalid?`,
        message: "They are hidden from your job lists and auto-apply never tries them again. You can restore them from Invalid jobs on the web app.",
        confirmLabel: "Mark invalid",
        tone: "danger",
        run: async () => {
          for (const id of targets) await markInvalid(id);
        },
      },
    };
    const a = ACTIONS[kind];
    set({
      modal: {
        title: a.title,
        message: a.message,
        confirmLabel: a.confirmLabel,
        tone: a.tone,
        onConfirm: () => {
          set({ modal: null });
          done();
          void a.run();
        },
      },
    });
  };
  const invalid = (id, h) =>
    set({
      modal: {
        title: "Mark this job invalid?",
        message: `${h.title || "This job"}${h.company ? ` at ${h.company}` : ""} is hidden from your job lists and auto-apply skips it. You can restore it from Invalid jobs on the web app.`,
        confirmLabel: "Mark invalid",
        tone: "danger",
        onConfirm: () => {
          set({ modal: null });
          void markInvalid(id);
        },
      },
    });
  return html`<${Card}
    title="Waiting on you"
    icon="flag"
    meta=${waiting.length}
    hint="Finish these in their tabs, or handle them together below so the run can continue."
  >
    ${waiting.length
      ? html`<div class="aa-bulk" role="toolbar" aria-label="Actions for waiting jobs">
          <label class="aa-bulk-pick">
            <input
              type="checkbox"
              checked=${allPicked}
              indeterminate=${selected.length > 0 && !allPicked}
              onChange=${() => setPicked(allPicked ? new Set() : new Set(ids))}
              aria-label="Select all waiting jobs"
            />
            <span>${selected.length ? `${selected.length} of ${ids.length} selected` : `Select (acts on all ${ids.length})`}</span>
          </label>
          <div class="aa-bulk-actions">
            <${Button}
              size="sm"
              variant="secondary"
              icon="refresh"
              title="Close their tabs and put them back in the to-do queue, to be filled again later"
              onClick=${() => bulk("unqueue")}
            >${selected.length ? `Unqueue ${selected.length}` : "Unqueue all"}</${Button}>
            <${Button} size="sm" variant="secondary" icon="clock" onClick=${() => bulk("later")}>Apply later</${Button}>
            <${Button} size="sm" variant="secondary" icon="check" onClick=${() => bulk("applied")}>Mark applied</${Button}>
            <${Button} size="sm" variant="ghost" icon="x" onClick=${() => bulk("invalid")}>Invalid</${Button}>
          </div>
        </div>`
      : null}
    ${waiting.length
      ? html`<div class="aa-list">
          ${waiting.map(
            ([id, h]) => html`<article class=${`aa-item${picked.has(id) ? " is-picked" : ""}`} key=${id}>
              <div class="aa-item-top">
                <label class="aa-item-pick">
                  <input type="checkbox" checked=${picked.has(id)} onChange=${() => toggle(id)} aria-label=${`Select ${h.title || "job"}`} />
                  <${StatusBadge} status=${h.status} />
                </label>
                <span class="aa-item-time">${timeAgo(h.at, now)}</span>
              </div>
              <strong class="aa-item-title" title=${h.title}>${h.title}</strong>
              <span class="aa-item-sub">${h.company || ""}${h.company && h.platform ? " · " : ""}${h.platform ? label(h.platform) : ""}</span>
              ${h.message ? html`<p class="aa-item-msg">${h.message}</p>` : null}
              <div class="aa-item-actions">
                <${Button} size="sm" variant="primary" icon="external" onClick=${() => void openEntry(id)}>${h.tabOpen ? "Go to tab" : "Open"}</${Button}>
                <${Button} size="sm" icon="check" onClick=${() => void markEntryApplied(id)}>Mark applied</${Button}>
              </div>
              <div class="aa-item-actions aa-item-actions-more">
                <${Button} size="sm" variant="ghost" icon="clock" title="Close the tab and try again after the rest of the queue" onClick=${() => void applyLater([id])}>Apply later</${Button}>
                <${Button} size="sm" variant="ghost" icon="x" title="Not a real or open job: hide it and never try it again" onClick=${() => invalid(id, h)}>Invalid job</${Button}>
                <${IconButton} icon="refresh" label="Unqueue: back to the to-do queue" size=${14} onClick=${() => void unqueueEntries([id])} />
              </div>
            </article>`,
          )}
        </div>`
      : html`<${Empty} icon="check" title="All clear">Applications that need a CAPTCHA, an account, or an answer from you show up here.</${Empty}>`}
  </${Card}>`;
}

const HISTORY_FILTERS = ["all", "applied", "filled", "needs_you", "later", "failed", "invalid", "skipped"];

function History({ s, now }) {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const all = Object.entries(s.history)
    .filter(([, h]) => !isWaiting(h))
    .sort((a, b) => b[1].at - a[1].at);
  const counts = all.reduce((m, [, h]) => ((m[h.status] = (m[h.status] || 0) + 1), m), {});
  const rows = filterHistory(all, { status, q }).slice(0, 100);
  return html`<${Card}
    title="History"
    icon="history"
    meta=${all.length}
    hint="Kept for 45 days. Jobs here are not attempted again unless you retry them."
    action=${html`<div class="aa-card-tools">
      <label class="aa-search">
        <${Icon} name="search" size=${14} />
        <input type="search" placeholder="Search history" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Search history" />
      </label>
      <${Button}
        size="sm"
        variant="ghost"
        disabled=${!all.some(([, h]) => !["applied", "later", "invalid"].includes(h.status))}
        onClick=${() =>
          set({
            modal: {
              title: "Clear finished attempts?",
              message: "Skipped, failed and filled jobs are removed from history and can be tried again. Applied, apply-later and invalid jobs are kept.",
              confirmLabel: "Clear",
              tone: "danger",
              onConfirm: () => void clearFinished(),
            },
          })}
      >Clear</${Button}>
    </div>`}
  >
    <div class="aa-filters" role="tablist" aria-label="Filter history">
      ${HISTORY_FILTERS.map((f) => {
        const n = f === "all" ? all.length : counts[f] || 0;
        if (f !== "all" && !n) return null;
        return html`<button type="button" role="tab" aria-selected=${status === f} class=${status === f ? "is-on" : ""} onClick=${() => setStatus(f)}>
          ${f === "all" ? "All" : STATUS[f].label}<span>${n}</span>
        </button>`;
      })}
    </div>
    ${rows.length
      ? html`<div class="aa-table" role="table" aria-label="Finished applications">
          ${rows.map(
            ([id, h]) => html`<div class="aa-tr" role="row" key=${id}>
              <span class="aa-td aa-td-status"><${StatusBadge} status=${h.status} /></span>
              <span class="aa-td aa-td-main">
                <strong title=${h.title}>${h.title || "Job"}</strong>
                <span title=${h.message}>${h.company ? `${h.company} · ` : ""}${h.message || ""}</span>
              </span>
              <span class="aa-td">${h.platform ? html`<${PlatformChip} platform=${h.platform} />` : null}</span>
              <span class="aa-td aa-td-time">${timeAgo(h.at, now)}</span>
              <span class="aa-td aa-td-actions">
                ${h.url ? html`<${IconButton} icon="external" label="Open posting" size=${14} onClick=${() => void chrome.tabs.create({ url: h.url })} />` : null}
                ${h.status !== "applied" && h.status !== "invalid"
                  ? html`<${IconButton} icon="refresh" label=${h.status === "later" ? "Move back to its place in the queue" : "Retry"} size=${14} onClick=${() => void forgetEntry(id)} />`
                  : null}
              </span>
            </div>`,
          )}
        </div>`
      : html`<${Empty} icon="history" title=${all.length ? "No match" : "No finished applications yet"}>
          ${all.length ? "Try another filter or search." : "Finished attempts appear here with what happened."}
        </${Empty}>`}
  </${Card}>`;
}

function RunSummary({ s, open, onToggle }) {
  const st = s.settings;
  const order = ORDERS.find((o) => o.value === st.order) || ORDERS[0];
  const parts = [
    order.label,
    st.minScore ? `match ${st.minScore}+` : "any score",
    `${st.parallel} at once`,
    `pause at ${st.maxWaiting} waiting`,
    `${st.platforms.length} sites`,
  ];
  return html`<div class="aa-runbar">
    <span class="aa-card-icon"><${Icon} name="settings" size=${15} /></span>
    <span class="aa-runbar-text"><strong>Run settings</strong>${parts.join(" · ")}</span>
    <${Button} size="sm" variant="ghost" icon=${open ? "x" : "settings"} onClick=${onToggle}>${open ? "Hide settings" : "Edit settings"}</${Button}>
  </div>`;
}

function sessionStats(s, now) {
  const since = s.sessionStartedAt || now;
  const rows = Object.values(s.history).filter((h) => h.at >= since);
  const count = (st) => rows.filter((h) => h.status === st).length;
  return {
    elapsed: now - since,
    applied: count("applied"),
    filled: count("filled"),
    waiting: rows.filter(isWaiting).length,
    skipped: count("skipped") + count("invalid"),
    failed: count("failed"),
    done: rows.length,
  };
}

function SessionStrip({ s, now }) {
  const st = sessionStats(s, now);
  const left = queueOf(s).length;
  const total = st.done + Object.keys(s.runs).length + left;
  const pct = total ? Math.round((st.done / total) * 100) : 0;
  const cells = [
    { label: "Running for", value: formatDuration(st.elapsed) },
    { label: s.settings.dryRun ? "Filled" : "Applied", value: s.settings.dryRun ? st.filled : st.applied, tone: "ok" },
    { label: "Waiting on you", value: st.waiting, tone: st.waiting ? "warn" : "" },
    { label: "Skipped", value: st.skipped },
    { label: "Failed", value: st.failed, tone: st.failed ? "danger" : "" },
    { label: "Left in queue", value: left },
  ];
  return html`<div class="aa-session" aria-label="This session">
    <div class="aa-session-cells">
      ${cells.map(
        (c) => html`<div class=${`aa-session-cell${c.tone ? ` is-${c.tone}` : ""}`}>
          <span>${c.label}</span><strong>${c.value}</strong>
        </div>`,
      )}
    </div>
    <div class="aa-session-progress">
      <${Meter} value=${st.done} max=${total || 1} tone="brand" />
      <span>${st.done} of ${total} handled this session (${pct}%)</span>
    </div>
  </div>`;
}

function Activity({ s }) {
  const [open, setOpen] = useState(false);
  return html`<${Card}
    title="Activity"
    icon="clock"
    meta=${s.log.length || null}
    hint="Event log for this window."
    action=${html`<${Button} size="sm" variant="ghost" onClick=${() => setOpen(!open)}>${open ? "Hide" : "Show"}</${Button}>`}
  >
    ${!open
      ? null
      : s.log.length
      ? html`<ol class="aa-log">
          ${s.log.map(
            (e) => html`<li key=${e.id} class=${`aa-log-${e.tone}`}>
              <time>${new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <span>${e.text}</span>
            </li>`,
          )}
        </ol>`
      : html`<p class="aa-card-hint aa-pad">Nothing yet. Events show up here as auto-apply works.</p>`}
  </${Card}>`;
}

function Notices({ s }) {
  return html`
    ${s.notice ? html`<${Banner} tone=${s.notice.tone === "muted" ? "info" : s.notice.tone} onDismiss=${() => set({ notice: null })}>${s.notice.text}</${Banner}>` : null}
    ${s.mail && !s.mail.connected
      ? html`<${Banner} tone="info">
          Your inbox is not connected, so applications that email a verification code will wait for you. Connect it on the NAO Interviews page.
        </${Banner}>`
      : null}
  `;
}

function App() {
  const s = useStore();
  const active = s.phase !== "idle";
  const now = useNow(active || Object.keys(s.runs).length > 0);
  const [showSettings, setShowSettings] = useState(!active);
  // Starting collapses the settings so the live run has the room; stopping brings them back.
  useEffect(() => setShowSettings(!active), [active]);

  if (!s.user) {
    return html`<main class="aa-signed-out">
      <${Empty} icon="logout" title="Sign in to use auto-apply">
        Open the NAO side panel, sign in, then reload this page.
      </${Empty}>
      <${Button} variant="primary" icon="refresh" onClick=${() => location.reload()}>Reload</${Button}>
    </main>`;
  }

  return html`<div class="aa-shell">
    <${Header} s=${s} />
    <main class="aa-main">
      ${s.settings.showGuide ? html`<${Guide} />` : null}
      <${Notices} s=${s} />
      <${Stats} s=${s} />
      ${active ? html`<${RunSummary} s=${s} open=${showSettings} onToggle=${() => setShowSettings(!showSettings)} />` : null}
      <div class=${`aa-layout${showSettings ? "" : " is-running"}`}>
        ${showSettings
          ? html`<aside class="aa-side">
              <${RunSettings} s=${s} />
              <${Sites} s=${s} />
            </aside>`
          : null}
        <div class="aa-center">
          <${LiveRuns} s=${s} now=${now} />
          <${Queue} s=${s} />
          <${History} s=${s} now=${now} />
        </div>
        <aside class="aa-rail">
          <${Waiting} s=${s} now=${now} />
        </aside>
      </div>
      <${Activity} s=${s} />
    </main>
    <${Modal} modal=${s.modal} onClose=${() => set({ modal: null })} />
  </div>`;
}

async function init() {
  const [user, token, backendUrl, saved] = await Promise.all([
    storage.getCurrentUser(),
    storage.getToken(),
    storage.getBackendUrl(),
    chrome.storage.local.get([SETTINGS_KEY, HISTORY_KEY]),
  ]);
  set({
    user: user && token ? user : null,
    backendUrl,
    settings: loadedSettings(saved[SETTINGS_KEY]),
    history: saved[HISTORY_KEY] || {},
  });
  if (!user || !token) {
    const { aaRefillPending: p } = await chrome.storage.session.get("aaRefillPending").catch(() => ({}));
    if (p) {
      await chrome.storage.session.remove("aaRefillPending").catch(() => {});
      tellPage(Number(p.tabId), "error", "Sign in to the NAO extension first.");
    }
    return;
  }
  api.apiFetch("/mail/config").then((mail) => set({ mail }), () => set({ mail: null }));
  void loadQueue();
  void takePendingRefill();
}

render(html`<${App} />`, document.getElementById("app"));
void init();
