// Dashboard origins: production (nao.it.com), localhost, and private LAN.
// Chrome match patterns ignore ports, so LAN inject covers any Vite port (e.g. :5173).

import { getBackendUrl, normalizeBackendUrl, setBackendUrl, setCurrentUser, setToken } from "./src/storage.js";
import { isDashboardUrl } from "./src/backendOrigin.js";
import { attachMessageHandlers as attachJobSiteConnectHandlers } from "./src/jobSiteConnect.js";
import { attachBrowserSync } from "./src/jobSiteBrowserSync.js";
import * as api from "./src/api.js";
import { closedWithoutSubmit } from "./src/autoapply/model.js";
import { attachBoardApplyWatch } from "./src/boardApplyWatch.js";

const BRIDGE_FILE = "content/webapp-bridge.js";

/**
 * Hosts already covered by manifest content_scripts. Programmatic inject is
 * only needed for (a) tabs open before install and (b) LAN dashboard hosts not
 * listed in the manifest. Re-injecting into a live document without an
 * idempotent bridge stacks APPLY listeners → duplicate job tabs.
 */
function isManifestContentScriptHost(hostname) {
  const h = (hostname || "").toLowerCase();
  return (
    h === "nao.it.com" ||
    h === "www.nao.it.com" ||
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]"
  );
}

async function injectBridge(tabId, { force = false } = {}) {
  if (tabId == null) return;
  try {
    if (!force) {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url) {
        try {
          const host = new URL(tab.url).hostname;
          // Already-open tabs at install still need force inject (see callers).
          // For later complete events on manifest hosts, skip, static CS ran.
          if (isManifestContentScriptHost(host)) return;
        } catch {
          /* ignore bad url */
        }
      }
    }
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [BRIDGE_FILE],
    });
  } catch (err) {
    console.warn("bridge inject failed", tabId, err);
  }
}

// Static content scripts only auto-inject into pages loaded AFTER install/reload.
// Push the web-app bridge into any open dashboard tabs (including LAN IPs).
async function injectBridgeIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => tab.url && isDashboardUrl(tab.url))
        .map((tab) => injectBridge(tab.id, { force: true })),
    );
  } catch (err) {
    console.warn("injectBridgeIntoOpenTabs failed", err);
  }
}

async function syncBackendUrl(backendUrl) {
  const next = normalizeBackendUrl(backendUrl);
  if (!next) return getBackendUrl();
  const ok = await setBackendUrl(next);
  return ok ? next : getBackendUrl();
}

// MV3 service worker. Opens the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("setPanelBehavior failed", err));
  void injectBridgeIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void injectBridgeIntoOpenTabs();
});

// Adzuna/Jobright Apply clicks in this browser teach NAO the employer's application page.
attachBoardApplyWatch({ report: (boardUrl, url) => api.reportApplyUrlFromBoard(boardUrl, url) });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && isDashboardUrl(tab.url)) {
    void injectBridge(tabId);
  }
});

// Fallback for browsers/states where panel behavior is not honored: open on click.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn("sidePanel.open failed", err);
  }
});

// Per-engine content-script bundles, injected in dependency order: the hidden-
// tab timer shim, shared DOM utils (bootstraps window.__AF), then each component driver (self-
// registers), then the engine core, then the picker bridge. Classic content
// scripts share one ISOLATED world per frame, so this is how the pieces find
// each other. The file list order is preserved by executeScript; registration
// is idempotent. The side panel's engine router (src/engines.js) selects which
// bundle to inject by id; a dedicated platform engine ships its own bundle here.
const ENGINE_SCRIPTS = {
  // Greenhouse / generic best-effort: manual region selection + LLM, driven by
  // the platform-agnostic component drivers.
  greenhouse: [
    "content/engine/timers.js",
    "content/engine/dom.js",
    "content/engine/greenhouse.js",
    "content/engine/pinpoint.js",
    "content/engine/lever.js",
    "content/engine/workable.js",
    "content/engine/breezy.js",
    "content/engine/manatal.js",
    "content/engine/jobdiva.js",
    "content/engine/jobvite.js",
    "content/engine/ashby.js",
    "content/engine/icims.js",
    "content/engine/dayforce.js",
    "content/engine/adp.js",
    "content/engine/drivers/antd-select.js",
    "content/engine/drivers/sr-select.js",
    "content/engine/drivers/icims-dropdown.js",
    "content/engine/drivers/fab-select.js",
    "content/engine/drivers/native.js",
    "content/engine/drivers/react-select.js",
    "content/engine/drivers/intl-tel-input.js",
    "content/engine/drivers/file.js",
    "content/engine/drivers/group.js",
    "content/engine/drivers/yes-no-buttons.js",
    "content/engine/drivers/editable.js",
    "content/engine/engine.js",
    "content/picker.js",
  ],
  // Workday: dedicated deterministic engine that maps a canonical structured
  // profile to Workday's stable data-automation-id fields (no region selection,
  // no LLM). Order matters: dom primitives -> steps -> engine -> content entry.
  workday: [
    "content/engine/timers.js",
    "content/workday/wd-dom.js",
    "content/workday/wd-steps.js",
    "content/workday/wd-engine.js",
    "content/workday/wd-content.js",
  ],
};

function scriptsForEngine(engineId) {
  return ENGINE_SCRIPTS[engineId] || ENGINE_SCRIPTS.greenhouse;
}

// Inject the autofill engine (and its overlay CSS) into every frame of the
// target tab. The side panel requests this after the user has granted host
// permission for the page origin.
// Key under which we stash the job the dashboard asked us to apply to, so the
// side panel can pick it up whether it is already open or opened afterwards.
const PENDING_JOB_KEY = "pendingWebappJob";

attachJobSiteConnectHandlers();
attachBrowserSync();

// Timer service for content/engine/timers.js: hidden tabs throttle their own
// timers, the service worker's are not.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "af-timers" || !port.sender || port.sender.id !== chrome.runtime.id) return;
  port.onMessage.addListener((m) => {
    if (!m || typeof m.id !== "number") return;
    const ms = Math.min(Math.max(0, Number(m.ms) || 0), 60_000);
    setTimeout(() => {
      try {
        port.postMessage({ id: m.id });
      } catch {
        /* tab closed or navigated */
      }
    }, ms);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "WEBAPP_EXTENSION_SESSION") {
    (async () => {
      try {
        const from = sender && (sender.url || (sender.tab && sender.tab.url));
        if (!sender || sender.id !== chrome.runtime.id || !isDashboardUrl(from) || !msg.token || !msg.user) {
          sendResponse({ ok: false, error: "Sign-in must come from the NAO website." });
          return;
        }
        await syncBackendUrl(msg.backendUrl || new URL(from).origin);
        await setToken(String(msg.token));
        await setCurrentUser({ user_id: String(msg.user.user_id), email: String(msg.user.email || "") });
        chrome.runtime.sendMessage({ type: "SESSION_CHANGED" }).catch(() => {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "SYNC_BACKEND_URL" && msg.backendUrl) {
    (async () => {
      try {
        const synced = await syncBackendUrl(msg.backendUrl);
        sendResponse({ ok: true, backendUrl: synced });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  return false;
});

// The dashboard's "Apply with Assistant" button relays a job here (via the
// content-script bridge). We remember it, open the application URL in a new
// tab, and try to surface the side panel; the panel then loads that job.
//
// DEFENSE: duplicate bridge listeners can deliver WEBAPP_APPLY_JOB more than
// once per click. Sync memory dedupe + a shared in-flight tab-open promise
// guarantee at most one chrome.tabs.create per jobId.
let lastWebappApply = { jobId: null, at: 0 };
const WEBAPP_APPLY_DEDUPE_MS = 2500;
/** @type {Map<string, Promise<void>>} */
const applyTabOpenLocks = new Map();

async function openApplicationTabOnce(jobId, url) {
  if (!url) return;
  const existing = applyTabOpenLocks.get(jobId);
  if (existing) {
    await existing;
    return;
  }
  const work = (async () => {
    let reused = false;
    try {
      const matches = await chrome.tabs.query({ url });
      const hit = (matches || []).find((t) => t.id != null);
      if (hit && hit.id != null) {
        await rememberJobTab(hit.id, jobId);
        await chrome.tabs.update(hit.id, { active: true });
        if (hit.windowId != null) {
          await chrome.windows.update(hit.windowId, { focused: true }).catch(() => {});
        }
        reused = true;
      }
    } catch {
      /* exact-url query can fail for some schemes */
    }
    if (!reused) {
      const tab = await chrome.tabs.create({ url, active: true });
      if (tab && tab.id != null) await rememberJobTab(tab.id, jobId);
    }
  })().finally(() => {
    // Keep the lock briefly so a lagged duplicate handler joins this open.
    setTimeout(() => {
      if (applyTabOpenLocks.get(jobId) === work) applyTabOpenLocks.delete(jobId);
    }, WEBAPP_APPLY_DEDUPE_MS);
  });
  applyTabOpenLocks.set(jobId, work);
  await work;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "WEBAPP_APPLY_JOB" && msg.jobId)) return false;

  const jobId = String(msg.jobId);
  const now = Date.now();
  const isDupe =
    lastWebappApply.jobId === jobId && now - lastWebappApply.at < WEBAPP_APPLY_DEDUPE_MS;

  // CRITICAL: open the side panel FIRST, synchronously, before any await.
  // sidePanel.open() may only be called in response to a user gesture, and
  // Chrome drops the gesture flag after ~1ms / the first await. The bridge
  // relays this message from inside the dashboard click, so the gesture is
  // still valid right here (see extension/content/webapp-bridge.js).
  if (msg.openPanel && !isDupe) {
    const windowId = sender && sender.tab && sender.tab.windowId != null ? sender.tab.windowId : null;
    if (windowId != null) {
      chrome.sidePanel
        .open({ windowId })
        .catch((err) => console.warn("sidePanel.open (webapp apply) failed", err));
    }
  }

  if (isDupe) {
    // Still coalesce onto the in-flight tab open if one exists.
    const pending = applyTabOpenLocks.get(jobId);
    if (pending) {
      pending.finally(() => sendResponse({ ok: true, deduped: true }));
      return true;
    }
    sendResponse({ ok: true, deduped: true });
    return false;
  }
  lastWebappApply = { jobId, at: now };

  (async () => {
    try {
      await chrome.storage.session.set({
        [PENDING_JOB_KEY]: { jobId, url: msg.url || null, ts: Date.now() },
      });

      try {
        await openApplicationTabOnce(jobId, msg.url || null);
      } catch (err) {
        console.warn("open application tab failed", err);
      }

      try {
        chrome.runtime.sendMessage({ type: "WEBAPP_OPEN_PENDING_JOB", jobId }, () => {
          void chrome.runtime.lastError;
        });
      } catch (_e) {
        /* no receiver yet; storage fallback covers it */
      }

      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // async sendResponse
});

const APP_HELPER_FILES = ["content/ask-hotkey.js", "content/submit-watch.js"];
// Corner "Open in NAO" button, top frame of every tab NAO opened for a job.
const JOB_FAB_FILE = "content/job-fab.js";

async function injectAppHelpers(tabId) {
  if (tabId == null) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: APP_HELPER_FILES,
  });
}

async function isAppAssistArmed() {
  try {
    const data = await chrome.storage.session.get("askHotkeyArmed");
    return data && data.askHotkeyArmed === true;
  } catch {
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return;
  void (async () => {
    const handOff = await handOffEntry(tabId);
    const job = await jobForTab(tabId);
    if (job) await injectJobFab(tabId);
    if (!(await isAppAssistArmed()) && !handOff) return;
    try {
      await injectAppHelpers(tabId);
    } catch (err) {
      // Missing host permission is expected until the side panel requests it.
      console.warn("app helpers inject failed", tabId, err);
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "AUTOFILL_INJECT" && msg.tabId != null) {
    (async () => {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: msg.tabId, allFrames: true },
          files: ["content/overlay.css"],
        });
        // MAIN world first: page-bridge can see React `_valueTracker` / `__reactProps$`
        // that isolated content scripts cannot (Chrome isolated-world boundary).
        try {
          await chrome.scripting.executeScript({
            target: { tabId: msg.tabId, allFrames: true },
            files: ["content/engine/page-bridge.js"],
            world: "MAIN",
          });
        } catch (err) {
          console.warn("page-bridge MAIN inject failed", err);
        }
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId, allFrames: true },
          files: scriptsForEngine(msg.engine),
        });
        // Keep ask-hotkey + submit-watch available alongside autofill engines.
        try {
          await injectAppHelpers(msg.tabId);
        } catch {
          /* ignore */
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // async sendResponse
  }

  if (msg && msg.type === "ASK_HOTKEY_INJECT" && msg.tabId != null) {
    (async () => {
      try {
        await chrome.storage.session.set({ askHotkeyArmed: true });
        await injectAppHelpers(msg.tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "ASK_HOTKEY_DISARM") {
    chrome.storage.session.set({ askHotkeyArmed: false }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // Content-script hotkey → stash for the side panel if it missed the message.
  if (msg && msg.type === "ASK_SELECTION") {
    const text = String((msg && msg.text) || "").trim();
    chrome.storage.session
      .set({
        pendingAskSelection: {
          text,
          empty: !text || !!msg.empty,
          at: Date.now(),
        },
      })
      .catch(() => {});
    // Side panel also receives this message via its own onMessage listener.
    sendResponse({ ok: true });
    return false;
  }

  // Application submit detected on the page. Resolve which job it belongs to
  // (the tab the panel opened it in wins over the panel's current job), then
  // hand it to the open panel, or record it here when no panel is open.
  if (msg && msg.type === "APP_SUBMITTED") {
    void handleAppSubmitted(msg, sender);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

const APPLY_TAB_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function resolveSubmittedJobId(msg, sender) {
  const data = await chrome.storage.session.get(["activeApplyJobId", "applyTabJobs"]);
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const byTab = tabId != null && data.applyTabJobs ? data.applyTabJobs[String(tabId)] : null;
  if (byTab && byTab.jobId && Date.now() - Number(byTab.at || 0) < APPLY_TAB_MAX_AGE_MS) {
    return String(byTab.jobId);
  }
  return String((data && data.activeApplyJobId) || msg.jobId || "");
}

async function isPanelOpen() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({});
    return contexts.some((c) => String(c.documentUrl || "").includes("/sidepanel.html"));
  } catch {
    return false;
  }
}

// Auto-apply runners register the tabs they drive under "aaTab:<tabId>".
// Submits there belong to the runner: it confirms, marks applied and moves on,
// so the panel hand-off and the global debounce below must not see them.
const AA_TAB_PREFIX = "aaTab:";

async function routeAutoApplySubmit(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId == null) return false;
  const key = AA_TAB_PREFIX + tabId;
  const data = await chrome.storage.session.get(key);
  const entry = data && data[key];
  if (!entry) return false;
  chrome.runtime
    .sendMessage({ type: "AA_SUBMITTED", tabId, jobId: entry.jobId, reason: msg.reason || "submit", url: msg.url || "" })
    .catch(() => {});
  return true;
}

// Tabs auto-apply filled but left for the user (dry run, CAPTCHA, ...) are
// registered under "aaHandoff:<tabId>". A submit there is the user's own, so
// it is marked applied here and recorded in the auto-apply history, whether
// or not the side panel or the console is open.
const AA_HANDOFF_PREFIX = "aaHandoff:";
const AA_HISTORY_KEY = "aaHistory";

async function handOffEntry(tabId) {
  if (tabId == null) return null;
  const key = AA_HANDOFF_PREFIX + tabId;
  const data = await chrome.storage.session.get(key).catch(() => null);
  return (data && data[key]) || null;
}

async function routeHandOffSubmit(sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const entry = await handOffEntry(tabId);
  if (!entry || !entry.jobId) return false;
  const jobId = String(entry.jobId);
  // Several frames can report one submit.
  await chrome.storage.session.remove(AA_HANDOFF_PREFIX + tabId);
  try {
    await api.markApplied([jobId]);
    await api.updateSession(jobId, "completed").catch(() => {});
  } catch (err) {
    console.warn("auto-apply hand-off mark applied failed", err);
    await chrome.storage.session.set({ [AA_HANDOFF_PREFIX + tabId]: entry });
    return true;
  }
  const { [AA_HISTORY_KEY]: history } = await chrome.storage.local.get(AA_HISTORY_KEY);
  if (history && history[jobId]) {
    const next = { ...history[jobId], status: "applied", message: "You submitted it.", at: Date.now(), tabOpen: false };
    await chrome.storage.local.set({ [AA_HISTORY_KEY]: { ...history, [jobId]: next } });
  }
  chrome.tabs.sendMessage(tabId, { type: "AA_FAB_HIDE" }).catch(() => {});
  chrome.runtime.sendMessage({ type: "SESSION_CHANGED", jobId }).catch(() => {});
  return true;
}

const AUTO_APPLY_PAGE = "autoapply.html";

async function openAutoApplyConsole({ focus = true } = {}) {
  const url = chrome.runtime.getURL(AUTO_APPLY_PAGE);
  const [existing] = await chrome.tabs.query({ url: url + "*" });
  if (existing && existing.id != null) {
    if (focus) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url, active: focus });
  return tab.id;
}

async function isAutoApplyConsoleOpen() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
    return contexts.some((c) => String(c.documentUrl || "").includes("/" + AUTO_APPLY_PAGE));
  } catch {
    return false;
  }
}

const AA_FAB_PREFIX = "aaFab:";

// ── "Open in NAO" corner button ─────────────────────────────────────────────

/** The job a tab belongs to: an auto-apply hand-off, a tab auto-apply drives, or one NAO opened for a job. */
async function jobForTab(tabId) {
  if (tabId == null) return null;
  const handOff = await handOffEntry(tabId);
  if (handOff && handOff.jobId) return { jobId: String(handOff.jobId), source: "handoff" };
  const keys = [AA_TAB_PREFIX + tabId, "applyTabJobs"];
  const data = await chrome.storage.session.get(keys).catch(() => ({}));
  const driven = data && data[AA_TAB_PREFIX + tabId];
  if (driven && driven.jobId) return { jobId: String(driven.jobId), source: "autoapply" };
  const bound = data && data.applyTabJobs ? data.applyTabJobs[String(tabId)] : null;
  if (bound && bound.jobId && Date.now() - Number(bound.at || 0) < APPLY_TAB_MAX_AGE_MS) {
    return { jobId: String(bound.jobId), source: "apply" };
  }
  return null;
}

async function rememberJobTab(tabId, jobId) {
  try {
    const { applyTabJobs } = await chrome.storage.session.get("applyTabJobs");
    await chrome.storage.session.set({
      applyTabJobs: { ...(applyTabJobs || {}), [String(tabId)]: { jobId: String(jobId), at: Date.now() } },
    });
  } catch {
    /* session storage unavailable */
  }
}

async function injectJobFab(tabId) {
  // The script guards against a second copy; a missing host permission just means no button.
  await chrome.scripting.executeScript({ target: { tabId }, files: [JOB_FAB_FILE] }).catch(() => {});
}

// A tab registered for a job after it finished loading gets its button now, not on the next load.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  const tabIds = new Set();
  for (const key of Object.keys(changes)) {
    if (!changes[key].newValue) continue;
    if (key.startsWith(AA_HANDOFF_PREFIX)) tabIds.add(Number(key.slice(AA_HANDOFF_PREFIX.length)));
    else if (key.startsWith(AA_TAB_PREFIX)) tabIds.add(Number(key.slice(AA_TAB_PREFIX.length)));
    else if (key === "applyTabJobs") {
      const before = changes[key].oldValue || {};
      for (const id of Object.keys(changes[key].newValue)) if (!before[id]) tabIds.add(Number(id));
    }
  }
  for (const tabId of tabIds) {
    if (!Number.isFinite(tabId)) continue;
    chrome.tabs
      .get(tabId)
      .then((tab) => (tab && tab.status === "complete" && /^https?:/i.test(tab.url || "") ? injectJobFab(tabId) : null))
      .catch(() => {});
  }
});

// The button paints its state once when it loads. When a run on its tab ends (the
// "driven" key goes away, a hand-off or live state changes, or history records the
// outcome), push the new state so it does not keep showing "Filling...".
chrome.storage.onChanged.addListener((changes, area) => {
  const tabIds = new Set();
  if (area === "session") {
    for (const key of Object.keys(changes)) {
      for (const prefix of [AA_TAB_PREFIX, AA_HANDOFF_PREFIX, AA_FAB_PREFIX]) {
        if (key.startsWith(prefix)) tabIds.add(Number(key.slice(prefix.length)));
      }
    }
  } else if (area === "local" && changes[AA_HISTORY_KEY]) {
    void chrome.tabs.query({}).then((tabs) => tabs.forEach((t) => t.id != null && void repaintJobFab(t.id))).catch(() => {});
    return;
  }
  for (const tabId of tabIds) if (Number.isFinite(tabId)) void repaintJobFab(tabId);
});

async function repaintJobFab(tabId) {
  try {
    const s = await fabState(tabId);
    if (!s.show) return;
    const actions = await fabActions(await jobForTab(tabId));
    await chrome.tabs.sendMessage(tabId, { type: "AA_FAB_STATUS", state: s.state, message: s.message || "", actions }, { frameId: 0 });
  } catch {
    /* no button on that tab */
  }
}

/** What the corner button shows: a live fill, or how auto-apply left the job. */
async function fabState(tabId) {
  const job = await jobForTab(tabId);
  if (!job) return { show: false };
  const key = AA_FAB_PREFIX + tabId;
  const { [key]: live } = await chrome.storage.session.get(key).catch(() => ({}));
  if (live && live.state === "running" && Date.now() - Number(live.at || 0) < 15 * 60_000 && (await isAutoApplyConsoleOpen())) {
    return { show: true, state: "running", message: live.message || "" };
  }
  if (job.source === "autoapply") return { show: true, state: "running", message: "" };
  const { [AA_HISTORY_KEY]: history } = await chrome.storage.local.get(AA_HISTORY_KEY);
  const h = history && history[job.jobId];
  const status = (h && h.status) || "";
  const state = status === "filled" || status === "applied" ? "done" : status === "needs_you" ? "needs" : status === "failed" ? "error" : "idle";
  return { show: true, state, status, message: (h && h.message) || "" };
}

/** "Open in NAO" pressed: the side panel opens on this job (the web app when the panel cannot open). */
function expandJob(tabId, windowId, sendResponse) {
  // CRITICAL: sidePanel.open() needs the click's user gesture, which ends at the first await.
  const opening = (windowId != null ? chrome.sidePanel.open({ windowId }) : Promise.reject(new Error("no window"))).then(
    () => true,
    (err) => {
      console.warn("sidePanel.open (job fab) failed", err);
      return false;
    },
  );
  void (async () => {
    const job = await jobForTab(tabId);
    if (!job) {
      sendResponse({ ok: false, error: "NAO no longer tracks this job on this tab." });
      return;
    }
    // Stored before the panel finishes opening, so a panel starting now picks it up.
    await chrome.storage.session.set({ [PENDING_JOB_KEY]: { jobId: job.jobId, url: null, ts: Date.now() } }).catch(() => {});
    const opened = await opening;
    if (opened) {
      // The panel may already be open (message) or just opening (it reads the pending job on start).
      chrome.runtime.sendMessage({ type: "WEBAPP_OPEN_PENDING_JOB", jobId: job.jobId }, () => void chrome.runtime.lastError);
      sendResponse({ ok: true });
      return;
    }
    await chrome.storage.session.remove(PENDING_JOB_KEY).catch(() => {});
    const origin = await getBackendUrl().catch(() => null);
    if (!origin) {
      sendResponse({ ok: false, error: "Could not open NAO for this job." });
      return;
    }
    await chrome.tabs.create({ url: `${origin}/app/jobs?job=${encodeURIComponent(job.jobId)}`, active: true });
    sendResponse({ ok: true, fallback: true });
  })();
}

// ── "You applied" notification ──────────────────────────────────────────────
// Every job newly recorded as applied (api.markApplied, from any part of the extension) shows a short card at the
// bottom-right of the tab the user is looking at: "<title> at <company> · Applied today: N".

const APPLIED_TOAST_FILE = "content/applied-toast.js";
const recentlyAnnounced = new Map(); // jobId -> time, so one application shows once

async function jobLabel(jobId, meta) {
  if (meta && meta.title) return { title: meta.title, company: meta.company || "" };
  try {
    const { [AA_HISTORY_KEY]: history } = await chrome.storage.local.get(AA_HISTORY_KEY);
    const h = history && history[jobId];
    if (h && h.title) return { title: h.title, company: h.company || "" };
  } catch {
    /* no history */
  }
  try {
    const job = await api.getJob(jobId);
    if (job && job.title) return { title: job.title, company: job.company || "" };
  } catch {
    /* signed out or gone */
  }
  return { title: "", company: "" };
}

async function appliedToday() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const home = await api.getHome(tz);
    const n = home && home.counts ? Number(home.counts.applied_today) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function showAppliedToast(payload) {
  const msg = { type: "NAO_APPLIED_TOAST", ...payload };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (tab && tab.id != null && /^https?:/i.test(tab.url || "")) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [APPLIED_TOAST_FILE] });
      await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
      return;
    } catch {
      /* no access to that site: the console page shows it instead */
    }
  }
  // Extension pages (the auto-apply console) load the same script and show it there.
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

async function announceApplied(event) {
  const now = Date.now();
  for (const [id, at] of recentlyAnnounced) if (now - at > 60_000) recentlyAnnounced.delete(id);
  const ids = (event.jobIds || []).map(String).filter((id) => !recentlyAnnounced.has(id));
  if (!ids.length) return;
  ids.forEach((id) => recentlyAnnounced.set(id, now));
  const today = await appliedToday();
  if (ids.length > 1) {
    await showAppliedToast({ count: ids.length, today });
    return;
  }
  const { title, company } = await jobLabel(ids[0], event);
  await showAppliedToast({ title, company, today, count: 1 });
}

api.setAppliedListener((event) => void announceApplied(event).catch((err) => console.warn("applied toast failed", err)));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!(msg && msg.type === "NAO_APPLIED") || !sender || sender.id !== chrome.runtime.id) return false;
  void announceApplied(msg).catch((err) => console.warn("applied toast failed", err));
  return false;
});

// ── corner toolbar actions: Applied / Invalid / Skip ───────────────────────
// An auto-apply job is the console's (it closes the tab, records history and keeps the queue moving); a job the
// side panel opened is the panel's; otherwise the background records it directly. Skip needs one of the two.

async function fabActions(job) {
  const consoleOpen = await isAutoApplyConsoleOpen();
  const panelOpen = await isPanelOpen();
  const ownedByAutoApply = job.source === "autoapply" || job.source === "handoff";
  return { applied: true, invalid: true, skip: (ownedByAutoApply && consoleOpen) || panelOpen };
}

async function fabAction(tabId, action) {
  const job = await jobForTab(tabId);
  if (!job) return { ok: false, error: "NAO no longer tracks this job on this tab." };
  if (!["applied", "invalid", "skip"].includes(action)) return { ok: false, error: "Unknown action." };
  const ownedByAutoApply = job.source === "autoapply" || job.source === "handoff";
  const ask = (message) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) => resolve(chrome.runtime.lastError ? null : res || null));
    });
  if (ownedByAutoApply && (await isAutoApplyConsoleOpen())) {
    const res = await ask({ type: "AA_TAB_ACTION", jobId: job.jobId, tabId, action });
    if (res) return res;
  }
  if (await isPanelOpen()) {
    const res = await ask({ type: "PAGE_JOB_ACTION", jobId: job.jobId, tabId, action });
    if (res && res.ok) return res;
  }
  if (action === "skip") return { ok: false, error: "Open NAO to skip this job." };
  try {
    if (action === "applied") {
      const marked = await api.markApplied([job.jobId]);
      api.updateSession(job.jobId, "completed").catch(() => {});
      return { ok: true, state: "done", message: Number(marked && marked.marked) > 0 ? "Marked applied." : "Already marked applied." };
    }
    await api.reportJobInvalid(job.jobId, "Marked invalid from the application page.");
    api.updateSession(job.jobId, "completed").catch(() => {});
    return { ok: true, state: "idle", message: "Reported as invalid. It is removed from your lists." };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "AA_FAB_ACTION")) return false;
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId == null || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false });
    return false;
  }
  fabAction(tabId, String(msg.action || ""))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !["AA_FAB_STATE", "AA_FAB_EXPAND"].includes(msg.type)) return false;
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId == null || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, show: false });
    return false;
  }
  if (msg.type === "AA_FAB_EXPAND") {
    expandJob(tabId, sender.tab.windowId, sendResponse);
    return true;
  }
  fabState(tabId)
    .then(async (st) => (st && st.show ? { ...st, actions: await fabActions(await jobForTab(tabId)) } : st))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, show: false, error: String((err && err.message) || err) }));
  return true;
});

// Hidden-tab waits for page code (content/engine/dom.js sleep): page timers are throttled in a
// background tab, the service worker's are not, and this reply resumes the page immediately.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "NAO_SLEEP")) return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const ms = Math.max(0, Math.min(Number(msg.ms) || 0, 20000));
  setTimeout(() => {
    try {
      sendResponse(true);
    } catch {
      /* the page went away */
    }
  }, ms);
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!(msg && msg.type === "OPEN_AUTO_APPLY")) return false;
  openAutoApplyConsole()
    .then((tabId) => sendResponse({ ok: true, tabId }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function handleAppSubmitted(msg, sender) {
  try {
    if (await routeAutoApplySubmit(msg, sender)) return;
    if (await routeHandOffSubmit(sender)) return;
    // Multi-frame submit-watch and Workday detection can both fire for one
    // submit; a second event must not complete the *next* job.
    const { lastAppSubmittedAt } = await chrome.storage.session.get("lastAppSubmittedAt");
    const now = msg.at || Date.now();
    if (lastAppSubmittedAt && now - Number(lastAppSubmittedAt) < 10_000) return;
    const jobId = await resolveSubmittedJobId(msg, sender);
    if (!jobId) return;
    const report = { reason: msg.reason || "submit", url: msg.url || "", at: now, jobId };
    await chrome.storage.session.set({ lastAppSubmittedAt: now });

    if (await isPanelOpen()) {
      await chrome.storage.session.set({ pendingAppSubmitted: report });
      chrome.runtime.sendMessage({ type: "APP_SUBMITTED_RESOLVED", ...report }).catch(() => {});
      return;
    }
    const marked = await api.markApplied([jobId]);
    if (marked && Number(marked.marked) > 0) {
      api.updateSession(jobId, "completed").catch(() => {});
      await chrome.storage.session.set({ appliedInBackground: { jobId, at: now } });
    }
  } catch (err) {
    console.warn("app submit handling failed", err);
  }
}

// A hand-off tab closed while still registered was never submitted (a submit
// unregisters it first), so the job moves to apply later.
async function laterOnHandOffClose(tabId) {
  const entry = await handOffEntry(tabId);
  await chrome.storage.session.remove([AA_TAB_PREFIX + tabId, AA_HANDOFF_PREFIX + tabId, AA_FAB_PREFIX + tabId]).catch(() => {});
  if (!entry || !entry.jobId) return;
  const jobId = String(entry.jobId);
  const { [AA_HISTORY_KEY]: history } = await chrome.storage.local.get(AA_HISTORY_KEY);
  const current = history && history[jobId];
  if (!current || (current.tabId != null && current.tabId !== tabId)) return;
  const next = closedWithoutSubmit(current);
  if (next) await chrome.storage.local.set({ [AA_HISTORY_KEY]: { ...history, [jobId]: next } });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  laterOnHandOffClose(tabId).catch((err) => console.warn("auto-apply tab close handling failed", err));
  chrome.storage.session
    .get("applyTabJobs")
    .then(({ applyTabJobs }) => {
      if (!applyTabJobs || !applyTabJobs[String(tabId)]) return;
      const next = { ...applyTabJobs };
      delete next[String(tabId)];
      return chrome.storage.session.set({ applyTabJobs: next });
    })
    .catch(() => {});
});
