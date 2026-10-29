// Keep a background application tab working without bringing it to the front.
//
// Auto-apply fills jobs in background tabs while the user keeps working in
// another one, so it must never activate a tab or focus a window. Hidden tabs
// run no requestAnimationFrame callbacks, and pages that mount their form on
// one (Workable) never draw it. This shim, run in the page's own world, falls
// back to a timer for those callbacks while the tab is hidden and leaves the
// native ones alone once it is visible.

function installShim() {
  if (window.__naoWake) return;
  window.__naoWake = true;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    document.visibilityState === "hidden" ? -window.setTimeout(() => cb(performance.now()), 16) : nativeRaf(cb);
  window.cancelAnimationFrame = (id) => (id < 0 ? window.clearTimeout(-id) : nativeCancel(id));
}

async function inject(target) {
  try {
    await chrome.scripting.executeScript({ target, world: "MAIN", injectImmediately: true, func: installShim });
  } catch {
    /* frame without host access, or already gone */
  }
}

/** Install the shim in every frame of the tab now. Never changes tab or window focus. */
export async function wakeTab(tabId) {
  if (tabId == null) return;
  await inject({ tabId, allFrames: true });
}

/** Install the shim as each new document in the tab commits, before its scripts cache rAF. */
export function keepAwake(tabId) {
  const onCommitted = (d) => {
    if (d.tabId === tabId) void inject({ tabId, frameIds: [d.frameId] });
  };
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  return () => chrome.webNavigation.onCommitted.removeListener(onCommitted);
}

export { installShim };
