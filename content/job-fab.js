// The corner toolbar on application pages NAO opened for a job: four small icon buttons.
//   ✓✓  Applied        record the application as applied
//   ✕   Invalid        report the posting (expired, filled, broken); asks for a second click to confirm
//   ⏭   Skip           set the job aside (auto-apply: try it after the rest of the queue; panel: next job)
//   »   Open in NAO    open the side panel on this job (fill again, documents, details)
// Auto-apply's jobs are acted on by the auto-apply console, jobs the side panel opened by the panel, others by the
// background (see background.js fabAction). Skip shows only when one of the two can act on it.
// While NAO fills the page the » button spins; a dot shows how the last fill ended. The "Buttons on application
// pages" setting in the side panel turns the toolbar off.
//
// Top frame only. A closed shadow root keeps the page's CSS out, and keeps the buttons out of the engine's field
// scan and auto-apply's submit search.

(function () {
  if (window.top !== window || window.__NAO_JOB_FAB__) return;
  window.__NAO_JOB_FAB__ = true;

  const PREF_KEY = "aaPageButtons";
  const NOTE_MS = 6_000;
  const CONFIRM_MS = 3_000;

  const ICONS = {
    applied: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
    invalid: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    skip: '<path d="M5 4.5v15l10-7.5z"/><path d="M19 5v14"/>',
    open: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
  };
  const svg = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const host = document.createElement("div");
  host.setAttribute("data-nao-job", "");
  host.style.cssText = "all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
      .bar {
        display: inline-flex; align-items: center; gap: 2px; padding: 3px;
        border-radius: 999px; border: 1px solid oklch(0.85 0.06 262 / 22%);
        background: oklch(0.185 0.024 267 / 94%); box-shadow: 0 6px 18px rgb(0 0 0 / 28%);
      }
      .sep { width: 1px; height: 16px; margin: 0 3px; background: oklch(0.85 0.06 262 / 18%); }
      button {
        position: relative; width: 28px; height: 28px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
        display: grid; place-items: center; background: transparent; color: oklch(0.82 0.03 262);
        transition: background 120ms ease, color 120ms ease, transform 120ms ease;
      }
      button svg { width: 15px; height: 15px; }
      button:hover { transform: translateY(-1px); }
      button:focus-visible { outline: 2px solid oklch(0.75 0.14 260); outline-offset: 1px; }
      button:disabled { cursor: progress; opacity: 0.6; transform: none; }
      button[hidden] { display: none; }
      .applied:hover { background: oklch(0.72 0.15 155 / 18%); color: oklch(0.82 0.15 155); }
      .invalid:hover { background: oklch(0.65 0.2 25 / 18%); color: oklch(0.78 0.16 25); }
      .invalid[data-armed] { background: oklch(0.6 0.2 25); color: #fff; }
      .skip:hover { background: oklch(0.82 0.15 85 / 16%); color: oklch(0.86 0.14 85); }
      .open { background: oklch(0.62 0.19 260); color: #fff; }
      .open:hover { background: oklch(0.68 0.19 260); }
      .open .spin { display: none; position: absolute; inset: -1px; border-radius: 50%;
        border: 2px solid transparent; border-top-color: oklch(0.85 0.12 260); animation: spin 800ms linear infinite; }
      .open[data-state="running"] .spin { display: block; }
      .dot { position: absolute; top: -1px; right: -1px; width: 9px; height: 9px; border-radius: 50%; display: none;
        border: 1.5px solid oklch(0.185 0.024 267); }
      .dot.ok { display: block; background: oklch(0.72 0.15 155); }
      .dot.warn { display: block; background: oklch(0.82 0.15 85); }
      .dot.danger { display: block; background: oklch(0.65 0.2 25); }
      .tip {
        max-width: 260px; padding: 7px 10px; border-radius: 10px; display: none;
        background: oklch(0.185 0.024 267); color: oklch(0.8 0.03 262); font-size: 11.5px; line-height: 1.45;
        border: 1px solid oklch(0.85 0.06 262 / 18%); box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
      }
      .tip b { color: oklch(0.95 0.008 260); font-weight: 600; }
      .wrap.show-tip .tip { display: block; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .open .spin { animation: none; } button:hover { transform: none; } }
    </style>
    <div class="wrap">
      <div class="bar" role="toolbar" aria-label="NAO">
        <button class="applied" type="button" data-action="applied" aria-label="Mark as applied">${svg("applied")}</button>
        <button class="invalid" type="button" data-action="invalid" aria-label="Mark as invalid">${svg("invalid")}</button>
        <button class="skip" type="button" data-action="skip" aria-label="Skip this job" hidden>${svg("skip")}</button>
        <span class="sep" aria-hidden="true"></span>
        <button class="open" type="button" aria-label="Open this job in NAO">${svg("open")}<span class="spin" aria-hidden="true"></span><span class="dot"></span></button>
      </div>
      <div class="tip" role="status" aria-live="polite"></div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const wrap = $(".wrap");
  const openBtn = $(".open");
  const dot = $(".dot");
  const tip = $(".tip");
  const actionBtns = [...root.querySelectorAll("button[data-action]")];
  const byAction = Object.fromEntries(actionBtns.map((b) => [b.dataset.action, b]));

  const HINTS = {
    applied: "<b>Mark as applied</b><br>Records this application as applied.",
    invalid: "<b>Mark as invalid</b><br>The posting is expired, filled or broken. Removes it from your lists.",
    skip: "<b>Skip</b><br>Sets this job aside and moves on.",
    open: "<b>Open in NAO</b><br>Fill again, see your tailored resume and cover letter, and the job's details.",
  };

  let available = false;
  let enabled = true;
  let noteTimer = null;
  let armTimer = null;
  let statusMessage = "";
  let busy = false;

  function setTip(html, { pinned = false } = {}) {
    clearTimeout(noteTimer);
    tip.innerHTML = html;
    wrap.classList.add("show-tip");
    if (pinned) noteTimer = setTimeout(hideTip, NOTE_MS);
  }

  function hideTip() {
    clearTimeout(noteTimer);
    wrap.classList.remove("show-tip");
  }

  function note(text) {
    const div = document.createElement("div");
    div.textContent = text;
    setTip(div.innerHTML, { pinned: true });
  }

  function hint(key) {
    let html = HINTS[key];
    if (key === "open" && statusMessage) {
      const extra = document.createElement("div");
      extra.style.marginTop = "5px";
      extra.textContent = statusMessage;
      html += extra.outerHTML;
    }
    setTip(html);
  }

  function paint(state, message, actions) {
    openBtn.dataset.state = state || "idle";
    openBtn.setAttribute("aria-label", state === "running" ? "NAO is filling this page. Open it in NAO" : "Open this job in NAO");
    const tone = state === "done" ? "ok" : state === "needs" ? "warn" : state === "error" ? "danger" : "";
    dot.className = "dot" + (tone ? " " + tone : "");
    statusMessage = state === "running" ? "Filling…" : message || "";
    if (actions) byAction.skip.hidden = !actions.skip;
  }

  function mount() {
    if (available && enabled && !host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function unmount() {
    host.remove();
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res || null);
        });
      } catch {
        resolve(null); // extension reloaded: this page's script is orphaned
      }
    });
  }

  // Hover / focus shows what a button does; leaving hides it (notes stay for a few seconds).
  for (const b of [...actionBtns, openBtn]) {
    const key = b.dataset.action || "open";
    b.addEventListener("mouseenter", () => !busy && !byAction.invalid.dataset.armed && hint(key));
    b.addEventListener("focus", () => !busy && hint(key));
    b.addEventListener("mouseleave", () => !noteTimer && hideTip());
    b.addEventListener("blur", () => !noteTimer && hideTip());
  }
  wrap.addEventListener("mouseleave", () => {
    if (!byAction.invalid.dataset.armed && !busy) {
      clearTimeout(noteTimer);
      noteTimer = null;
      hideTip();
    }
  });

  function disarm() {
    clearTimeout(armTimer);
    delete byAction.invalid.dataset.armed;
    byAction.invalid.setAttribute("aria-label", "Mark as invalid");
  }

  async function act(action) {
    if (busy) return;
    if (action === "invalid" && !byAction.invalid.dataset.armed) {
      byAction.invalid.dataset.armed = "1";
      byAction.invalid.setAttribute("aria-label", "Click again to mark as invalid");
      setTip("<b>Mark this posting invalid?</b><br>Click ✕ again to confirm.");
      armTimer = setTimeout(() => {
        disarm();
        hideTip();
      }, CONFIRM_MS);
      return;
    }
    disarm();
    busy = true;
    actionBtns.forEach((b) => (b.disabled = true));
    setTip(action === "applied" ? "Marking as applied…" : action === "invalid" ? "Reporting the posting…" : "Skipping…");
    const res = await send({ type: "AA_FAB_ACTION", action });
    busy = false;
    actionBtns.forEach((b) => (b.disabled = false));
    noteTimer = null;
    if (!res) note("NAO is not reachable. Reload this page and try again.");
    else if (!res.ok) note(res.error || "Could not do that.");
    else {
      if (res.state) paint(res.state, res.message || "", null);
      note(res.message || "Done.");
    }
  }

  for (const b of actionBtns) b.addEventListener("click", () => void act(b.dataset.action));

  openBtn.addEventListener("click", async () => {
    // Sent straight from the click so the side panel may open (it needs the user's gesture).
    const res = await send({ type: "AA_FAB_EXPAND" });
    noteTimer = null;
    if (!res) note("NAO is not reachable. Reload this page and try again.");
    else if (!res.ok) note(res.error || "Could not open NAO for this job.");
    else if (res.fallback) note("Opened this job in the NAO web app.");
  });

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || typeof m.type !== "string") return;
      if (m.type === "AA_FAB_HIDE") {
        available = false;
        unmount();
      } else if (m.type === "AA_FAB_STATUS") {
        paint(m.state, m.state === "running" ? "" : m.message || "", m.actions || null);
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[PREF_KEY]) return;
      enabled = changes[PREF_KEY].newValue !== false;
      if (enabled) mount();
      else unmount();
    });
  } catch {
    return;
  }

  Promise.all([
    send({ type: "AA_FAB_STATE" }),
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(PREF_KEY, (o) => resolve(!(o && o[PREF_KEY] === false)));
      } catch {
        resolve(true);
      }
    }),
  ]).then(([s, on]) => {
    if (!s || !s.show) {
      window.__NAO_JOB_FAB__ = false;
      return;
    }
    available = true;
    enabled = on;
    paint(s.state || "idle", s.message || "", s.actions || null);
    mount();
  });
})();
