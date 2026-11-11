// Learns where an Adzuna / Jobright job really applies, from the user's own click.
//
// Adzuna's job pages sit behind a bot wall, so NAO's server cannot follow their Apply
// link to the employer. The user's browser can: when the user is on a board job page
// (adzuna.com/details/<id>, adzuna.com/land/ad/<id>, jobright.ai/jobs/info/<id>) and
// clicks Apply, the tab (or the tab it opens) lands on the employer's application page.
// That landing page is reported once for the job (POST /jobs/apply-url/from-board), so
// every user's copy of the job opens and applies on the employer page from then on.
//
// Nothing is opened or clicked here. Only tabs that were on a board job page are
// watched, only for two minutes, and only link/redirect navigations count. Anything the
// user typed, a bookmark or a reload ends the watch.

const BOARD_JOB_PAGE = [
  /^https?:\/\/(?:[a-z0-9-]+\.)*adzuna\.[a-z.]+\/(?:details|land\/ad)\/\d{6,}(?:[/?#]|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*jobright\.ai\/jobs\/info\/[0-9a-f]{16,40}(?:[/?#]|$)/i,
];

// Job boards and aggregators: landing on one of these is not the employer's page.
const NOT_EMPLOYER_HOSTS = [
  /(?:^|\.)adzuna\.[a-z.]+$/,
  /(?:^|\.)jobright\.ai$/,
  /(?:^|\.)(?:linkedin|indeed|glassdoor|ziprecruiter|dice|simplyhired|monster|builtin|wellfound|careerbuilder|talent|welcometothejungle|otta|remoteok|weworkremotely)\.com$/,
  /(?:^|\.)remote\.co$/,
  /(?:^|\.)hiring\.cafe$/,
  /(?:^|\.)nao\.it\.com$/,
  /^(?:localhost|127\.0\.0\.1)$/,
  /(?:^|\.)google\.[a-z.]+$/,
];

// Navigations the user started themselves: the Apply hop is over.
const USER_TRANSITIONS = new Set(["typed", "auto_bookmark", "generated", "keyword", "keyword_generated", "reload", "start_page"]);

export const WATCH_MS = 120_000;
export const SETTLE_MS = 3_000;

export function isBoardJobPage(url) {
  return typeof url === "string" && BOARD_JOB_PAGE.some((re) => re.test(url));
}

// The hop that is Apply itself: Adzuna's Apply goes through /land/ad/<id>; any other
// link on an Adzuna page (an ad, a company site) is not the application. Jobright's
// Apply goes straight to the employer.
export function isApplyHop(boardUrl) {
  return /\/land\/ad\/\d/i.test(boardUrl) || /jobright\.ai\//i.test(boardUrl);
}

export function isEmployerPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  return !NOT_EMPLOYER_HOSTS.some((re) => re.test(host));
}

/**
 * @param {{ report: (boardUrl: string, url: string) => Promise<unknown>,
 *           now?: () => number, settleMs?: number, chromeApi?: typeof chrome }} deps
 */
export function attachBoardApplyWatch({ report, now = () => Date.now(), settleMs = SETTLE_MS, chromeApi = globalThis.chrome }) {
  const nav = chromeApi?.webNavigation;
  if (!nav?.onCommitted) return null;
  /** tabId -> { board, at } */
  const watched = new Map();
  const reported = new Set();

  const watch = (tabId, board) => watched.set(tabId, { board, at: now() });

  const settleThenReport = (tabId, entry) => {
    setTimeout(async () => {
      if (watched.get(tabId) !== entry) return;
      let url = entry.landing;
      try {
        const tab = await chromeApi.tabs.get(tabId);
        if (tab?.url) url = tab.url;
      } catch {
        // Tab closed: the landing seen at commit time is still the employer page.
      }
      if (watched.get(tabId) !== entry || !isEmployerPage(url)) return;
      watched.delete(tabId);
      const key = entry.board + " " + url;
      if (reported.has(key)) return;
      reported.add(key);
      try {
        await report(entry.board, url);
      } catch {
        // Signed out, offline or rejected by the server: nothing to do.
      }
    }, settleMs);
  };

  nav.onCommitted.addListener(({ tabId, frameId, url, transitionType, transitionQualifiers = [] }) => {
    if (frameId !== 0) return;
    if (isBoardJobPage(url)) {
      watch(tabId, url);
      return;
    }
    const entry = watched.get(tabId);
    if (!entry) return;
    const redirected = transitionQualifiers.includes("server_redirect") || transitionQualifiers.includes("client_redirect");
    if (now() - entry.at > WATCH_MS || (USER_TRANSITIONS.has(transitionType) && !redirected) || transitionQualifiers.includes("forward_back")) {
      watched.delete(tabId);
      return;
    }
    // Tracking hops (another board, a redirector) keep the watch; the employer page reports after it settles.
    if (!isEmployerPage(url)) return;
    if (!isApplyHop(entry.board)) {
      watched.delete(tabId);
      return;
    }
    const next = { ...entry, landing: url };
    watched.set(tabId, next);
    settleThenReport(tabId, next);
  });

  // Apply opened a new tab: watch it for the same job.
  nav.onCreatedNavigationTarget?.addListener(({ sourceTabId, tabId, url }) => {
    const entry = watched.get(sourceTabId);
    if (entry && now() - entry.at <= WATCH_MS) watch(tabId, entry.board);
    else if (isBoardJobPage(url)) watch(tabId, url);
  });

  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    const entry = watched.get(tabId);
    if (entry && !entry.landing) watched.delete(tabId);
  });

  return { watched };
}
