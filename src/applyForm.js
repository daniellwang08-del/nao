// Job links often open the description page, not the form: Workable's
// jobs.workable.com shows the form only after "Apply now", career sites link
// out to their ATS. Before filling, click through to the application and
// confirm a form is on screen.

// Button or link text that opens an application (lowercase, spaces collapsed).
// Arrows, icons and punctuation around the words are allowed ("Apply now →",
// "Apply for this job ↗", "Apply arrow_forward"), as is screen-reader text
// such as "(opens in a new tab)".
const APPLY_WORDS =
  "apply|apply now|apply here|apply online|apply today|easy apply|quick apply|" +
  "apply (to|for) (this |the )?(job|position|role|opening|vacancy)( online| now)?|" +
  "start (your |my )?application|begin (your )?application|i'?m interested|apply on (the )?company (site|website)|" +
  // Guest application next to sign-in / create-account choices (Dayforce: "Apply without an Account").
  "apply without (an |a )?(account|signing in|registering|registration)|apply as (a )?guest|continue as (a )?guest";
const APPLY_TRAIL = "arrow_[a-z_]+|chevron_right|navigate_next|open_in_new|launch|north_east|east|\\(?opens? in (a )?new (tab|window)\\)?";
export const APPLY_TEXT = `^[^a-z0-9']*(${APPLY_WORDS})([^a-z0-9']+(${APPLY_TRAIL}))*[^a-z0-9']*$`;
// Apply buttons that lead to a sign-in or another site's profile instead.
export const NOT_APPLY_TEXT = "linkedin|indeed|google|facebook|seek|sign in|log in|login|register|create account";
// Stable markers on apply buttons whose text may vary or be an icon.
export const APPLY_ATTR = "overview-apply-now|apply-now|apply-button|applybutton|btn-apply|job-apply|apply_button";
// With an email and a name field, how many visible fields make an application
// (email + name + at least one more).
export const MIN_FORM_FIELDS = 3;
// A posting that is gone: expired, filled, closed, removed, or a not-found page.
export const GONE_TEXT =
  "job (was )?not found|(job|position|posting|role|opening|vacancy|requisition|page)s? (you('re| are) looking for |you requested )?" +
  "(is|has been|was|are) (no longer|not) (available|active|open|accepting|found|listed|posted)|" +
  "no longer (available|accepting (applications|candidates)|open|active|exists|posted|listed|being accepted)|" +
  "(job|position|posting|vacancy|opening|requisition|listing) (has )?(expired|been filled|been closed|been removed|been archived|is closed|is expired|is filled)|" +
  "(page|job|position) (could not|couldn'?t|cannot|can'?t) be found|(page|job|position|posting) not found|" +
  "couldn'?t find (anything|the page|that page|the job|this job|that job)|(page|job|position|posting) (doesn'?t|does not) exist|" +
  "applications? (are |is )?(now )?closed|not accepting (applications|candidates)|^404\\b|\\b404 (error|not found)|error 404|" +
  "you'?ve gone too far|(hiring|recruiting|position|job|posting|requisition)( for this (job|position|role))? (has been put|is( currently)?) on hold";
// Where job boards send a dead posting: Greenhouse back to the board with
// ?error=true, Workable to the company page with ?not_found=true.
export const GONE_URL = "[?&](error|not_found)=true\\b|/(404|not-found|job-not-found)(/|$|\\?)";

// What callers say when the page cannot be filled safely.
export const NO_FORM_MESSAGE = "Couldn't find the application form on this page. Open it, then try again.";
export const NEEDS_ACCOUNT_MESSAGE = "This site wants you to sign in or create an account before applying. Do that, open the application, then try again.";

export function isGoneText(text) {
  const t = String(text || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  return !!t && new RegExp(GONE_TEXT).test(t);
}

export function isApplyText(text) {
  const t = String(text || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  return !!t && new RegExp(APPLY_TEXT).test(t) && !new RegExp(NOT_APPLY_TEXT).test(t);
}

/**
 * Runs in the page (chrome.scripting, so it must stay self-contained): reports
 * whether an application form is showing and, when `act` is set and none is,
 * opens the application. Links are returned for the caller to load in the same
 * tab, so target=_blank does not scatter tabs.
 *
 * Visible inputs alone are not an application: career pages carry job filters,
 * "refer a friend" and "email me this job" forms, job-alert signups and
 * sign-in walls. A form counts only on application evidence: a resume/CV
 * upload, or an email plus a name plus another field. A password box without
 * an upload is an account wall and is reported as `account`.
 * Open shadow roots (SmartRecruiters' web components) are searched too.
 */
export function probeApplyPage(rules, act) {
  const visible = (el) => {
    try {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  };
  const text = (el) =>
    String(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  // querySelectorAll does not enter shadow roots; walk the open ones.
  const deepAll = (sel) => {
    const out = [];
    const walk = (root, depth) => {
      out.push(...Array.from(root.querySelectorAll(sel)));
      if (depth > 8) return;
      for (const node of Array.from(root.querySelectorAll("*"))) if (node.shadowRoot) walk(node.shadowRoot, depth + 1);
    };
    walk(document, 0);
    return out;
  };
  const attr = (el, k) => (el && el.getAttribute && el.getAttribute(k)) || "";
  const labelOf = (el) => {
    let t = "";
    try {
      if (el.labels) t = Array.from(el.labels, (l) => l.innerText || l.textContent || "").join(" ");
    } catch {
      /* ignore */
    }
    const by = attr(el, "aria-labelledby");
    if (by) {
      const root = el.getRootNode ? el.getRootNode() : document;
      for (const id of by.split(/\s+/)) {
        const n = root && root.getElementById ? root.getElementById(id) : null;
        if (n) t += " " + (n.innerText || n.textContent || "");
      }
    }
    return t;
  };
  // The visible label of a control that has no other identity: the control-free block just above its
  // wrapper. Gem (jobs.gem.com) renders <span>First name *</span> next to a bare <input type=text> with
  // no name, id, placeholder, <label> or aria, and no <form>. Same rule as the engine's questionAbove.
  const textAbove = (el) => {
    try {
      let node = el;
      for (let depth = 0; node && depth < 6; depth++) {
        const prev = node.previousElementSibling;
        if (prev) {
          if (prev.querySelector("input, select, textarea, button, [role=combobox], [role=radio]")) return "";
          const t = String(prev.innerText || prev.textContent || "").replace(/\s+/g, " ").trim();
          return t.length <= 120 ? t : "";
        }
        node = node.parentElement;
        if (!node || node.tagName === "FORM" || node.tagName === "BODY") return "";
      }
    } catch {
      /* ignore */
    }
    return "";
  };
  const describe = (el) => {
    const own = [el.name, el.id, el.placeholder, attr(el, "autocomplete"), attr(el, "aria-label"), attr(el, "data-ui"), attr(el, "data-qa"), attr(el, "data-testid"), labelOf(el)]
      .filter(Boolean)
      .join(" ");
    return (own.trim() ? own : textAbove(el)).toLowerCase();
  };
  const fieldSel = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=search]):not([type=image]):not([type=reset]), textarea, select";
  const emailRe = /e-?mail/;
  const nameRe = /(^|[^a-z])(first|last|full|given|family|legal|preferred|candidate|sur|f|l)?[-_ .]?name([^a-z]|$)/;
  const friendRe = /friend|recipient|colleague/;
  // Career pages put job-alert and newsletter signups (name, email, interests)
  // next to the description; those are not the application.
  const signupRe = /job.?alert|newsletter|subscri|talent.?(community|network|pool)|join our talent|stay (connected|in touch)|get (notified|job updates)|keep me (posted|updated)/i;
  // Forms that pass the posting on rather than apply to it.
  const referRe = /refer[-_ ]?(a[-_ ])?(friend|someone|candidate)|referral[-_ ]?form|share[-_ ](this[-_ ])?(job|position|role|posting)|e-?mail[-_ ](me[-_ ])?this[-_ ](job|position|role|posting)|send[-_ ](this[-_ ])?(job|position)?[-_ ]?to[-_ ](a[-_ ])?friend|tell[-_ ]a[-_ ]friend/i;

  // Nearest <form>, climbing out of shadow roots; null for formless pages.
  const formOf = (el) => {
    let node = el;
    for (let i = 0; node && i < 12; i++) {
      const f = node.closest ? node.closest("form") : null;
      if (f) return f;
      const root = node.getRootNode ? node.getRootNode() : null;
      node = root && root.host ? root.host : null;
    }
    return null;
  };
  const PAGE = { page: true };
  const groups = new Map();
  let fields = 0;
  for (const el of deepAll(fieldSel)) {
    const isFile = String(el.type || "").toLowerCase() === "file";
    const shown = visible(el);
    // Upload inputs are usually hidden behind a styled button; the rest must show.
    if (!shown && !isFile) continue;
    if (el.closest && el.closest("header, nav, footer, [role=search], [role=dialog][data-ui=cookie-consent]")) continue;
    if (/search|newsletter|subscribe/i.test(`${el.name} ${el.id} ${el.placeholder || ""}`)) continue;
    const key = formOf(el) || PAGE;
    if (!groups.has(key)) groups.set(key, { shown: 0, file: false, email: false, name: false, password: false, user: false, phone: false, friend: false });
    const g = groups.get(key);
    if (shown) {
      fields += 1;
      g.shown += 1;
    }
    const d = describe(el);
    if (isFile) {
      // A photo upload is not a resume.
      if (!/^\s*(image\/[^,]*|\.(png|jpe?g|gif|webp))(\s*,\s*(image\/[^,]*|\.(png|jpe?g|gif|webp)))*\s*$/i.test(attr(el, "accept"))) g.file = true;
      continue;
    }
    if (String(el.type || "").toLowerCase() === "password") g.password = true;
    else if (String(el.type || "").toLowerCase() === "email" || emailRe.test(d)) g.email = true;
    else if (/user.?(name|id)|login/.test(d)) g.user = true;
    else if (nameRe.test(d) && !/company.?name|file.?name/.test(d)) g.name = true;
    if (String(el.type || "").toLowerCase() === "tel" || /phone|mobile/.test(d)) g.phone = true;
    if (friendRe.test(d)) g.friend = true;
  }

  const formMarks = new Map();
  const marksOf = (form) => {
    if (!formMarks.has(form)) {
      const own = [form.id, form.className && String(form.className), attr(form, "action"), attr(form, "name"), attr(form, "aria-label"), attr(form, "data-ui"), attr(form, "data-testid")].join(" ");
      let inner = "";
      try {
        inner = Array.from(form.querySelectorAll("[class], [id]"), (n) => `${n.id} ${String(n.className)}`).join(" ");
      } catch {
        /* ignore */
      }
      formMarks.set(form, { own, inner, text: String(form.innerText || "").slice(0, 300) });
    }
    return formMarks.get(form);
  };
  // A sign-in step that asks for the email first (the password comes next).
  const accountRe = /sign[-_ ]?in|log[-_ ]?in|create (an |your )?account|sign[-_ ]?up|register/i;
  let ready = false;
  let account = false;
  for (const [key, g] of groups) {
    // A password box without an upload is a sign-in or sign-up, even when the
    // page wraps it in one big form with a job-alert block (SuccessFactors).
    if (g.password && !g.file) {
      account = true;
      continue;
    }
    const m = key === PAGE ? { own: "", inner: "", text: "" } : marksOf(key);
    if (key !== PAGE) {
      // An upload or a phone number marks an application even if the form
      // offers to join a talent pool or subscribe to texts.
      if (!g.file && (signupRe.test(m.own) || (!g.phone && (signupRe.test(m.inner) || signupRe.test(m.text))))) continue;
      if (referRe.test(m.own) || (!g.file && (referRe.test(m.inner) || referRe.test(m.text)))) continue;
    }
    if (g.friend && !g.file) continue;
    if (!g.file && (g.email || g.user) && !g.name && accountRe.test(`${document.title || ""} ${m.own} ${m.text}`)) {
      account = true;
      continue;
    }
    // A formless page needs more than a stray upload control.
    const upload = g.file && g.shown >= 1 && (key !== PAGE || g.email || g.name);
    const contact = g.email && g.name && g.shown >= rules.minFields;
    if (upload || contact) ready = true;
  }
  if (ready) account = false;
  // iCIMS opens every application with "Enter Your Information" (email, then Next). It is a step of the
  // application, not an account wall: the iCIMS engine passes it.
  let gate = null;
  try {
    if (!ready && document.getElementById("enterEmailForm")) gate = "icims-email";
  } catch {
    /* no getElementById (tests) */
  }
  if (gate) account = false;

  // Only a page without a form can be a dead posting. Headings and alerts are
  // read in full; body text only on a sparse page, where a description
  // mentioning "applications closed on Friday" cannot be the cause.
  let gone = false;
  if (!ready && !account && rules.goneText) {
    const goneRe = new RegExp(rules.goneText);
    const norm = (t) => String(t || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
    gone = !!rules.goneUrl && new RegExp(rules.goneUrl, "i").test(String(location.pathname || "") + String(location.search || ""));
    if (!gone) {
      const noticeSel = "h1, h2, h3, [role=alert], [class*=flash], [class*=alert], [class*=error], [class*=notice], [class*=not-found], [class*=notfound], [class*=empty-state]";
      const notices = [document.title, ...Array.from(document.querySelectorAll(noticeSel)).filter(visible).map(text)];
      gone = notices.some((t) => goneRe.test(norm(t)));
    }
    if (!gone) {
      const body = norm(document.body && document.body.innerText);
      gone = body.length > 0 && body.length < 1500 && goneRe.test(body);
    }
  }
  const base = account ? { ready, fields, gone, account } : { ready, fields, gone };
  if (gate) base.gate = gate;
  if (ready || gone || gate || !act) return base;

  const applyText = new RegExp(rules.applyText);
  const notApply = new RegExp(rules.notApplyText);
  const applyAttr = new RegExp(rules.applyAttr);
  const candidates = deepAll("a, button, [role=button], input[type=button], input[type=submit]")
    .filter((el) => visible(el) && !el.disabled && attr(el, "aria-disabled") !== "true")
    .map((el) => {
      const t = text(el);
      const attrs = [el.id, el.className && String(el.className), attr(el, "data-ui"), attr(el, "data-testid"), attr(el, "data-qa")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!t || notApply.test(t) || t.length > 60) return null;
      const score = applyText.test(t) ? 2 : applyAttr.test(attrs) && /apply/.test(t) ? 1 : 0;
      return score ? { el, t, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const hit = candidates[0];
  if (!hit) return base;
  if (act === "peek") return { ...base, candidate: { label: hit.t, score: hit.score } };
  // In a sub-frame (iCIMS renders the job in #icims_content_iframe) the link is clicked in place.
  const framed = typeof window !== "undefined" && window.top !== window;
  const href = hit.el.tagName === "A" && !framed ? attr(hit.el, "href") : "";
  if (href && !/^(#|javascript:|mailto:)/i.test(href)) {
    try {
      const url = new URL(href, location.href);
      if (url.href.split("#")[0] !== location.href.split("#")[0]) return { ready: false, fields, label: hit.t, href: url.href };
    } catch {
      /* fall through to a click */
    }
  }
  try {
    hit.el.scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  hit.el.click();
  return { ready: false, fields, label: hit.t, clicked: true };
}

const RULES = { applyText: APPLY_TEXT, notApplyText: NOT_APPLY_TEXT, applyAttr: APPLY_ATTR, minFields: MIN_FORM_FIELDS, goneText: GONE_TEXT, goneUrl: GONE_URL };
// The rules probeApplyPage is called with (tests and tooling run it directly).
export const PROBE_RULES = RULES;
const HOPS = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probe(tabId, act) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: !act },
      func: probeApplyPage,
      args: [RULES, act],
    });
    return (results || []).map((r) => r && r.result).filter(Boolean);
  } catch {
    return [];
  }
}

/** Act on the frame whose Apply control scores best (the top frame wins ties): job sites such as iCIMS
 *  render the posting, and its Apply link, inside an iframe. */
async function act(tabId) {
  let peeks = [];
  try {
    peeks = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeApplyPage, args: [RULES, "peek"] });
  } catch {
    return null;
  }
  const seen = (peeks || []).filter((r) => r && r.result);
  const done = seen.find((r) => r.result.ready || r.result.gone || r.result.gate);
  if (done) return done.result;
  const account = seen.some((r) => r.result.account);
  let best = null;
  for (const r of seen) {
    const c = r.result.candidate;
    if (!c) continue;
    if (!best || c.score > best.c.score || (c.score === best.c.score && r.frameId === 0)) best = { frameId: r.frameId, c };
  }
  if (!best) return { ready: false, fields: 0, gone: false, ...(account ? { account } : {}) };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [best.frameId] }, func: probeApplyPage, args: [RULES, true] });
    const out = res && res.result;
    return out ? { ...out, ...(account ? { account } : {}) } : null;
  } catch {
    return null;
  }
}

async function settled(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === "complete") return true;
    await sleep(400);
  }
  return true;
}

// Pages that mount the form on an animation frame (Workable) do nothing in a
// hidden tab, so after this long the tab is shown once.
const FOCUS_AFTER_MS = 3000;
const RENDER_WAIT_MS = 8000;

/**
 * Make sure the tab shows an application form, clicking through "Apply" up to
 * a few times. A click that opens a new tab is folded back into this one.
 * `focus(tabId)` brings a background tab to the front when the form is slow.
 * Returns { ready, gone, account, gate, steps: [labels clicked], tab }; `gate` names a known pre-form step
 * the platform engine passes itself (iCIMS "Enter Your Information"); `gone` means
 * the posting itself is expired or removed, `account` that the page asks to
 * sign in or create an account instead of showing an application.
 */
export async function reachApplicationForm(tabId, { onStep = () => {}, waitMs = 15_000, focus = null } = {}) {
  const steps = [];
  let account = false;
  for (let hop = 0; hop <= HOPS; hop++) {
    const frames = await probe(tabId, false);
    account = frames.some((f) => f.account);
    if (frames.some((f) => f.ready)) return { ready: true, gone: false, steps, tab: await chrome.tabs.get(tabId) };
    if (frames.some((f) => f.gone)) return { ready: false, gone: true, steps, tab: await chrome.tabs.get(tabId).catch(() => null) };
    const gated = frames.find((f) => f.gate);
    if (gated) return { ready: false, gone: false, gate: gated.gate, steps, tab: await chrome.tabs.get(tabId).catch(() => null) };
    if (hop === HOPS) break;

    const opened = [];
    const onCreated = (t) => {
      if (t.openerTabId === tabId) opened.push(t.id);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    let action;
    try {
      // Single-page job sites draw the Apply button a while after the tab
      // reports loaded, so the first page gets time to render.
      const renderStart = Date.now();
      const renderEnd = renderStart + (hop === 0 ? RENDER_WAIT_MS : 0);
      let shown = false;
      for (;;) {
        action = await act(tabId);
        if (action && (action.ready || action.gone || action.href || action.clicked)) break;
        if (Date.now() >= renderEnd) break;
        if (focus && !shown && Date.now() - renderStart >= FOCUS_AFTER_MS) {
          shown = true;
          await Promise.resolve(focus(tabId)).catch(() => {});
        }
        await sleep(800);
      }
    } finally {
      setTimeout(() => chrome.tabs.onCreated.removeListener(onCreated), 3000);
    }
    if (action && action.ready) return { ready: true, gone: false, steps, tab: await chrome.tabs.get(tabId) };
    if (action && action.gate) return { ready: false, gone: false, gate: action.gate, steps, tab: await chrome.tabs.get(tabId) };
    if (action && action.gone) return { ready: false, gone: true, steps, tab: await chrome.tabs.get(tabId).catch(() => null) };
    if (action && action.account) account = true;
    if (!action || !(action.href || action.clicked)) break;
    steps.push(action.label || "Apply");
    onStep(`Opening the application ("${action.label || "Apply"}")…`);
    if (action.href) {
      await chrome.tabs.update(tabId, { url: action.href });
      await sleep(500);
      await settled(tabId, 45_000);
    }

    // A form mounted in place, a page load, or a new tab: wait for whichever comes.
    const clickedAt = Date.now();
    const end = clickedAt + waitMs;
    let focused = false;
    while (Date.now() < end) {
      await sleep(700);
      if (focus && !focused && Date.now() - clickedAt >= FOCUS_AFTER_MS) {
        focused = true;
        await Promise.resolve(focus(tabId)).catch(() => {});
      }
      if (opened.length) {
        const extra = await chrome.tabs.get(opened[0]).catch(() => null);
        const url = extra && (extra.pendingUrl || extra.url);
        if (url && /^https?:/i.test(url)) {
          await chrome.tabs.remove(opened[0]).catch(() => {});
          opened.length = 0;
          await chrome.tabs.update(tabId, { url });
          await sleep(500);
          await settled(tabId, 45_000);
        }
      }
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { ready: false, gone: false, steps, tab: null };
      if (tab.status !== "complete") continue;
      const now = await probe(tabId, false);
      if (now.some((f) => f.ready || f.gone || f.account || f.gate)) break;
    }
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // The same Apply clicked again and again opened nothing: a stray sign-in box elsewhere on the
  // page (an employee "Log in") is not the reason, so report the failed click instead.
  const stuck = steps.length >= 2 && steps[steps.length - 1] === steps[steps.length - 2];
  if (account && !stuck) return { ready: false, gone: false, account: true, steps, tab };
  return { ready: false, gone: !!tab && (await jobGone(tabId, GONE_WAIT_MS)), steps, tab };
}

// Single-page job sites render their "not found" notice a moment after load.
const GONE_WAIT_MS = 4000;

/** Whether the tab shows an expired or removed posting (and no form), polling briefly. */
export async function jobGone(tabId, waitMs = GONE_WAIT_MS) {
  const end = Date.now() + waitMs;
  for (;;) {
    const frames = await probe(tabId, false);
    if (frames.some((f) => f.ready)) return false;
    if (frames.some((f) => f.gone)) return true;
    if (Date.now() >= end) return false;
    await sleep(800);
  }
}
