// Auto-apply run recorder (admin-enabled per account; off for everyone else).
//
// When the server says this account is recorded, a run keeps its step trail and takes masked snapshots of the
// application page (structure, labels and options; never typed values), and a run that did not finish uploads
// them so the failure can be reproduced offline. When it is off (the default, or the server cannot be reached),
// every call here returns at once and nothing is collected or sent.

import { apiFetch } from "../api.js";

const CACHE_KEY = "aaRecording";
const CACHE_MS = 5 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 20_000;
const MAX_FRAME_CHARS = 1_200_000;
const MAX_TOTAL_CHARS = 3_500_000;
const MAX_STEPS = 300;
const UPLOAD_OUTCOMES = new Set(["failed", "needs_you", "invalid"]);

function timeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

/** Whether this account is recorded. Asked once per 5 minutes; any error means off. */
export async function recordingEnabled() {
  try {
    const cached = (await chrome.storage.session.get(CACHE_KEY))[CACHE_KEY];
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.enabled === true;
    const res = await timeout(apiFetch("/extension/run-recording", { timeoutMs: 8_000 }), 9_000, null);
    const enabled = Boolean(res && res.enabled === true);
    await chrome.storage.session.set({ [CACHE_KEY]: { enabled, at: Date.now() } });
    return enabled;
  } catch {
    return false;
  }
}

/** The account's own details to blank out of snapshots (top-level contact fields of the profile). */
export function profileTerms(profile) {
  const out = new Set();
  const keep = /(e-?mail|phone|mobile|name|address|street|zip|postal|linkedin|github|portfolio|website|twitter)/i;
  const skip = /(company|employer|school|title|job|file|resume|cover)/i;
  const add = (v) => {
    const s = String(v || "").trim();
    if (s.length >= 3 && s.length <= 200) out.add(s);
    // A phone number also as bare digits, the way some forms show it back.
    const digits = s.replace(/[^0-9]/g, "");
    if (digits.length >= 7 && /^[0-9\s().+-]+$/.test(s)) out.add(digits);
  };
  const walk = (obj, depth) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && keep.test(k) && !skip.test(k)) add(v);
      else if (depth < 1 && v && typeof v === "object" && !Array.isArray(v) && /contact|personal|address|basics|links/i.test(k)) walk(v, depth + 1);
    }
  };
  walk(profile, 0);
  return [...out].sort((a, b) => b.length - a.length).slice(0, 60);
}

/**
 * Runs in the page (each frame): the DOM as HTML with values masked. Self-contained (executeScript serializes it).
 * Inputs keep their type, name, labels and state (checked, selected, invalid, visible) but typed text becomes
 * "[N chars]"; short choice-like values on comboboxes stay ("Yes", "United States") after redaction.
 */
export function pageSnapshot(terms, maxChars) {
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Whole words only, so a first name "Pat" never blanks "Patent".
  const termRe = terms && terms.length ? new RegExp(`(?<![\\w])(?:${terms.map(escRe).join("|")})(?![\\w])`, "gi") : null;
  const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const phoneRe = /\+?\d[\d\s().-]{7,}\d/g;
  const red = (s) => {
    let t = String(s || "");
    if (termRe) t = t.replace(termRe, "[redacted]");
    return t.replace(emailRe, "[email]").replace(phoneRe, "[number]");
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const VOID = new Set(["area", "br", "col", "hr", "img", "input", "wbr", "source", "track"]);
  const DROP = new Set(["script", "style", "noscript", "template", "link", "meta", "head", "canvas", "video", "audio", "object", "embed", "picture"]);
  const ATTR = /^(id|name|type|role|for|class|placeholder|required|disabled|readonly|multiple|accept|maxlength|pattern|title|alt|tabindex|hidden|open|autocomplete|aria-[a-z-]+|data-automation-id|data-testid|data-test|data-qa|data-ui|data-field|data-id|data-name)$/i;
  let out = "";
  let full = false;
  const push = (s) => {
    if (full) return;
    out += s;
    if (out.length > maxChars) {
      full = true;
      out += "<!-- nao: truncated -->";
    }
  };
  const visible = (el) => {
    try {
      return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
    } catch {
      return true;
    }
  };
  const attrs = (el) => {
    let s = "";
    for (const a of el.attributes) {
      if (!ATTR.test(a.name)) continue;
      let v = a.value;
      if (a.name === "class") v = v.slice(0, 160);
      s += ` ${a.name}="${esc(red(v).slice(0, 300))}"`;
    }
    if (el.tagName === "A" && el.getAttribute("href")) {
      const href = el.getAttribute("href");
      s += ` data-href="${esc(/^javascript:/i.test(href) ? "javascript:" : href.split(/[?#]/)[0].slice(0, 300))}"`;
    }
    return s;
  };
  const control = (el) => {
    const tag = el.tagName.toLowerCase();
    let s = attrs(el);
    if (!visible(el)) s += ' data-nao-visible="0"';
    try {
      if (el.matches(":invalid") || el.getAttribute("aria-invalid") === "true") s += ' data-nao-invalid="1"';
    } catch {
      /* ignore */
    }
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (el.checked) s += " checked";
        if (el.value && el.value.length <= 60) s += ` value="${esc(red(el.value))}"`;
      } else if (type === "file") {
        s += ` data-nao-files="${el.files ? el.files.length : 0}"`;
      } else if (type === "hidden" || type === "password") {
        if (el.value) s += ` value="[${type}]"`;
      } else if (el.value) {
        const choice =
          el.getAttribute("role") === "combobox" || el.hasAttribute("aria-autocomplete") || el.readOnly || type === "date" || type === "month";
        const v = red(el.value);
        s += choice && v.length <= 60 ? ` value="${esc(v)}"` : ` value="[${el.value.length} chars]"`;
      }
      return `<input${s}>`;
    }
    if (tag === "textarea") return `<textarea${s}>${el.value ? `[${el.value.length} chars]` : ""}</textarea>`;
    // select
    let opts = "";
    for (const o of el.options || []) opts += `<option${o.selected ? " selected" : ""}>${esc(red(o.text).slice(0, 200))}</option>`;
    return `<select${s}>${opts}</select>`;
  };
  const walk = (node, depth) => {
    if (full || depth > 80) return;
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\s+/g, " ");
      if (t.trim()) push(esc(red(t).slice(0, 600)));
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 11) {
      for (const c of node.childNodes) walk(c, depth + 1);
      return;
    }
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return;
    if (tag === "input" || tag === "textarea" || tag === "select") return push(control(el));
    if (tag === "svg") return push(`<svg${attrs(el)}></svg>`);
    if (tag === "iframe" || tag === "frame") {
      let src = "";
      try {
        src = new URL(el.src, location.href).host;
      } catch {
        /* ignore */
      }
      return push(`<iframe${attrs(el)} data-nao-frame="${esc(src)}"></iframe>`);
    }
    if (tag === "img") return push(`<img${attrs(el)}>`);
    let a = attrs(el);
    if (el.isContentEditable && el.textContent.trim() && el.getAttribute("contenteditable") != null) {
      return push(`<${tag}${a} contenteditable>[${el.textContent.length} chars]</${tag}>`);
    }
    if (el.shadowRoot) a += ' data-nao-shadow="1"';
    push(`<${tag}${a}>`);
    if (el.shadowRoot) {
      push('<div data-nao-shadow-root="1">');
      walk(el.shadowRoot, depth + 1);
      push("</div>");
    }
    for (const c of el.childNodes) walk(c, depth + 1);
    if (!VOID.has(tag)) push(`</${tag}>`);
  };
  walk(document.body || document.documentElement, 0);
  const title = red(document.title || "");
  return { url: location.href, top: window === window.top, html: `<!-- ${esc(title).replace(/--/g, "- -")} -->${out}` };
}

/** A recorder for one run. Every method is a cheap no-op until `start()` finds recording on. */
export function createRecorder({ jobId }) {
  let enabled = false;
  let ready = Promise.resolve(false);
  const started = Date.now();
  const steps = [];
  const snapshots = [];
  let terms = [];
  let total = 0;

  return {
    get enabled() {
      return enabled;
    },
    /** Asks the server in the background; the run never waits for it. */
    start() {
      ready = (async () => {
        enabled = await recordingEnabled();
        if (!enabled) return false;
        try {
          const profile = await timeout(apiFetch("/profile", { timeoutMs: 8_000 }), 9_000, null);
          terms = profileTerms(profile);
        } catch {
          terms = [];
        }
        return true;
      })().catch(() => false);
      return ready;
    },
    step(text) {
      if (!text) return;
      steps.push({ t: Date.now() - started, text: String(text).slice(0, 500) });
      if (steps.length > MAX_STEPS) steps.shift();
    },
    /** Masked page structure of every frame of `tabId` now, labelled `label` ("form", "after_fill", "final"). */
    async snapshot(tabId, label, { wait = false } = {}) {
      // Mid-run snapshots never hold the run up for the server's answer; the final one may wait for it.
      if (!enabled && !wait) return;
      if (!(await ready) || tabId == null || total >= MAX_TOTAL_CHARS) return;
      try {
        const results = await timeout(
          chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: pageSnapshot,
            args: [terms, MAX_FRAME_CHARS],
          }),
          SNAPSHOT_TIMEOUT_MS,
          [],
        );
        const frames = (results || [])
          .map((r) => r && r.result)
          .filter((r) => r && r.html && (r.top || r.html.length > 400))
          .sort((a, b) => Number(b.top) - Number(a.top))
          .slice(0, 5);
        for (const f of frames) {
          if (total + f.html.length > MAX_TOTAL_CHARS) break;
          total += f.html.length;
          snapshots.push({ label: f.top ? label : `${label}_frame`, frame_url: f.url, html: f.html });
        }
      } catch {
        /* a closed tab or a page without access: nothing to keep */
      }
    },
    /** Upload when the run did not finish. Waits at most 20s; never throws. */
    async finish(outcome, { platform, pageUrl, autofill } = {}) {
      if (!outcome || !UPLOAD_OUTCOMES.has(outcome.status) || !(await ready)) return false;
      try {
        const body = {
          job_id: jobId,
          platform: platform || null,
          outcome: outcome.status,
          message: String(outcome.message || "").slice(0, 2000),
          page_url: pageUrl || null,
          ext_version: chrome.runtime.getManifest().version,
          duration_ms: Date.now() - started,
          steps,
          fields: fieldSummary(autofill),
          snapshots,
        };
        const res = await timeout(apiFetch("/extension/run-reports", { method: "POST", body, timeoutMs: UPLOAD_TIMEOUT_MS }), UPLOAD_TIMEOUT_MS + 1000, null);
        return Boolean(res && res.stored);
      } catch {
        return false;
      }
    },
  };
}

/** Labels, kinds and fill statuses of the form autofill saw, plus what it asked the user for. Never values. */
export function fieldSummary(af) {
  if (!af) return [];
  const statuses = af.statuses || {};
  const out = [];
  for (const spec of af.specs || []) {
    for (const c of spec.controls || []) {
      out.push({
        label: String(c.label || c.question || spec.label || spec.question || c.cid || "").slice(0, 300),
        kind: c.kind || c.type || spec.kind || null,
        status: statuses[c.cid] || null,
        required: Boolean(c.required || spec.required),
      });
    }
  }
  for (const n of af.needsUser || []) {
    out.push({ label: String(n.label || "").slice(0, 300), kind: "needs_user", status: "needs_user", required: true, note: String(n.reason || "").slice(0, 300) });
  }
  if (af.error) out.push({ label: "Autofill error", kind: "error", status: "error", required: false, note: String(af.error).slice(0, 300) });
  return out.slice(0, 400);
}
