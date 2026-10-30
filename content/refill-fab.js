// Corner buttons on tabs auto-apply left for the user: Fill again, Skip, and
// Invalid job. Auto-apply works in its own window, where the side panel is not
// open, so these act on the job without finding it in the console. The user
// can hide them; the "Buttons on application pages" setting brings them back.
//
// Top frame only. A closed shadow root keeps the page's CSS out, and keeps the
// buttons out of the engine's field scan and auto-apply's submit search.

(function () {
  if (window.top !== window || window.__NAO_REFILL_FAB__) return;
  window.__NAO_REFILL_FAB__ = true;

  const RESULT_SHOW_MS = 10_000;
  const PREF_KEY = "aaPageButtons";

  const host = document.createElement("div");
  host.setAttribute("data-nao-refill", "");
  host.style.cssText = "all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
      .bar {
        display: flex; align-items: center; gap: 4px; padding: 3px; border-radius: 999px;
        background: oklch(0.185 0.024 267 / 92%); border: 1px solid oklch(0.85 0.06 262 / 18%);
        box-shadow: 0 4px 14px rgb(0 0 0 / 25%);
      }
      .act {
        position: relative; width: 26px; height: 26px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
        display: grid; place-items: center; transition: filter 120ms ease, transform 120ms ease;
      }
      .act:hover:not(:disabled) { filter: brightness(1.12); transform: translateY(-1px); }
      .act:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
      .act:disabled { opacity: 0.4; cursor: not-allowed; }
      .act svg { width: 13px; height: 13px; }
      .refill { background: oklch(0.62 0.19 260); color: #fff; }
      .skip { background: oklch(0.82 0.15 85); color: oklch(0.25 0.05 80); }
      .invalid { background: oklch(0.62 0.21 25); color: #fff; }
      .refill[aria-busy="true"] { cursor: progress; }
      .refill[aria-busy="true"] svg { animation: spin 900ms linear infinite; }
      .dot {
        position: absolute; top: -1px; right: -1px; width: 8px; height: 8px; border-radius: 50%;
        border: 1.5px solid oklch(0.185 0.024 267); display: none;
      }
      .dot.warn { display: block; background: oklch(0.82 0.15 85); }
      .dot.ok { display: block; background: oklch(0.72 0.15 155); }
      .dot.danger { display: block; background: oklch(0.65 0.2 25); }
      .hide {
        width: 18px; height: 18px; border: 0; border-radius: 50%; padding: 0; cursor: pointer; margin-left: 1px;
        background: transparent; color: oklch(0.71 0.03 262); font-size: 13px; line-height: 1;
      }
      .hide:hover { background: oklch(0.3 0.03 267); color: #fff; }
      .card {
        width: 250px; padding: 9px 11px; border-radius: 10px; display: none;
        background: oklch(0.185 0.024 267); color: oklch(0.95 0.008 260);
        border: 1px solid oklch(0.85 0.06 262 / 18%); box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
        font-size: 12px; line-height: 1.45;
      }
      .wrap.open .card, .wrap:hover .card, .wrap:focus-within .card { display: block; }
      .title { font-weight: 600; font-size: 11.5px; margin-bottom: 2px; }
      .title.warn { color: oklch(0.82 0.15 85); }
      .title.ok { color: oklch(0.72 0.15 155); }
      .title.danger { color: oklch(0.7 0.18 25); }
      .title.brand { color: oklch(0.75 0.14 260); }
      .msg { color: oklch(0.75 0.03 262); word-break: break-word; max-height: 110px; overflow: auto; }
      .hint { margin-top: 5px; color: oklch(0.6 0.03 262); font-size: 11px; }
      .choices { display: none; gap: 6px; margin-top: 8px; justify-content: flex-end; }
      .choices.on { display: flex; }
      .choices button {
        border: 0; border-radius: 6px; padding: 4px 10px; font-size: 11.5px; font-weight: 600; cursor: pointer;
      }
      .no { background: oklch(0.27 0.026 267); color: oklch(0.9 0.01 260); }
      .no:hover { background: oklch(0.32 0.03 267); }
      .yes.skip, .yes.invalid, .yes.hide-yes { color: #fff; }
      .yes.skip { color: oklch(0.25 0.05 80); }
      .yes.hide-yes { background: oklch(0.45 0.03 267); }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .refill[aria-busy="true"] svg { animation: none; } }
    </style>
    <div class="wrap">
      <div class="bar" role="toolbar" aria-label="NAO auto-apply">
        <button class="act refill" type="button" data-act="refill" aria-label="Fill again">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
          </svg>
          <span class="dot"></span>
        </button>
        <button class="act skip" type="button" data-act="skip" aria-label="Skip this job">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 5l9 7-9 7V5z"/><path d="M19 5v14"/>
          </svg>
        </button>
        <button class="act invalid" type="button" data-act="invalid" aria-label="Mark this job invalid">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>
          </svg>
        </button>
        <button class="hide" type="button" data-act="hide" aria-label="Hide these buttons">\u00d7</button>
      </div>
      <div class="card" role="status" aria-live="polite">
        <div class="title"></div>
        <div class="msg"></div>
        <div class="hint"></div>
        <div class="choices">
          <button class="no" type="button">Cancel</button>
          <button class="yes" type="button"></button>
        </div>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const wrap = $(".wrap");
  const refillBtn = $(".refill");
  const skipBtn = $(".act.skip");
  const invalidBtn = $(".act.invalid");
  const dot = $(".dot");
  const titleEl = $(".title");
  const msgEl = $(".msg");
  const hintEl = $(".hint");
  const choices = $(".choices");
  const yesBtn = $(".yes");

  // What the page shows: the run state, plus a hovered button's help or a pending confirmation.
  let view = { state: "idle", message: "", status: "" };
  let preview = null;
  let confirming = null;
  let busy = false;
  let collapseTimer = null;
  let available = false;
  let enabled = true;

  const STATES = {
    idle: ["NAO auto-apply", ""],
    running: ["Filling\u2026", "brand"],
    done: ["Done", "ok"],
    needs: ["Needs you", "warn"],
    error: ["Something went wrong", "danger"],
    closing: ["Closing this tab\u2026", ""],
  };

  const HELP = {
    refill: ["Fill again", "brand", "Fills the empty fields on this page again. Nothing is submitted."],
    skip: ["Skip", "warn", "Closes this tab. Auto-apply will not try this job again unless you retry it from History."],
    invalid: ["Invalid job", "danger", "Closes this tab and hides the job from your lists, for postings that are closed, fake or not a real job."],
    hide: ["Hide buttons", "", "Hides these buttons on every application page."],
  };

  const CONFIRM = {
    skip: ["Skip this job?", "warn", "The tab closes and auto-apply moves on. You can retry it from History in the auto-apply console.", "Skip job", "skip"],
    invalid: ["Mark this job invalid?", "danger", "The tab closes and the job is hidden from your lists. Restore it from Invalid jobs on the web app.", "Mark invalid", "invalid"],
    hide: ["Hide these buttons?", "", "They stop showing on application pages. Turn them back on in the NAO side panel under Settings, Autofill.", "Hide", "hide-yes"],
  };

  function setTitle(text, tone) {
    titleEl.textContent = text;
    titleEl.className = "title" + (tone ? " " + tone : "");
  }

  function paint() {
    const running = view.state === "running";
    refillBtn.setAttribute("aria-busy", running ? "true" : "false");
    for (const b of [refillBtn, skipBtn, invalidBtn]) b.disabled = busy || view.state === "closing";
    refillBtn.disabled = refillBtn.disabled || running;
    skipBtn.disabled = skipBtn.disabled || running;
    invalidBtn.disabled = invalidBtn.disabled || running;
    refillBtn.title = running ? "NAO is filling this application" : "Fill again";
    skipBtn.title = "Skip this job";
    invalidBtn.title = "Mark this job invalid";

    const tone = running ? "" : view.state === "done" ? "ok" : view.state === "error" ? "danger" : view.state === "needs" || /needs_you|failed/.test(view.status) ? "warn" : "";
    dot.className = "dot" + (tone ? " " + tone : "");

    choices.classList.toggle("on", !!confirming);
    if (confirming) {
      const [title, t, text, yes, cls] = CONFIRM[confirming];
      setTitle(title, t);
      msgEl.textContent = text;
      hintEl.textContent = "";
      yesBtn.textContent = yes;
      yesBtn.className = "yes " + cls;
      yesBtn.style.background = cls === "skip" ? "oklch(0.82 0.15 85)" : cls === "invalid" ? "oklch(0.62 0.21 25)" : "";
    } else if (preview && !running) {
      const [title, t, text] = HELP[preview];
      setTitle(title, t);
      msgEl.textContent = text;
      hintEl.textContent = "";
    } else {
      const [title, t] = STATES[view.state] || STATES.idle;
      setTitle(title, t);
      msgEl.textContent = view.message || (view.state === "idle" ? "Auto-apply left this application for you." : "");
      hintEl.textContent = running ? "Keep this tab open until it finishes." : view.state === "closing" ? "" : "Blue fills again, yellow skips, red marks the job invalid.";
    }
    msgEl.style.display = msgEl.textContent ? "" : "none";
    hintEl.style.display = hintEl.textContent ? "" : "none";
  }

  function show(next, message, { status = view.status, open = false } = {}) {
    view = { state: next, message: message || "", status };
    clearTimeout(collapseTimer);
    wrap.classList.toggle("open", next === "running" || next === "closing" || open || !!confirming);
    if (open && next !== "running") collapseTimer = setTimeout(() => !confirming && wrap.classList.remove("open"), RESULT_SHOW_MS);
    paint();
  }

  function mount() {
    if (available && enabled && !host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function unmount() {
    clearTimeout(collapseTimer);
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

  async function refill() {
    if (view.state === "running") return;
    show("running", "Starting\u2026");
    const res = await send({ type: "AA_REFILL" });
    if (!res) return show("error", "NAO is not reachable. Reload this page and try again.", { open: true });
    if (!res.ok) return show("error", res.error || "Could not start filling.", { open: true });
    if (res.opening) show("running", "Opening auto-apply\u2026");
  }

  async function decide(kind) {
    busy = true;
    paint();
    const res = await send({ type: kind === "skip" ? "AA_PAGE_SKIP" : "AA_PAGE_INVALID" });
    busy = false;
    if (res && res.ok) return show("closing", kind === "skip" ? "Skipped." : "Marked invalid.");
    show("error", (res && res.error) || "NAO is not reachable. Reload this page and try again.", { open: true });
  }

  function ask(kind) {
    confirming = kind;
    preview = null;
    show(view.state, view.message, { open: true });
  }

  function cancelAsk() {
    confirming = null;
    show(view.state, view.message, { open: false });
  }

  root.querySelector(".bar").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute("data-act");
    if (act === "refill") {
      confirming = null;
      void refill();
    } else {
      ask(act);
    }
  });
  for (const btn of root.querySelectorAll("button[data-act]")) {
    btn.addEventListener("mouseenter", () => {
      preview = btn.getAttribute("data-act");
      paint();
    });
    btn.addEventListener("mouseleave", () => {
      preview = null;
      paint();
    });
  }
  $(".no").addEventListener("click", cancelAsk);
  yesBtn.addEventListener("click", () => {
    const kind = confirming;
    confirming = null;
    if (kind === "hide") {
      try {
        chrome.storage.local.set({ [PREF_KEY]: false });
      } catch {
        /* orphaned script */
      }
      unmount();
      return;
    }
    if (kind) void decide(kind);
  });

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || typeof m.type !== "string") return;
      if (m.type === "AA_FAB_HIDE") {
        available = false;
        unmount();
      } else if (m.type === "AA_FAB_STATUS") {
        show(m.state || "idle", m.message || "", { open: m.state !== "running" });
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
      window.__NAO_REFILL_FAB__ = false;
      return;
    }
    available = true;
    enabled = on;
    show(s.state || "idle", s.message || "", { status: s.status || "" });
    mount();
  });
})();
