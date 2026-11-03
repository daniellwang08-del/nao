// One corner button on application pages NAO opened for a job: "Open in NAO".
// It opens the NAO side panel on that job, where filling again, skipping,
// reporting the posting and the tailored resume and cover letter all live.
// Shown as soon as the job's page opens, not only after a fill. While NAO is
// filling the page the button shows a spinner. The "Buttons on application
// pages" setting in the side panel turns it off.
//
// Top frame only. A closed shadow root keeps the page's CSS out, and keeps the
// button out of the engine's field scan and auto-apply's submit search.

(function () {
  if (window.top !== window || window.__NAO_JOB_FAB__) return;
  window.__NAO_JOB_FAB__ = true;

  const PREF_KEY = "aaPageButtons";
  const NOTE_MS = 6_000;

  const host = document.createElement("div");
  host.setAttribute("data-nao-job", "");
  host.style.cssText = "all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
      .open {
        position: relative; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px 0 9px;
        border-radius: 999px; border: 1px solid oklch(0.85 0.06 262 / 22%); cursor: pointer;
        background: oklch(0.185 0.024 267 / 94%); color: oklch(0.96 0.008 260);
        font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em;
        box-shadow: 0 6px 18px rgb(0 0 0 / 28%); transition: transform 120ms ease, background 120ms ease;
      }
      .open:hover { background: oklch(0.24 0.035 267 / 96%); transform: translateY(-1px); }
      .open:focus-visible { outline: 2px solid oklch(0.75 0.14 260); outline-offset: 2px; }
      .open:disabled { cursor: progress; }
      .icon {
        width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
        background: oklch(0.62 0.19 260); color: #fff;
      }
      .icon svg { width: 11px; height: 11px; }
      .spin { display: none; width: 12px; height: 12px; border-radius: 50%; border: 2px solid oklch(0.75 0.14 260 / 35%);
        border-top-color: oklch(0.8 0.14 260); animation: spin 800ms linear infinite; }
      .open[data-state="running"] .spin { display: block; }
      .dot { position: absolute; top: -2px; right: -2px; width: 9px; height: 9px; border-radius: 50%; display: none;
        border: 1.5px solid oklch(0.185 0.024 267); }
      .dot.ok { display: block; background: oklch(0.72 0.15 155); }
      .dot.warn { display: block; background: oklch(0.82 0.15 85); }
      .dot.danger { display: block; background: oklch(0.65 0.2 25); }
      .tip {
        width: 240px; padding: 8px 10px; border-radius: 10px; display: none;
        background: oklch(0.185 0.024 267); color: oklch(0.78 0.03 262); font-size: 11.5px; line-height: 1.45;
        border: 1px solid oklch(0.85 0.06 262 / 18%); box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
      }
      .tip b { color: oklch(0.95 0.008 260); font-weight: 600; }
      .wrap:hover .tip, .wrap:focus-within .tip, .wrap.note .tip { display: block; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spin { animation: none; } .open:hover { transform: none; } }
    </style>
    <div class="wrap">
      <button class="open" type="button" aria-label="Open this job in NAO">
        <span class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>
          </svg>
        </span>
        <span class="label">Open in NAO</span>
        <span class="spin" aria-hidden="true"></span>
        <span class="dot"></span>
      </button>
      <div class="tip" role="status" aria-live="polite"></div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const wrap = $(".wrap");
  const button = $(".open");
  const label = $(".label");
  const dot = $(".dot");
  const tip = $(".tip");
  const DEFAULT_TIP =
    "<b>Open this job in NAO</b><br>Fill again, skip or report the posting, and see or download your tailored resume and cover letter.";

  let available = false;
  let enabled = true;
  let noteTimer = null;

  function paint(state, message) {
    button.dataset.state = state || "idle";
    label.textContent = state === "running" ? "Filling\u2026" : "Open in NAO";
    const tone = state === "done" ? "ok" : state === "needs" ? "warn" : state === "error" ? "danger" : "";
    dot.className = "dot" + (tone ? " " + tone : "");
    tip.innerHTML = DEFAULT_TIP;
    if (message) {
      const extra = document.createElement("div");
      extra.style.marginTop = "5px";
      extra.textContent = message;
      tip.appendChild(extra);
    }
  }

  function note(text) {
    clearTimeout(noteTimer);
    tip.textContent = text;
    wrap.classList.add("note");
    noteTimer = setTimeout(() => {
      wrap.classList.remove("note");
      tip.innerHTML = DEFAULT_TIP;
    }, NOTE_MS);
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

  button.addEventListener("click", async () => {
    // Sent straight from the click so the side panel may open (it needs the user's gesture).
    const res = await send({ type: "AA_FAB_EXPAND" });
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
        paint(m.state, m.state === "running" ? "" : m.message || "");
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
    paint(s.state || "idle", s.message || "");
    mount();
  });
})();
