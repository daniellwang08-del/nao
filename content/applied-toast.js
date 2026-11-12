// "You applied" notifications, bottom-right: one short card per application NAO records as applied
// ("Software Engineer at Acme · 12 applied today"). Each fades out after 3 seconds; a new card appears at the
// bottom and the earlier ones move up. Runs in the tab the user is looking at (injected by the background) and in
// the auto-apply console page. A closed shadow root keeps the page's CSS out and the cards out of form scans.
//
// Message: { type: "NAO_APPLIED_TOAST", title, company, today, count }

(function () {
  if (window.__NAO_APPLIED_TOAST__) return;
  window.__NAO_APPLIED_TOAST__ = true;

  const SHOW_MS = 3000; // visible time, fade included
  const FADE_MS = 260;
  const MAX_CARDS = 4;

  let host = null;
  let stack = null;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.setAttribute("data-nao-toasts", "");
    host.style.cssText = "all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; pointer-events: none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .stack { display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-end; gap: 8px; }
        .card {
          pointer-events: auto; width: 320px; max-width: calc(100vw - 32px);
          display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: start;
          padding: 11px 13px 11px 11px; border-radius: 12px;
          background: oklch(0.185 0.024 267 / 96%); color: oklch(0.96 0.008 260);
          border: 1px solid oklch(0.85 0.06 262 / 18%);
          box-shadow: 0 12px 32px rgb(0 0 0 / 32%), 0 2px 6px rgb(0 0 0 / 20%);
          opacity: 0; transform: translateY(10px) scale(0.98);
          transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease, margin ${FADE_MS}ms ease;
        }
        .card.in { opacity: 1; transform: none; }
        .card.out { opacity: 0; transform: translateY(-6px) scale(0.98); }
        .badge {
          width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
          background: oklch(0.72 0.15 155 / 18%); color: oklch(0.8 0.15 155);
        }
        .badge svg { width: 16px; height: 16px; }
        .head { font-size: 12px; font-weight: 600; color: oklch(0.8 0.15 155); letter-spacing: 0.02em; margin-bottom: 2px; }
        .job { font-size: 13px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .job .at { font-weight: 400; color: oklch(0.8 0.025 262); }
        .today { margin-top: 6px; display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: oklch(0.78 0.03 262); }
        .today b { color: oklch(0.96 0.008 260); font-weight: 650; font-variant-numeric: tabular-nums; }
        .bar { grid-column: 1 / -1; height: 2px; border-radius: 2px; margin-top: 2px; background: oklch(0.85 0.06 262 / 14%); overflow: hidden; }
        .bar i { display: block; height: 100%; width: 100%; background: oklch(0.72 0.15 155); transform-origin: left;
          animation: drain ${SHOW_MS - FADE_MS}ms linear forwards; }
        @keyframes drain { to { transform: scaleX(0); } }
        @media (prefers-reduced-motion: reduce) {
          .card { transition: opacity ${FADE_MS}ms ease; transform: none; }
          .card.out { transform: none; }
          .bar i { animation: none; }
        }
      </style>
      <div class="stack" role="status" aria-live="polite"></div>`;
    stack = root.querySelector(".stack");
    (document.body || document.documentElement).appendChild(host);
  }

  const CHECKS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 12.5l4.5 4.5L15 8.5"/><path d="M9.5 16.5l.5.5L22 6"/></svg>';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function dismiss(card) {
    if (!card || card.dataset.leaving) return;
    card.dataset.leaving = "1";
    card.classList.remove("in");
    card.classList.add("out");
    setTimeout(() => {
      card.remove();
      if (stack && !stack.children.length && host) {
        host.remove();
        host = null;
        stack = null;
      }
    }, FADE_MS);
  }

  function show({ title, company, today, count } = {}) {
    ensureHost();
    const card = el("div", "card");
    const badge = el("div", "badge");
    badge.innerHTML = CHECKS;
    const body = el("div");
    const many = Number(count) > 1;
    body.appendChild(el("div", "head", many ? `Applied to ${count} jobs` : "Applied"));
    if (!many) {
      const job = el("div", "job");
      job.appendChild(document.createTextNode(String(title || "Job application").trim()));
      if (company) {
        const at = el("span", "at");
        at.textContent = ` at ${String(company).trim()}`;
        job.appendChild(at);
      }
      body.appendChild(job);
    }
    if (Number.isFinite(Number(today)) && today !== null && today !== "") {
      const t = el("div", "today");
      t.append("Applied today: ");
      t.appendChild(el("b", "", Number(today).toLocaleString()));
      body.appendChild(t);
    }
    const bar = el("div", "bar");
    bar.appendChild(el("i"));
    card.append(badge, body, bar);
    stack.appendChild(card); // newest at the bottom; earlier cards move up
    const live = [...stack.children].filter((c) => !c.dataset.leaving);
    for (const old of live.slice(0, Math.max(0, live.length - MAX_CARDS))) dismiss(old);
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("in")));
    setTimeout(() => dismiss(card), SHOW_MS - FADE_MS);
  }

  window.__NAO_SHOW_APPLIED_TOAST__ = show;

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.type === "NAO_APPLIED_TOAST") show(m);
    });
  } catch {
    /* extension reloaded: this page's script is orphaned */
  }
})();
