// One unattended application. The console loads this page in a hidden iframe
// per job, so every run gets its own copy of the panel state and autofill
// modules: parallel runs cannot see each other's fields or messages.
//
// Flow: open the job in a background tab -> click through "Apply" until a form
// shows -> fill it with the platform engine -> check the page -> submit (unless
// dry run) -> answer an emailed code when the ATS asks for one -> confirm ->
// mark applied. Anything it cannot finish is left open in its tab for the user.

import * as api from "../api.js";
import { NEEDS_ACCOUNT_MESSAGE, NO_FORM_MESSAGE, jobGone, reachApplicationForm } from "../applyForm.js";
import * as storage from "../storage.js";
import { detectPlatform, resolveEngine } from "../engines.js";
import { docsComplete, jobFromSession } from "../panel/actions/job.js";
import { handleAutofillMessage, startAutofill } from "../panel/autofill/index.js";
import { getAutofillProfile, setFocusGate } from "../panel/autofill/shared.js";
import { emptyAutofill, setState, state } from "../panel/state.js";
import { AGGREGATOR_HOSTS, NEEDS_ACCOUNT, applyPageUrl, hostOf } from "./platforms.js";
import { createRecorder } from "./recorder.js";
import { keepAwake, wakeTab } from "./wake.js";

const AA_TAB_PREFIX = "aaTab:";
const LOAD_TIMEOUT_MS = 45_000;
const FILL_TIMEOUT_MS = 8 * 60_000;
const CONFIRM_TIMEOUT_MS = 75_000;
const OTP_TIMEOUT_MS = 4 * 60_000;
const OTP_POLL_MS = 8_000;

const console_ = window.parent && window.parent.naoAutoApply;
const params = new URLSearchParams(location.search);
const jobId = params.get("job");
// Set when the user pressed "Fill again" on a tab auto-apply left for them:
// fill that tab where it is, and never submit.
const refillTabId = params.get("tab") ? Number(params.get("tab")) : null;

const READY_TO_SUBMIT = /^(oracle|adp|dayforce|icims)-submit$/;
// Account sites whose engine opens the posting, creates or signs in to the candidate's account and fills every step
// itself (Workday: Apply, Apply Manually, Create Account / Sign In, the inbox's verification link, then the steps).
const ENGINE_HANDLES_ACCOUNT = new Set(["workday", "icims"]);
// Notes that are not blockers. "icims-credentials" carries the new portal password: it must never reach the run
// message (shown in the console and stored in the run report).
const SOFT_NOTES = new Set(["oracle-resume-import", "icims-credentials"]);

let submittedSignal = null;
let ownTabId = null;
let lastPlatform = null;
// Records the run only for accounts an admin enabled; otherwise every call is a no-op.
const recorder = createRecorder({ jobId });

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function report(patch) {
  if (patch && patch.platform) lastPlatform = patch.platform;
  if (console_) console_.update(jobId, patch);
}

function step(message) {
  recorder.step(message);
  report({ message });
}

class Stop extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const needsYou = (message, extra) => new Stop("needs_you", message, extra);
const skipped = (message) => new Stop("skipped", message);
const postingGone = () => new Stop("invalid", "The job posting is no longer available (expired, filled or removed).");

// ── page helpers (content/auto-apply.js) ────────────────────────────────────

async function injectHelpers(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/auto-apply.js"] });
  } catch {
    /* frames without host access are skipped */
  }
}

async function pageCall(tabId, op, arg = null, frameId = null) {
  try {
    const results = await chrome.scripting.executeScript({
      target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true },
      func: (name, value) => {
        const aa = window.__NAO_AA__;
        return aa && typeof aa[name] === "function" ? aa[name](value) : null;
      },
      args: [op, arg],
    });
    return (results || []).filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
  } catch {
    return [];
  }
}

/** One view of the page across frames (embedded ATS forms live in iframes). */
async function pageState(tabId) {
  await injectHelpers(tabId);
  const frames = await pageCall(tabId, "state");
  const pick = (fn) => frames.find(fn) || null;
  const submitFrame = pick((f) => f.submit && !f.submit.disabled && f.formish) || pick((f) => f.submit);
  const otpFrame = pick((f) => f.otp);
  return {
    frames: frames.length,
    url: (pick((f) => f.top) || {}).url || "",
    confirmed: frames.some((f) => f.confirmed),
    submit: submitFrame ? { ...submitFrame.submit, frameId: submitFrame.frameId } : null,
    next: (pick((f) => f.next) || {}).next || null,
    otp: otpFrame ? { ...otpFrame.otp, frameId: otpFrame.frameId } : null,
    captcha: frames.some((f) => f.captcha),
    captchaWidget: frames.some((f) => f.captchaWidget),
    errors: frames.flatMap((f) => f.errors || []).slice(0, 6),
    missing: frames.flatMap((f) => f.missing || []).slice(0, 8),
  };
}

// ── tab ─────────────────────────────────────────────────────────────────────

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.status === "complete") finish(true);
      })
      .catch(() => finish(false));
  });
}

async function openTab(url, windowId) {
  const tab = await chrome.tabs.create({ url, active: false, ...(windowId != null ? { windowId } : {}) });
  ownTabId = tab.id;
  keepAwake(tab.id);
  await chrome.storage.session.set({ [AA_TAB_PREFIX + tab.id]: { jobId, at: Date.now() } });
  report({ tabId: tab.id });
  await waitForLoad(tab.id, LOAD_TIMEOUT_MS);
  await wakeTab(tab.id);
  // Client-rendered ATS pages mount the form after "complete".
  await delay(2500);
  return chrome.tabs.get(tab.id);
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await delay(300);
  await waitForLoad(tabId, LOAD_TIMEOUT_MS);
  await delay(2500);
  return chrome.tabs.get(tabId);
}

// ── fill ────────────────────────────────────────────────────────────────────

// iCIMS: the email gate (up to 3 min), the resume parse, then several steps each submitted to move on.
const ICIMS_FILL_TIMEOUT_MS = 15 * 60_000;

async function waitForFill(limitMs = FILL_TIMEOUT_MS) {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < limitMs) {
    const af = state.autofill;
    if (af.runStatus && af.runStatus !== lastStatus) {
      lastStatus = af.runStatus;
      step(af.runStatus);
    }
    if (af.runDone && !af.running) return af;
    // The Workday loop ends with its own verdict (review, stuck, needs input...).
    if (af.loopFinished && !af.running) return af;
    if (af.error && !af.discovering && !af.running) return af;
    await delay(500);
  }
  throw needsYou("Filling took too long. Finish the form on the page.");
}

async function fill(tab) {
  setState({ autofill: emptyAutofill() });
  const res = await startAutofill({ tab, headless: true });
  if (!res || !res.ok) {
    if (await jobGone(tab.id, 0)) throw postingGone();
    throw needsYou((res && res.error) || "Autofill could not start on this page.");
  }
  const af = await waitForFill(lastPlatform === "icims" ? ICIMS_FILL_TIMEOUT_MS : FILL_TIMEOUT_MS);
  if (af.error) {
    if (await jobGone(tab.id, 0)) throw postingGone();
    throw needsYou(af.error);
  }
  if (af.loopFinished) {
    const loop = af.loopFinished;
    if (loop === "submitted") return { filled: (af.reports || []).length, needs: [], submitted: true, readyToSubmit: false };
    if (loop === "review" || loop === "done") return { filled: (af.reports || []).length, needs: [], submitted: false, readyToSubmit: true };
    const extra = (af.needsUser || []).map((n) => `${n.label}: ${n.reason}`);
    return { filled: (af.reports || []).length, needs: [af.loopMessage || "Workday stopped.", ...extra], submitted: false, readyToSubmit: false };
  }
  // Multi-step engines end with "every section is filled, review and click Submit": the application is ready, not
  // stuck. An Oracle resume import that failed is not a blocker either: every section is still filled.
  const all = af.needsUser || [];
  if (all.some((n) => n.cid === "icims-credentials")) step("Created an iCIMS account for this employer; its password is saved in NAO.");
  const readyToSubmit = all.some((n) => READY_TO_SUBMIT.test(n.cid || ""));
  const needs = all
    .filter((n) => !READY_TO_SUBMIT.test(n.cid || "") && !SOFT_NOTES.has(n.cid || ""))
    .map((n) => `${n.label}: ${n.reason}`);
  return { filled: (af.specs || []).length, needs, submitted: af.submitted === true, readyToSubmit };
}

// ── submit, confirm, code ───────────────────────────────────────────────────

async function waitForOutcome(tabId, baseline, { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
  const started = Date.now();
  let errorPolls = 0;
  while (Date.now() - started < timeoutMs) {
    await delay(2000);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Stop("failed", "The application tab was closed.");
    }
    if (tab.status !== "complete") continue;
    const s = await pageState(tabId);
    if (s.otp) return { kind: "otp", state: s };
    if (s.captcha) return { kind: "captcha", state: s };
    // A page that already said "thank you" before submit proves nothing.
    if (s.confirmed && (!baseline.confirmed || !s.submit)) return { kind: "confirmed", via: "page" };
    // The submit watcher also fires when the form is swapped for a code step,
    // so its signal only counts once the page shows no code, CAPTCHA or form.
    if (submittedSignal) {
      if (!s.submit && !s.errors.length) return { kind: "confirmed", via: submittedSignal };
      submittedSignal = null;
    }
    if (s.errors.length && s.submit) {
      errorPolls += 1;
      if (errorPolls >= 3) return { kind: "errors", state: s };
    } else {
      errorPolls = 0;
    }
  }
  return { kind: "timeout" };
}

async function solveCode(tabId, job, sinceSec) {
  const tried = [];
  const started = Date.now();
  step("Waiting for the emailed verification code…");
  while (Date.now() - started < OTP_TIMEOUT_MS) {
    // Several runs can wait on codes at once: only take a code from mail that
    // names this company, unless this is the only run waiting.
    const alone = console_ ? console_.otpWaiters(jobId) <= 1 : true;
    const useCompany = job.company && !(alone && Date.now() - started > 90_000);
    let res;
    try {
      res = await api.getVerificationCode({ since: sinceSec, company: useCompany ? job.company : undefined, exclude: tried });
    } catch (err) {
      throw needsYou("Enter the verification code from your email: " + ((err && err.message) || "the inbox could not be read"));
    }
    if (!res || res.connected === false) {
      throw needsYou("Enter the verification code from your email. Connect your inbox in NAO to let auto-apply do this.");
    }
    if (res.code) {
      tried.push(res.code);
      step(`Entering the code from ${res.from || "your email"}…`);
      const s = await pageState(tabId);
      if (!s.otp) return;
      const out = await pageCall(tabId, "fillOtp", res.code, s.otp.frameId);
      if (!out.length || !out[0].filled) throw needsYou("Could not type the verification code. It is " + res.code + ".");
      if (!out[0].clicked) {
        await delay(800);
        const again = await pageState(tabId);
        if (again.submit && !again.otp) await pageCall(tabId, "submit", null, again.submit.frameId);
      }
      await delay(3000);
      const after = await pageState(tabId);
      if (!after.otp || after.confirmed) return;
      step("That code was not accepted, waiting for a newer one…");
    }
    await delay(OTP_POLL_MS);
  }
  throw needsYou("No verification code arrived. Check your email and enter it on the page.");
}

async function submitAndConfirm(tab, job) {
  const tabId = tab.id;
  const baseline = await pageState(tabId);
  if (!baseline.submit) {
    throw needsYou(baseline.next ? `Filled, but the form continues with "${baseline.next.label}". Finish the remaining steps.` : "Filled, but no Submit button was found. Submit it on the page.");
  }
  if (baseline.submit.disabled) throw needsYou("Submit is disabled. Something on the form still needs attention.");
  step("Submitting…");
  const sinceSec = Date.now() / 1000 - 30;
  const clicked = await pageCall(tabId, "submit", null, baseline.submit.frameId);
  if (!clicked.length || !clicked[0].clicked) throw needsYou("Could not click Submit. Submit it on the page.");
  report({ submittedAt: Date.now() });
  // Before waiting on the site: a run that never sees a confirmation must still never submit this job again.
  await api.recordSubmitted(jobId).catch(() => {});

  // The site held the application back (form errors, CAPTCHA, unanswered code): nothing was sent.
  const notSent = async (message) => {
    await api.clearSubmitted(jobId).catch(() => {});
    return needsYou(message);
  };
  for (let round = 0; round < 3; round++) {
    const outcome = await waitForOutcome(tabId, baseline);
    if (outcome.kind === "confirmed") return outcome.via;
    if (outcome.kind === "otp") {
      if (console_) console_.otpWait(jobId, true);
      try {
        await solveCode(tabId, job, sinceSec);
      } catch (err) {
        throw err instanceof Stop && err.status === "needs_you" ? await notSent(err.message) : err;
      } finally {
        if (console_) console_.otpWait(jobId, false);
      }
      continue;
    }
    if (outcome.kind === "captcha") throw await notSent("The site wants a CAPTCHA. Solve it and submit.");
    if (outcome.kind === "errors") throw await notSent("The form was rejected: " + outcome.state.errors.join("; "));
    throw needsYou("Submitted, but no confirmation showed up. Check the page. Auto-apply will not submit this job again.", {
      submitted: true,
    });
  }
  throw await notSent("The site kept asking for a code. Finish it on the page.");
}

// ── main ────────────────────────────────────────────────────────────────────

async function boot() {
  const [prefs, user, token] = await Promise.all([storage.loadPrefs(), storage.getCurrentUser(), storage.getToken()]);
  if (!user || !token) throw new Stop("failed", "Sign in to the NAO extension first.");
  let cache = await storage.getCache(user.user_id);
  if (!cache || !cache.settings) {
    const settings = await api.getSettings().catch(() => null);
    cache = { ...(cache || {}), settings };
  }
  setState({ ...prefs, user, cache, autoApply: true, view: "job" });
  // The user keeps working in another tab: wake the page, never bring it forward.
  setFocusGate(wakeTab);
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "AA_SUBMITTED") {
      if (ownTabId != null && msg.tabId === ownTabId) submittedSignal = msg.reason || "submit";
      return;
    }
    handleAutofillMessage(msg, sender);
  });
}

const onBoard = (url) => AGGREGATOR_HOSTS.some((h) => hostOf(url).endsWith(h));

/**
 * A board job (Adzuna, Jobright) whose employer page NAO does not know yet: follow the board's Apply in this
 * browser (the user's own session) to the employer's site, and tell NAO where it led so every later apply
 * goes straight there. Other boards, and a board that will not let us through, are left to the user.
 */
async function leaveBoard(tab, job) {
  const via = job.snapshot && job.snapshot.apply_via;
  if (!via) {
    // Dice's Apply is its own Easy Apply behind a Dice sign-in: nothing to follow to the employer.
    if (/(^|\.)dice\.com$/i.test(hostOf(tab.url))) {
      throw needsYou("Dice applies through its own Easy Apply, which needs your Dice sign-in. Apply on Dice yourself.");
    }
    throw needsYou("This is a job board listing. Open the employer's application from it.");
  }
  step(`Opening the employer's application from ${via}…`);
  const reached = await reachApplicationForm(tab.id, { onStep: step, waitMs: 25_000, focus: wakeTab });
  if (!reached.tab) throw new Stop("failed", "The application tab was closed.");
  if (reached.gone) throw postingGone();
  if (reached.botWall) {
    throw needsYou(`${via} is showing a "confirm you are human" check. Open the job on ${via} yourself and press Apply there.`);
  }
  if (reached.httpBlocked) throw needsYou(`${via} refused the request (blocked). Open the job on ${via} yourself later.`);
  if (onBoard(reached.tab.url)) {
    throw needsYou(`${via} did not open the employer's application. Open it from the page (signing in to ${via} may be needed).`);
  }
  await api.reportApplyUrl(job.job_id, reached.tab.url).catch(() => {});
  return reached.tab;
}

async function run(cfg) {
  await boot();
  step("Opening the job…");
  const session = await api.openSession(jobId, { fresh: true });
  const job = jobFromSession(session);
  report({ title: job.title, company: job.company });
  if (job.applied) throw skipped("Already marked applied.");
  step("Checking your applications and inbox…");
  // Fast: answers from what is synced; a stale inbox catches up in the background.
  const prior = await api.applyCheck(jobId, { timezone: localTz(), wait: false });
  if (prior && prior.ok === false) throw skipped(prior.message || "You already applied here.");
  let inboxSyncing = Boolean(prior && prior.inbox_syncing);
  if (!job.url) throw skipped("This job has no application link.");
  if (!docsComplete(job.docs)) throw skipped("Resume or cover letter is not built yet.");

  const target = applyPageUrl(detectPlatform({ pageUrl: job.url }), job.url);
  let tab = await openTab(target, cfg.windowId);

  // Redirects (short links, career sites embedding an ATS) decide the real platform.
  let platform = detectPlatform({ pageUrl: tab.url });
  const better = applyPageUrl(platform, tab.url || "");
  if (better && better !== tab.url) tab = await navigate(tab.id, better);
  if (onBoard(tab.url)) tab = await leaveBoard(tab, job);

  // Description pages hide the form behind "Apply"; fill only once it shows.
  // JobDiva opens its own Quick Apply during the fill, and Oracle walks Apply Now, its email gate and the emailed
  // code itself (the generic probe stops at the email gate).
  platform = detectPlatform({ pageUrl: tab.url });
  if (platform !== "jobdiva" && platform !== "oracle" && !NEEDS_ACCOUNT.has(platform)) {
    const reached = await reachApplicationForm(tab.id, {
      onStep: step,
      waitMs: 25_000,
      focus: wakeTab,
      // Consent steps that ask for the place of residence (Jobvite) choose from the profile address.
      residence: () => getAutofillProfile(job.job_id).then((p) => p && p.address),
      // A careers page listing jobs: its link to this posting (on an ATS) carries the title.
      jobTitle: job.title || "",
    });
    if (!reached.tab) throw new Stop("failed", "The application tab was closed.");
    tab = reached.tab;
    if (reached.gone) throw postingGone();
    if (reached.botWall) throw needsYou('This site is showing a "confirm you are human" check. Complete it on the page, then start again.');
    if (reached.httpBlocked) throw needsYou("The site refused the request (403 Forbidden or too many requests). Open the job yourself later.");
    if (reached.consentError) throw needsYou(reached.consentError);
    if (!reached.ready && reached.account) throw needsYou(NEEDS_ACCOUNT_MESSAGE);
    if (!reached.ready && reached.steps.length) {
      throw needsYou(`Clicked "${reached.steps[reached.steps.length - 1]}" but no application form opened. Open it on the page.`);
    }
    // No form and no Apply button: never fill whatever inputs the page has.
    if (!reached.ready) throw needsYou(NO_FORM_MESSAGE);
  } else if (await jobGone(tab.id)) {
    throw postingGone();
  }
  platform = detectPlatform({ pageUrl: tab.url });
  report({ platform });
  if (onBoard(tab.url)) {
    throw needsYou("This is a job board listing. Open the employer's application from it.");
  }
  if (NEEDS_ACCOUNT.has(platform) && !ENGINE_HANDLES_ACCOUNT.has(platform)) {
    throw needsYou(`${platform} needs an account. Sign in and finish the application.`);
  }

  job.engine = resolveEngine({ snapshot: job.snapshot, pageUrl: tab.url });
  // Engines that submit on their own (JobDiva) may only do so in live mode on sites allowed to submit.
  const maySubmit = !cfg.dryRun && cfg.submitPlatforms.includes(platform);
  // Workday's loop drives every step only with auto-advance on.
  setState({ job, autoApplySubmit: maySubmit, autoAdvance: true });

  step("Filling the application…");
  await recorder.snapshot(tab.id, "form");
  const result = await fill(tab);
  report({ filled: result.filled });
  await recorder.snapshot(tab.id, "after_fill");
  if (result.needs.length) throw needsYou("Needs your input: " + result.needs.slice(0, 4).join("; "));
  if (result.submitted) {
    report({ submittedAt: Date.now() });
    step("Marking applied…");
    await api.markApplied([jobId], job);
    await api.updateSession(jobId, "completed").catch(() => {});
    return {
      status: "applied",
      message: maySubmit ? "Submitted and confirmed (site)." : "The site submitted the application on its own.",
    };
  }

  await delay(1500);
  const check = await pageState(tab.id);
  if (check.missing.length) throw needsYou("Required fields are still empty: " + check.missing.slice(0, 5).join(", "));
  if (check.captcha) throw needsYou("The site wants a CAPTCHA. Solve it and submit.");

  if (cfg.dryRun) return { status: "filled", message: "Filled (dry run). Review and submit it yourself, or turn dry run off." };
  if (!cfg.submitPlatforms.includes(platform)) {
    throw needsYou("Filled. Auto-submit is off for this site, so review and submit it.");
  }

  if (inboxSyncing) {
    // The inbox was still syncing when this job started: look once more before sending.
    const again = await api.applyCheck(jobId, { timezone: localTz(), wait: false }).catch(() => null);
    if (again && again.ok === false) throw skipped(again.message || "You already applied here.");
    inboxSyncing = false;
  }
  const via = await submitAndConfirm(tab, job);
  step("Marking applied…");
  await api.markApplied([jobId], job);
  // Awaited: the console removes this frame as soon as the run finishes.
  await api.updateSession(jobId, "completed").catch(() => {});
  return { status: "applied", message: `Submitted and confirmed (${via}).` };
}

async function adoptTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Stop("failed", "The application tab was closed.");
  }
  ownTabId = tab.id;
  keepAwake(tab.id);
  await chrome.storage.session.set({ [AA_TAB_PREFIX + tab.id]: { jobId, at: Date.now() } });
  report({ tabId: tab.id });
  await wakeTab(tab.id);
  return tab;
}

/** Fill again in the tab the user is looking at. Their page, their submit. */
async function refill() {
  await boot();
  step("Loading the job…");
  const session = await api.openSession(jobId, { fresh: false });
  const job = jobFromSession(session);
  report({ title: job.title, company: job.company });
  if (!docsComplete(job.docs)) throw needsYou("Resume or cover letter is not built yet. Build them in NAO, then fill again.");

  const tab = await adoptTab(refillTabId);
  const platform = detectPlatform({ pageUrl: tab.url });
  report({ platform });
  job.engine = resolveEngine({ snapshot: job.snapshot, pageUrl: tab.url });
  setState({ job, autoApplySubmit: false });

  step("Filling the application…");
  await recorder.snapshot(tab.id, "form");
  let result;
  try {
    result = await fill(tab);
  } catch (err) {
    // A user's own tab is never closed as an invalid posting from here.
    if (err instanceof Stop && err.status === "invalid") throw needsYou("This posting looks closed or removed. Check the page.");
    throw err;
  }
  report({ filled: result.filled });
  if (result.submitted) {
    step("Marking applied…");
    await api.markApplied([jobId], job);
    await api.updateSession(jobId, "completed").catch(() => {});
    return { status: "applied", message: "The site submitted the application on its own." };
  }
  if (result.needs.length) throw needsYou("Filled again. Needs your input: " + result.needs.slice(0, 4).join("; "));
  await delay(1500);
  const check = await pageState(tab.id);
  if (check.missing.length) throw needsYou("Filled again, but required fields are still empty: " + check.missing.slice(0, 5).join(", "));
  if (check.captcha) throw needsYou("Filled again. The site wants a CAPTCHA. Solve it and submit.");
  return { status: "filled", message: "Filled again. Review the form and submit it." };
}

/** Recorded accounts only: the final page and the trail of a run that did not finish go to the server. */
async function recordOutcome(outcome) {
  try {
    if (!["failed", "needs_you", "invalid"].includes(outcome.status)) return;
    recorder.step(`Outcome: ${outcome.status}: ${outcome.message || ""}`);
    let pageUrl = null;
    if (ownTabId != null) {
      pageUrl = await chrome.tabs.get(ownTabId).then((t) => t.url, () => null);
      await recorder.snapshot(ownTabId, "final", { wait: true });
    }
    await recorder.finish(outcome, { platform: lastPlatform, pageUrl, autofill: state.autofill });
  } catch {
    /* recording never changes the run */
  }
}

async function main() {
  if (!console_ || !jobId) return;
  const cfg = console_.config(jobId);
  recorder.start();
  let outcome;
  try {
    outcome = refillTabId != null ? await refill() : await run(cfg);
  } catch (err) {
    outcome =
      err instanceof Stop
        ? { status: err.status, message: err.message, ...err.extra }
        : { status: "failed", message: (err && err.message) || String(err) };
  }
  await recordOutcome(outcome);
  if (ownTabId != null) await chrome.storage.session.remove(AA_TAB_PREFIX + ownTabId).catch(() => {});
  console_.finish(jobId, { ...outcome, tabId: ownTabId });
}

void main();
