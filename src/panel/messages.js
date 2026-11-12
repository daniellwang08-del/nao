// Messages from content scripts and the background worker.

import { handleApplicationSubmitted, handleAskSelection, onWebappOpenJob, pageJobAction } from "./actions/job.js";
import { reloadSession } from "./actions/session.js";
import { handleAutofillMessage } from "./autofill/index.js";
import { setState } from "./state.js";

export function installMessageRouter() {
  // Hidden from a page's corner buttons: keep the Settings toggle in step.
  chrome.storage.local.onChanged.addListener((changes) => {
    if (changes.aaPageButtons) setState({ aaPageButtons: changes.aaPageButtons.newValue !== false });
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "PAGE_JOB_ACTION") {
      pageJobAction(msg)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;
    }
    switch (msg.type) {
      case "ASK_SELECTION":
        void handleAskSelection(msg);
        return;
      case "APP_SUBMITTED":
        // Raw page report; the background resolves its job and re-sends it.
        return;
      case "APP_SUBMITTED_RESOLVED":
        void handleApplicationSubmitted(msg);
        return;
      case "SESSION_CHANGED":
        void reloadSession();
        return;
      case "WEBAPP_OPEN_PENDING_JOB":
        if (msg.jobId) onWebappOpenJob(msg.jobId);
        return;
      default:
        handleAutofillMessage(msg, sender);
    }
  });
}
