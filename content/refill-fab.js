// Corner "Fill again" button on tabs auto-apply left for the user. Auto-apply
// fills in its own window, where the side panel is not open, so this is the
// way to rerun the fill on the page without finding the job in the console.
//
// Top frame only. A closed shadow root keeps the page's CSS out, and keeps the
// button out of the engine's field scan and auto-apply's submit search.

(function () {
  if (window.top !== window || window.__NAO_REFILL_FAB__) return;
  window.__NAO_REFILL_FAB__ = true;

  const RESULT_SHOW_MS = 10_000;

  const host = document.createElement("div");
  host.setAttribute("data-nao-refill", "");
  host.style.cssText = "all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .wrap { display: flex; align-items: flex-end; gap: 10px; flex-direction: row-reverse; }
      .main {
        position: relative; width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer;
        background: oklch(0.68 0.17 260); color: #fff; display: grid; place-items: center;
        box-shadow: 0 6px 18px rgb(0 0 0 / 28%), 0 0 0 1px rgb(255 255 255 / 12%) inset;
        transition: transform 120ms ease, background 120ms ease;
      }
      .main:hover { background: oklch(0.73 0.16 260); transform: translateY(-1px); }
      .main:focus-visible { outline: 3px solid oklch(0.68 0.17 260 / 55%); outline-offset: 2px; }
      .main[aria-busy="true"] { cursor: progress; }
      .main svg { width: 20px; height: 20px; }
      .main[aria-busy="true"] svg { animation: spin 900ms linear infinite; }
      .dot {
        position: absolute; top: 1px; right: 1px; width: 11px; height: 11px; border-radius: 50%;
        border: 2px solid #fff; display: none;
      }
      .dot.warn { display: block; background: oklch(0.8 0.14 80); }
      .dot.ok { display: block; background: oklch(0.72 0.15 155); }
      .dot.danger { display: block; background: oklch(0.7 0.18 25); }
      .card {
        width: 280px; padding: 10px 12px; border-radius: 12px; display: none;
        background: oklch(0.185 0.024 267); color: oklch(0.95 0.008 260);
        border: 1px solid oklch(0.85 0.06 262 / 18%); box-shadow: 0 10px 30px rgb(0 0 0 / 35%);
        font-size: 12.5px; line-height: 1.45;
      }
      .wrap.open .card, .wrap:hover .card, .wrap:focus-within .card { display: block; }
      .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
      .title { font-weight: 600; font-size: 12px; letter-spacing: 0.01em; }
      .title.warn { color: oklch(0.8 0.14 80); }
      .title.ok { color: oklch(0.72 0.15 155); }
      .title.danger { color: oklch(0.7 0.18 25); }
      .msg { color: oklch(0.71 0.03 262); word-break: break-word; max-height: 120px; overflow: auto; }
      .hint { margin-top: 6px; color: oklch(0.6 0.03 262); font-size: 11.5px; }
      .close {
        border: 0; background: transparent; color: oklch(0.71 0.03 262); cursor: pointer; padding: 2px 4px;
        border-radius: 6px; font-size: 14px; line-height: 1;
      }
      .close:hover { background: oklch(0.225 0.026 267); color: oklch(0.95 0.008 260); }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .main[aria-busy="true"] svg { animation: none; } }
    </style>
    <div class="wrap">
      <button class="main" type="button" aria-label="Fill this application again with NAO">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
        </svg>
        <span class="dot"></span>
      </button>
      <div class="card" role="status" aria-live="polite">
        <div class="head">
          <span class="title">NAO auto-apply</span>
          <button class="close" type="button" aria-label="Hide this button on this page" title="Hide on this page">\u00d7</button>
        </div>
        <div class="msg"></div>
        <div class="hint"></div>
      </div>
    </div>`;

  const wrap = root.querySelector(".wrap");
  const main = root.querySelector(".main");
  const dot = root.querySelector(".dot");
  const title = root.querySelector(".title");
  const msg = root.querySelector(".msg");
  const hint = root.querySelector(".hint");
  let state = "idle";
  let collapseTimer = null;

  const TITLES = {
    idle: ["NAO auto-apply", ""],
    running: ["Filling\u2026", ""],
    done: ["Done", "ok"],
    needs: ["Needs you", "warn"],
    error: ["Could not fill", "danger"],
  };

  function render(next, text, { status = "", open = false } = {}) {
    state = next;
    const [label, tone] = TITLES[next] || TITLES.idle;
    title.textContent = label;
    title.className = "title" + (tone ? " " + tone : "");
    msg.textContent = text || (next === "idle" ? "Auto-apply left this application for you." : "");
    msg.style.display = msg.textContent ? "" : "none";
    const busy = next === "running";
    main.setAttribute("aria-busy", busy ? "true" : "false");
    main.title = busy ? "NAO is filling this application" : "Fill again with NAO";
    hint.textContent = busy ? "Keep this tab open until it finishes." : "Click the button to fill the empty fields again. NAO never submits from here.";
    const dotTone = busy ? "" : next === "done" ? "ok" : next === "error" ? "danger" : next === "needs" || /needs_you|failed/.test(status) ? "warn" : "";
    dot.className = "dot" + (dotTone ? " " + dotTone : "");
    clearTimeout(collapseTimer);
    wrap.classList.toggle("open", busy || open);
    if (open && !busy) collapseTimer = setTimeout(() => wrap.classList.remove("open"), RESULT_SHOW_MS);
  }

  function remove() {
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

  main.addEventListener("click", async () => {
    if (state === "running") return;
    render("running", "Starting\u2026");
    const res = await send({ type: "AA_REFILL" });
    if (!res) return render("error", "NAO is not reachable. Reload this page and try again.", { open: true });
    if (!res.ok) return render("error", res.error || "Could not start filling.", { open: true });
    if (res.opening) render("running", "Opening auto-apply\u2026");
  });

  root.querySelector(".close").addEventListener("click", (e) => {
    e.stopPropagation();
    remove();
  });

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || typeof m.type !== "string") return;
      if (m.type === "AA_FAB_HIDE") remove();
      else if (m.type === "AA_FAB_STATUS") render(m.state || "idle", m.message || "", { open: m.state !== "running" });
    });
  } catch {
    return;
  }

  send({ type: "AA_FAB_STATE" }).then((s) => {
    if (!s || !s.show) {
      window.__NAO_REFILL_FAB__ = false;
      return;
    }
    render(s.state || "idle", s.message || "", { status: s.status || "" });
    (document.body || document.documentElement).appendChild(host);
  });
})();
