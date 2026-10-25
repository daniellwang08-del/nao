// BambooHR (and other Fabric) Select driver.
//
// Live DOM on fenix24.bamboohr.com/careers/171:
//   <div class="fab-SelectToggle__container">
//     <button class="fab-SelectToggle" aria-haspopup="true"
//             aria-label="State –Select–">
//       <div class="fab-SelectToggle__placeholder">–Select–</div>
//     </button>
//   </div>
//   <select class="chzn-ignore" aria-hidden="true" style="width:0;height:0">
//     <option value=""></option>
//   </select>
//
// The visible control is a button, not a combobox or a rendered <select>, so
// neither native-select nor react-select ever claims it. The hidden <select>
// ships an empty placeholder and is 0x0, so the engine skips it as unrendered.
// Options live only on the React fiber (`items: [{text,value,id,abbr}]`).
// Synthetic clicks do not open the menu. The form commits when the Select's
// onChange (or inner onSelect) is called with the item object. Verified:
// onChange({text:"Washington", value:"48"}) writes the hidden select and the
// toggle label becomes "State Washington".
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, textsMatch, labelForControl } = AF.dom;

  function isFabToggle(el) {
    if (!el || el.tagName !== "BUTTON") return false;
    const cls = String(el.className || "");
    return /\bfab-SelectToggle\b/.test(cls);
  }

  function toggleOf(el) {
    if (!el) return null;
    if (isFabToggle(el)) return el;
    const wrap =
      (el.closest &&
        (el.closest(".fab-SelectToggle__container") || el.closest("[data-fabric-component]"))) ||
      el.parentElement;
    return (wrap && wrap.querySelector && wrap.querySelector("button.fab-SelectToggle")) || null;
  }

  function hiddenSelectOf(toggle) {
    if (!toggle) return null;
    const wrap =
      (toggle.closest &&
        (toggle.closest(".fab-FormField") ||
          toggle.closest("[data-fabric-component]") ||
          toggle.closest(".fab-SelectToggle__container") ||
          toggle.parentElement)) ||
      toggle.parentElement;
    let scope = wrap;
    for (let i = 0; scope && i < 5; i++) {
      const sel = scope.querySelector && scope.querySelector("select.chzn-ignore, select[aria-hidden='true']");
      if (sel) return sel;
      scope = scope.parentElement;
    }
    return null;
  }

  function fiberOf(el) {
    if (!el) return null;
    const k = Object.keys(el).find((x) => x.startsWith("__reactFiber") || x.startsWith("__reactInternalInstance"));
    return k ? el[k] : null;
  }

  function fabricProps(toggle) {
    let f = fiberOf(toggle);
    for (let i = 0; f && i < 24; i++) {
      const p = f.memoizedProps || {};
      if (Array.isArray(p.items) && p.items.length) return p;
      f = f.return;
    }
    return null;
  }

  function itemText(it) {
    if (!it) return "";
    if (typeof it === "string") return clean(it);
    return clean(it.text || it.label || it.name || it.abbr || "");
  }

  function itemList(toggle) {
    const p = fabricProps(toggle);
    return ((p && p.items) || []).map(itemText).filter(Boolean);
  }

  function pickItem(items, want) {
    const w = normText(want);
    if (!w || !items || !items.length) return null;
    const scored = items
      .map((it) => ({ it, t: normText(itemText(it)) }))
      .filter((x) => x.t);
    const exact = scored.find((x) => x.t === w);
    if (exact) return exact.it;
    const word = scored.find((x) => textsMatch(x.t, w));
    if (word) return word.it;
    const abbr = scored.find((x) => x.it && normText(x.it.abbr) === w);
    return abbr ? abbr.it : null;
  }

  function toggleValue(toggle) {
    if (!toggle) return "";
    const content = toggle.querySelector && toggle.querySelector(".fab-SelectToggle__content");
    if (content && clean(content.textContent)) return clean(content.textContent);
    const ph = toggle.querySelector && toggle.querySelector(".fab-SelectToggle__placeholder");
    const t = clean(toggle.innerText || toggle.textContent);
    if (ph && clean(ph.textContent) && normText(t) === normText(ph.textContent)) return "";
    if (/^(select|choose|–select–|-select-|\u2013select\u2013)\b/i.test(t)) return "";
    return t;
  }

  function commitItem(toggle, item) {
    let f = fiberOf(toggle);
    let lastErr = null;
    for (let i = 0; f && i < 24; i++) {
      const p = f.memoizedProps || {};
      if (Array.isArray(p.items) && p.items.length) {
        if (typeof p.onChange === "function") {
          try {
            p.onChange(item);
            return true;
          } catch (e) {
            lastErr = e;
          }
          try {
            p.onChange([item]);
            return true;
          } catch (e) {
            lastErr = e;
          }
        }
        if (typeof p.onSelect === "function") {
          try {
            p.onSelect(item);
            return true;
          } catch (e) {
            lastErr = e;
          }
        }
      }
      f = f.return;
    }
    if (lastErr) {
      try {
        console.warn("[autofill] fab-select commit failed", lastErr);
      } catch {}
    }
    return false;
  }

  function fieldLabel(toggle) {
    const sel = hiddenSelectOf(toggle);
    const fromSel = sel && labelForControl(sel);
    if (fromSel && !/^(select|choose)\b/i.test(fromSel)) return fromSel;
    const aria = clean(toggle.getAttribute && toggle.getAttribute("aria-label"));
    if (aria) {
      return aria
        .replace(/\s*[–\u2013\u2014-]\s*select\s*[–\u2013\u2014-]?\s*$/i, "")
        .replace(/\s+united states$/i, "")
        .trim() || aria;
    }
    return labelForControl(toggle);
  }

  AF.registerDriver({
    type: "fab-select",
    priority: 18,
    match(el) {
      if (isFabToggle(el)) return el;
      if (el.tagName === "SELECT" && /chzn-ignore/.test(String(el.className || ""))) {
        return toggleOf(el);
      }
      return null;
    },
    cidEl(root) {
      return hiddenSelectOf(root) || root;
    },
    consumes(root) {
      const extra = [];
      const sel = hiddenSelectOf(root);
      if (sel) extra.push(sel);
      return extra;
    },
    extract(root) {
      const sel = hiddenSelectOf(root);
      const p = fabricProps(root);
      return {
        kind: "custom",
        label: fieldLabel(root),
        required:
          !!(sel && sel.required) ||
          !!(p && (p.required || p.isRequired)) ||
          (root.getAttribute && /required/i.test(root.getAttribute("aria-label") || "")),
        multi: !!(p && p.canSelectMultiple),
        options: itemList(root),
      };
    },
    harvestOptions(root) {
      return itemList(root);
    },
    isFilled(root) {
      const sel = hiddenSelectOf(root);
      if (sel && clean(sel.value)) return true;
      const p = fabricProps(root);
      if (p && Array.isArray(p.selectedItems) && p.selectedItems.length) return true;
      if (p && Array.isArray(p.selectedValues) && p.selectedValues.length) return true;
      return !!toggleValue(root);
    },
    async write(root, answer) {
      const want = answer.option || answer.value || "";
      if (!want) return false;
      const p = fabricProps(root);
      const items = (p && p.items) || [];
      const item = pickItem(items, want);
      if (!item) return false;
      if (normText(toggleValue(root)) && textsMatch(toggleValue(root), itemText(item))) return true;
      return commitItem(root, item);
    },
  });
})();
