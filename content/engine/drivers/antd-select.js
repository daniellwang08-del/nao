// Ant Design <Select> (rc-select), as on Dayforce (jobs.dayforcehcm.com).
//
// The list is virtual: only ~30 options are in the DOM at a time (Dayforce's Country select lists ~250, so
// "United States of America" is never rendered when the menu opens), and the menu lives in a portal reached
// through the combobox's aria-controls. So options are read by scrolling the list, and a value is chosen by
// typing it into the select's search box (Ant filters as you type) and clicking the best match.
// Lists longer than the backend's option cap are offered as free text and matched by search when written.
(() => {
  const AF = window.__AF;
  if (!AF || !AF.dom) return;
  const { clean, normText, isVisible, delay, waitUntil, setNativeValue } = AF.dom;

  const MAX_OPTIONS = 120; // backend MAX_OPTIONS_PER_CONTROL

  const applies = () => !!(AF.dayforce && AF.dayforce.isDayforcePage && AF.dayforce.isDayforcePage());

  function comboInput(root) {
    return root && root.querySelector ? root.querySelector("input.ant-select-selection-search-input, input[role=combobox]") : null;
  }

  function selectionText(root) {
    const item = root && root.querySelector(".ant-select-selection-item");
    return clean((item && (item.getAttribute("title") || item.innerText || item.textContent)) || "");
  }

  function dropdownOf(root) {
    const input = comboInput(root);
    const id = input && input.getAttribute("aria-controls");
    const list = id && document.getElementById(id);
    return (list && list.closest(".ant-select-dropdown")) || null;
  }

  function isOpen(root) {
    const dd = dropdownOf(root);
    return !!(dd && !dd.classList.contains("ant-select-dropdown-hidden") && isVisible(dd));
  }

  function mouse(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  async function open(root) {
    if (isOpen(root)) return true;
    const sel = root.querySelector(".ant-select-selector") || root;
    mouse(sel, "mousedown");
    mouse(sel, "mouseup");
    sel.click && sel.click();
    const input = comboInput(root);
    try {
      input && input.focus();
    } catch {}
    return !!(await waitUntil(() => isOpen(root), 2500, 60));
  }

  async function close(root) {
    const input = comboInput(root);
    if (input && isOpen(root)) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      await waitUntil(() => !isOpen(root), 800, 60);
    }
    try {
      input && input.blur();
    } catch {}
  }

  const optionText = (o) => clean(o.getAttribute("title") || o.innerText || o.textContent || "");

  function renderedOptions(root) {
    const dd = dropdownOf(root);
    return dd ? [...dd.querySelectorAll(".ant-select-item-option")].filter((o) => !o.classList.contains("ant-select-item-option-disabled")) : [];
  }

  // Every option, scrolling the virtual list from top to bottom.
  async function readAll(root) {
    const dd = dropdownOf(root);
    const holder = dd && dd.querySelector(".rc-virtual-list-holder");
    const seen = new Set();
    const out = [];
    const collect = () => {
      for (const o of renderedOptions(root)) {
        const t = optionText(o);
        if (t && !seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      }
    };
    collect();
    if (holder) {
      holder.scrollTop = 0;
      await delay(40);
      for (let i = 0; i < 80; i++) {
        collect();
        const before = holder.scrollTop;
        holder.scrollTop = before + Math.max(holder.clientHeight - 32, 64);
        holder.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(40);
        if (holder.scrollTop === before) break;
      }
      collect();
      holder.scrollTop = 0;
    }
    return out;
  }

  // Comparable option text: no flag emoji or "+1" dialing prefix ("🇺🇸 +1 United States" -> "united states").
  function core(s) {
    return normText(String(s || ""))
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
      .replace(/^\s*\+\d{1,4}\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  const ALIASES = {
    usa: "united states",
    us: "united states",
    "u.s.": "united states",
    "u.s.a.": "united states",
    "united states of america": "united states",
    america: "united states",
    uk: "united kingdom",
    "great britain": "united kingdom",
  };

  // Best option for `want`: exact > same after aliases > option starts with it (shortest) > contains (shortest).
  function bestOption(options, want) {
    const w = core(want);
    if (!w) return null;
    const wa = ALIASES[w] || w;
    const scored = [];
    for (const o of options) {
      const t = core(optionText(o));
      if (!t) continue;
      const ta = ALIASES[t] || t;
      let score = 0;
      if (t === w) score = 100;
      else if (ta === wa) score = 90;
      else if (t.startsWith(w + " ") || t.startsWith(wa + " ")) score = 70;
      else if (w.startsWith(t + " ")) score = 60;
      else if (t.includes(w) || t.includes(wa)) score = 50;
      else if (w.includes(t) && t.length > 3) score = 40;
      if (score) scored.push({ o, score, len: t.length });
    }
    scored.sort((a, b) => b.score - a.score || a.len - b.len);
    return scored.length ? scored[0].o : null;
  }

  function typeSearch(root, text) {
    const input = comboInput(root);
    if (!input) return false;
    try {
      input.focus();
    } catch {}
    setNativeValue(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return true;
  }

  // Search words for `want`: the full value, then its first words (a long LLM answer may not filter to anything).
  function searchTerms(want) {
    const w = clean(String(want || "").replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").replace(/^\s*\+\d{1,4}\s*/, ""));
    const alias = ALIASES[w.toLowerCase()];
    const words = w.split(/\s+/);
    return [...new Set([w, alias && alias.replace(/\b\w/g, (c) => c.toUpperCase()), words.slice(0, 2).join(" "), words[0]].filter(Boolean))];
  }

  async function clickOption(root, opt) {
    try {
      opt.scrollIntoView({ block: "nearest" });
    } catch {}
    mouse(opt, "mousemove");
    mouse(opt, "mousedown");
    mouse(opt, "mouseup");
    opt.click();
    return !!(await waitUntil(() => selectionText(root), 1500, 60));
  }

  // Choose `want` in an Ant select. Returns true when the select shows a matching selection.
  async function pick(root, want) {
    if (!root || !want) return false;
    if (root.classList.contains("ant-select-disabled")) {
      // State/Province enables once Country is chosen.
      await waitUntil(() => !root.classList.contains("ant-select-disabled"), 3000, 100);
      if (root.classList.contains("ant-select-disabled")) return false;
    }
    const current = selectionText(root);
    if (current && bestOption([{ getAttribute: () => current, innerText: current }], want)) return true;
    if (!(await open(root))) return false;
    let opt = bestOption(renderedOptions(root), want);
    const searchable = root.classList.contains("ant-select-show-search");
    if (!opt && searchable) {
      for (const term of searchTerms(want)) {
        typeSearch(root, term);
        await delay(250);
        opt = bestOption(renderedOptions(root), want);
        if (opt) break;
      }
    }
    if (!opt) {
      // Not searchable (or the search found nothing): scroll the whole list.
      if (searchable) typeSearch(root, "");
      await delay(150);
      const dd = dropdownOf(root);
      const holder = dd && dd.querySelector(".rc-virtual-list-holder");
      for (let i = 0; holder && i < 80 && !opt; i++) {
        opt = bestOption(renderedOptions(root), want);
        if (opt) break;
        const before = holder.scrollTop;
        holder.scrollTop = before + Math.max(holder.clientHeight - 32, 64);
        holder.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(40);
        if (holder.scrollTop === before) break;
      }
    }
    if (!opt) {
      await close(root);
      return false;
    }
    const ok = await clickOption(root, opt);
    await close(root);
    return ok && !!selectionText(root);
  }

  AF.antd = { pick, readAll, selectionText, comboInput };

  AF.registerDriver({
    type: "antd-select",
    priority: 13,
    match(el) {
      if (!applies() || !el || el.tagName !== "INPUT") return null;
      if (!el.classList.contains("ant-select-selection-search-input")) return null;
      if (AF.dayforce.shouldSkipControl(el)) return null;
      return el.closest(".ant-select");
    },
    consumes(root) {
      return [...root.querySelectorAll("input")];
    },
    cidEl(root) {
      return comboInput(root);
    },
    extract(root) {
      const input = comboInput(root);
      return {
        kind: "custom",
        label: AF.dom.labelForControl(input || root),
        required: !!((input && input.getAttribute("aria-required") === "true") || (AF.dayforce && AF.dayforce.isRequiredControl(root))),
        multi: root.classList.contains("ant-select-multiple"),
        options: [],
      };
    },
    isFilled(root) {
      return !!selectionText(root);
    },
    async harvestOptions(root) {
      if (root.classList.contains("ant-select-disabled")) return [];
      if (!(await open(root))) return [];
      const all = await readAll(root);
      await close(root);
      // A list too long to send (Country, ~250) is answered as text and found by search when written.
      return all.length > MAX_OPTIONS ? [] : all;
    },
    async write(root, answer) {
      const want = answer.option || answer.value || (Array.isArray(answer.option_values) ? answer.option_values[0] : "");
      return pick(root, want);
    },
  });
})();
