// MAIN-world React fill bridge.
//
// Chrome content scripts run in an ISOLATED world: they share the DOM tree with
// the page but NOT JavaScript expandos or the page's patched prototypes
// (https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).
// React's `_valueTracker` and `__reactProps$` live on the PAGE-world wrapper, so
// an isolated-world `_valueTracker` rewind is a no-op on Ashby's real tracker -
// DOM text can look filled while submit still says "Missing entry for required
// field: Name".
//
// This file is injected with world:"MAIN". The isolated autofill engine dispatches
// a bubbling CustomEvent("__af_page_set") on the control; we set the value through
// the page's native setter, rewind the page `_valueTracker`, fire input/change,
// and call React's onChange/onBlur from `__reactProps$` when present.
(() => {
  if (window.__AF_PAGE_BRIDGE__) return;
  window.__AF_PAGE_BRIDGE__ = true;

  function reactProps(el) {
    if (!el) return null;
    try {
      for (const k of Object.keys(el)) {
        if (k.startsWith("__reactProps$")) return el[k];
      }
    } catch {}
    return null;
  }

  function valueSetter(el) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    return desc && typeof desc.set === "function" ? desc.set : null;
  }

  function fakeEvent(el, type) {
    return {
      target: el,
      currentTarget: el,
      type,
      bubbles: true,
      cancelable: true,
      isTrusted: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      persist() {},
      nativeEvent: null,
    };
  }

  function callReactHandlers(el, types) {
    const props = reactProps(el);
    if (!props) return;
    for (const type of types) {
      const fn =
        type === "change"
          ? props.onChange
          : type === "input"
          ? props.onInput || props.onChange
          : type === "blur"
          ? props.onBlur
          : null;
      if (typeof fn !== "function") continue;
      try {
        fn(fakeEvent(el, type));
      } catch {}
    }
  }

  function setTextLike(el, value, { blur = true } = {}) {
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
    const v = value == null ? "" : String(value);
    const setter = valueSetter(el);
    const last = el.value;
    try {
      el.focus({ preventScroll: true });
    } catch {}
    if (setter) setter.call(el, v);
    else el.value = v;
    // Page-world tracker (invisible to isolated content scripts).
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") {
        tracker.setValue(last === v ? (v === "" ? "__af__" : "") : last);
      }
    } catch {}
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: v,
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    // Autocomplete filter typing must NOT blur, blur collapses Ashby's listbox
    // before we can click an option (probe: commit requires option click / Enter
    // while expanded).
    callReactHandlers(el, blur ? ["input", "change", "blur"] : ["input", "change"]);
    if (blur) {
      try {
        el.blur();
      } catch {}
      try {
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new FocusEvent("blur", { bubbles: false, cancelable: true }));
      } catch {}
    }
    return el.value === v || String(el.value) === v;
  }

  // Ashby autocomplete options: console probe proved mousedown+mouseup+click in
  // the PAGE world commits (ApiSetFormValue) and sets aria-expanded=false.
  // Isolated-world clicks are unreliable against Ashby's React handlers.
  function clickLike(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      el.scrollIntoView && el.scrollIntoView({ block: "nearest" });
    } catch {}
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0 }));
    } catch {}
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, button: 0 }));
    } catch {}
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    try {
      el.click();
    } catch {}
    const props = reactProps(el);
    if (props && typeof props.onClick === "function") {
      try {
        props.onClick(fakeEvent(el, "click"));
      } catch {}
    }
    return true;
  }

  function setSelect(el, value) {
    if (!el || el.tagName !== "SELECT") return false;
    const want = value == null ? "" : String(value);
    const setter = valueSetter(el);
    const last = el.value;
    let matched = null;
    for (const o of el.options) {
      if (String(o.value) === want || String(o.text).trim() === want.trim()) {
        matched = o;
        break;
      }
    }
    if (!matched && want) {
      const low = want.trim().toLowerCase();
      for (const o of el.options) {
        if (String(o.text).trim().toLowerCase().includes(low)) {
          matched = o;
          break;
        }
      }
    }
    if (!matched) return false;
    try {
      el.focus({ preventScroll: true });
    } catch {}
    if (setter) setter.call(el, matched.value);
    else el.value = matched.value;
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue(last);
    } catch {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    callReactHandlers(el, ["change", "blur"]);
    try {
      el.blur();
    } catch {}
    try {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    } catch {}
    return el.value === matched.value;
  }

  document.addEventListener(
    "__af_page_set",
    (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1 || !e.detail) return;
      const kind = e.detail.kind || "text";
      let ok = false;
      try {
        if (kind === "select") ok = setSelect(el, e.detail.value);
        else if (kind === "type") ok = setTextLike(el, e.detail.value, { blur: false });
        else ok = setTextLike(el, e.detail.value, { blur: true });
      } catch {
        ok = false;
      }
      try {
        el.setAttribute("data-af-page-set", ok ? "ok" : "fail");
      } catch {}
    },
    true
  );

  // BambooHR Fabric selects keep their items and onChange on the React fiber,
  // which only this world can read. The isolated driver sets data-af-fab-op
  // ("items" | "commit", with data-af-fab-index) on the toggle and fires
  // "__af_fab"; the answer goes back in data-af-fab-items / data-af-fab-result.
  function fabricProps(el) {
    let f = null;
    try {
      const k = Object.keys(el).find((x) => x.startsWith("__reactFiber") || x.startsWith("__reactInternalInstance"));
      f = k ? el[k] : null;
    } catch {}
    for (let i = 0; f && i < 24; i++) {
      const p = f.memoizedProps || {};
      if (Array.isArray(p.items) && p.items.length) return p;
      f = f.return;
    }
    return null;
  }

  function fabCommit(p, item) {
    for (const fn of [p.onChange, p.onSelect]) {
      if (typeof fn !== "function") continue;
      try {
        fn(item);
        return true;
      } catch {}
    }
    if (typeof p.onChange === "function") {
      try {
        p.onChange([item]);
        return true;
      } catch {}
    }
    return false;
  }

  document.addEventListener(
    "__af_fab",
    (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      const op = el.getAttribute("data-af-fab-op");
      const p = fabricProps(el);
      try {
        if (op === "items") {
          const items = p
            ? p.items.map((it) => (typeof it === "string" ? { text: it } : { text: String(it.text || it.label || it.name || ""), abbr: it.abbr ? String(it.abbr) : "" }))
            : [];
          const selected = p && Array.isArray(p.selectedValues) ? p.selectedValues.length : 0;
          el.setAttribute("data-af-fab-items", JSON.stringify({ items, selected, multi: !!(p && p.canSelectMultiple), required: !!(p && (p.required || p.isRequired)) }));
        } else if (op === "commit") {
          const idx = Number(el.getAttribute("data-af-fab-index"));
          const item = p && p.items[idx];
          el.setAttribute("data-af-fab-result", item && fabCommit(p, item) ? "ok" : "fail");
        }
      } catch {
        el.setAttribute("data-af-fab-result", "fail");
      }
    },
    true
  );

  // Workable blocks submit ("You have unsaved changes") while its unsaved-changes context reports
  // any Education / Experience group. Only this world can read that React context: answer with
  // getGroupsWithUnsavedChanges() in data-af-wb-unsaved on the form ("{}" when clean).
  function workableUnsavedGroups(form) {
    let f = null;
    try {
      const k = Object.keys(form).find((x) => x.startsWith("__reactFiber"));
      f = k ? form[k] : null;
    } catch {}
    for (let i = 0; f && i < 200; i++) {
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && typeof v.getGroupsWithUnsavedChanges === "function") return v.getGroupsWithUnsavedChanges() || {};
      f = f.return;
    }
    return null;
  }

  document.addEventListener(
    "__af_wb_unsaved",
    (e) => {
      const form = e.target;
      if (!form || form.nodeType !== 1) return;
      let out = "unknown";
      try {
        const groups = workableUnsavedGroups(form);
        if (groups) out = JSON.stringify(groups);
      } catch {}
      try {
        form.setAttribute("data-af-wb-unsaved", out);
      } catch {}
    },
    true
  );

  document.addEventListener(
    "__af_page_click",
    (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      let ok = false;
      try {
        ok = clickLike(el);
      } catch {
        ok = false;
      }
      try {
        el.setAttribute("data-af-page-click", ok ? "ok" : "fail");
      } catch {}
    },
    true
  );
})();
