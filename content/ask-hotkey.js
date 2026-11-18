// Captures the user's Ask-selection hotkey on application pages (all frames).
// On match, sends the current text selection to the extension assistant chat.

(function () {
  // Injected again after an extension update (the old copy's chrome.runtime is gone): the newest copy owns the key.
  // An "already installed" flag would leave the page with only the dead listener.
  const token = `${Date.now()}-${Math.random()}`;
  window.__NAO_ASK_HOTKEY__ = token;
  const current = () => window.__NAO_ASK_HOTKEY__ === token;
  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  const DEFAULT = { ctrl: false, alt: true, shift: false, meta: false, key: "a" };

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULT };
    const key = String(raw.key || "")
      .trim()
      .toLowerCase();
    if (!key) return { ...DEFAULT };
    const ctrl = !!raw.ctrl;
    const alt = !!raw.alt;
    const shift = !!raw.shift;
    const meta = !!raw.meta;
    if (!ctrl && !alt && !meta) return { ...DEFAULT };
    return { ctrl, alt, shift, meta, key };
  }

  let combo = { ...DEFAULT };

  function loadCombo() {
    try {
      chrome.storage.local.get("askHotkey", (obj) => {
        void chrome.runtime.lastError;
        combo = normalize(obj && obj.askHotkey);
      });
    } catch {
      /* ignore */
    }
  }

  loadCombo();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.askHotkey) {
        combo = normalize(changes.askHotkey.newValue);
      }
    });
  } catch {
    /* ignore */
  }

  function matches(e) {
    if (!combo || !combo.key) return false;
    if (!!e.ctrlKey !== !!combo.ctrl) return false;
    if (!!e.altKey !== !!combo.alt) return false;
    if (!!e.shiftKey !== !!combo.shift) return false;
    if (!!e.metaKey !== !!combo.meta) return false;
    const pressed = e.key === " " ? "space" : String(e.key || "").toLowerCase();
    if (pressed === combo.key) return true;
    // Option/Alt changes the character on a Mac (Option+A types "å"): compare the physical key too.
    const code = String(e.code || "");
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase() === combo.key;
    if (/^Digit[0-9]$/.test(code)) return code.slice(5) === combo.key;
    return false;
  }

  function selectedText() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).trim()) return String(sel).trim();
    } catch {
      /* ignore */
    }
    // Fallback: selected text inside focused input/textarea (also inside shadow roots).
    try {
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (
        el &&
        (el.tagName === "TEXTAREA" ||
          (el.tagName === "INPUT" &&
            /^(text|search|url|tel|password|email|number)$/i.test(el.type || "text")))
      ) {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        if (typeof start === "number" && typeof end === "number" && end > start) {
          return String(el.value || "").slice(start, end).trim();
        }
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (!current() || !alive()) return;
      if (e.repeat || e.isComposing) return;
      if (!matches(e)) return;
      const text = selectedText();
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage(
          { type: "ASK_SELECTION", text, empty: !text, frameUrl: location.href },
          () => void chrome.runtime.lastError,
        );
      } catch {
        /* extension context invalidated */
      }
    },
    true
  );
})();
