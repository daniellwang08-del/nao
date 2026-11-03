// react-select (and look-alike custom dropdown) driver.
//
// react-select renders its option list ONLY while the menu is open (the
// .select__menu subtree is mounted on open and unmounted on close), so options
// cannot be read from the static DOM. This driver therefore opens the widget,
// polls until the listbox mounts, harvests the option texts, then closes - and
// at write time opens again to click the chosen option (value-aware: a wrong
// pre-existing selection is replaced, not kept).
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, textsMatch, isVisible, delay, waitUntil, setNativeValue } = AF.dom;

  const COMBO_ROOT_SEL =
    '[class*="select__control"], [class*="select-control"], [class*="Select-control"], [role="combobox"]';
  const OPTION_SEL = '[role="option"], .select__option, [class*="-option"], li[role="option"]';
  const MAX_HARVEST_OPTIONS = 120; // matches backend MAX_OPTIONS_PER_CONTROL

  function isItiCountryNode(el) {
    try {
      return !!(el && el.closest && el.closest(".iti__country-list, .iti"));
    } catch {
      return false;
    }
  }

  function isComboInput(inp) {
    const role = (inp.getAttribute && inp.getAttribute("role")) || "";
    const cls = String((inp.className && inp.className.baseVal !== undefined ? inp.className.baseVal : inp.className) || "");
    return (
      role === "combobox" ||
      (inp.getAttribute && inp.getAttribute("aria-autocomplete") === "list") ||
      (inp.getAttribute && inp.getAttribute("aria-haspopup") === "listbox") ||
      /dummyInput/i.test(cls) ||
      (inp.closest && inp.closest(".react-select"))
    );
  }

  // The canonical widget root we own and write against: the .select__control
  // (holds the .select__single-value and the inner input). The menu mounts as
  // its sibling or in a portal - located separately via aria-controls.
  //
  // NOTE: we must NOT return the inner <input> here even though it matches
  // [role="combobox"] (Element.closest tests self first): the single-value node
  // lives in the control container, so an input root makes comboHasSelection /
  // comboSelectionText always report empty and a successful pick looks failed.
  function comboRoot(el) {
    if (el.closest) {
      const ctrl = el.closest('[class*="select__control"], [class*="select-control"], [class*="Select-control"]');
      if (ctrl) return ctrl;
      // Emotion-styled react-select (RecruiterFlow, etc.) ships opaque class
      // names like "css-1wq9ix5-control" with no "select" prefix, so the control
      // container is the nearest *-control ancestor of the combobox input. Without
      // this, the input itself becomes the root: openCombo fires on the input
      // instead of the control (the menu never opens, so option harvesting reads
      // nothing) and comboHasSelection/comboSelectionText always report empty.
      const emo = el.closest('[class*="-control"]');
      if (emo) return emo;
      const cb = el.closest('[role="combobox"]');
      if (cb && cb.tagName !== "INPUT") return cb;
    }
    return el;
  }

  function comboInput(root) {
    if (root.tagName === "INPUT") return root;
    if (!root.querySelector) return null;
    return (
      root.querySelector('input[role="combobox"]') ||
      root.querySelector("input.react-select__input") ||
      root.querySelector('input[class*="dummyInput"]') ||
      root.querySelector("input")
    );
  }

  function isDummyInput(input) {
    if (!input) return false;
    const cls = String(input.className || "");
    return (
      input.readOnly ||
      /dummyInput/i.test(cls) ||
      (input.getAttribute && input.getAttribute("aria-readonly") === "true")
    );
  }

  // Pinpoint ships a mobile <select> sibling for some react-select widgets; use
  // it when the desktop dummy input cannot be typed into.
  function pinpointMobileSelect(root) {
    try {
      const block = root.closest && root.closest(".col-md-1-1, .frow, .pad-v-3");
      if (!block) return null;
      const sel = block.querySelector("select");
      if (sel && sel.options && sel.options.length > 1) return sel;
    } catch {}
    return null;
  }

  async function writeNativeSelect(sel, want) {
    const value = clean(want);
    if (!sel || !value) return false;
    const w = normText(value);
    const options = [...sel.options];
    const opt =
      options.find((o) => normText(clean(o.textContent)) === w) || options.find((o) => textsMatch(o.textContent, value));
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function isMultiCombo(root, input) {
    try {
      if (root && root.querySelector && root.querySelector('[class*="--is-multi"], [class*="multiValue"], [class*="multi-value"]'))
        return true;
      const el = input || root;
      if (el && el.getAttribute && el.getAttribute("aria-multiselectable") === "true") return true;
      if (root && root.closest) {
        if (root.closest('[class*="--is-multi"]')) return true;
        // RecruiterFlow (and similar emotion-styled react-selects) emit opaque
        // class names with NO --is-multi / aria-multiselectable marker. Their only
        // reliable multi signal is the field wrapper: ".multi-select-input-wrapper"
        // vs ".single-select-input-wrapper". Without this every multi widget is
        // mistaken for a single-select, so the model picks one value (ignoring
        // "select all" / "pick 2") and the writer never enters multi mode.
        if (root.closest(".multi-select-input-wrapper")) return true;
        if (root.closest(".single-select-input-wrapper")) return false;
      }
    } catch {}
    return false;
  }

  // Labels of the currently selected chips in a multi-select control. Used to
  // verify each pick committed and to skip values that are already present.
  // Emotion names the chip parts "...-multiValue", "...-multiValueLabel" and
  // "...-multiValueRemove"; collect the label text and drop the remove "x".
  function chipTexts(root) {
    const out = [];
    try {
      (root.querySelectorAll('[class*="multiValue"], [class*="multi-value"]') || []).forEach((n) => {
        const cls = String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || "");
        if (/multiValueRemove|multiValue__remove|multi-value__remove|multi-value-remove/i.test(cls)) return;
        const t = normText(clean(n.innerText || n.textContent));
        if (t) out.push(t);
      });
    } catch {}
    return [...new Set(out)];
  }

  function chipMatches(root, want) {
    return chipTexts(root).some((t) => textsMatch(t, want));
  }

  // react-select's empty-state notice matches our [class*="-option"] selector;
  // treat notice/loading/placeholder nodes as NOT options.
  function isRealOption(o) {
    if (!isVisible(o)) return false;
    if (isItiCountryNode(o)) return false;
    const cls = (o.className && o.className.baseVal !== undefined ? o.className.baseVal : o.className) || "";
    if (/notice|no-?options|no-?results|loading|placeholder/i.test(String(cls))) return false;
    if (o.getAttribute && o.getAttribute("role") === "option") return true;
    return /(^|\s|_|-)option(\s|_|-|$)/i.test(String(cls)) || /select__option/.test(String(cls));
  }

  function optionNodes(scope) {
    if (!scope) return [];
    return [...scope.querySelectorAll(OPTION_SEL)].filter(isRealOption);
  }

  // The listbox belonging to THIS widget: react-select sets the input's
  // aria-controls/aria-owns to its own listbox id, isolating it from other open
  // menus (e.g. a 200-entry country list bleeding into an unrelated control).
  function comboListbox(input, root) {
    try {
      // Rippling's combobox is a bare div[role=combobox] (no input) that sets
      // aria-controls on itself while open; its listbox is portalled elsewhere.
      for (const el of [input || comboInput(root), root]) {
        const id = el && el.getAttribute && (el.getAttribute("aria-controls") || el.getAttribute("aria-owns"));
        const lb = id && document.getElementById(id);
        if (lb) return lb;
      }
    } catch {}
    try {
      const menu =
        (root && root.querySelector && root.querySelector('[class*="menu"], [role="listbox"]')) || null;
      if (menu) return menu;
    } catch {}
    return null;
  }

  function scopedOptionNodes(input, root) {
    return optionNodes(comboListbox(input, root));
  }

  // Reset any typed-in filter text so the FULL, unfiltered option list mounts,
  // then return its nodes. Used by the write fallbacks: after a failed
  // type+Enter the menu is still filtered by the typed text (often to zero
  // options), so reading scopedOptionNodes directly would see nothing. Clearing
  // lets our own dash/quote-robust normText matching (pickOption) work over
  // every real option. Best-effort and awaitable.
  async function clearedOptionNodes(input, root) {
    try {
      if (input && !isDummyInput(input)) {
        setNativeValue(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      openCombo(input, root);
      await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 800, 60);
    } catch {}
    return scopedOptionNodes(input, root);
  }

  function collectVisibleOptions(scope) {
    if (!scope) return [];
    const opts = [];
    scope.querySelectorAll(OPTION_SEL).forEach((o) => {
      if (!isRealOption(o)) return;
      const t = clean(o.innerText || o.textContent);
      if (t) opts.push(t);
    });
    return [...new Set(opts)].slice(0, MAX_HARVEST_OPTIONS);
  }

  function isAshbyValueCombo(root, input) {
    try {
      if (!(AF.ashby && AF.ashby.isValueCombobox)) return false;
      return AF.ashby.isValueCombobox(input || root);
    } catch {
      return false;
    }
  }

  function comboHasSelection(root) {
    const sv =
      root.querySelector &&
      root.querySelector(
        '[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]'
      );
    if (sv && clean(sv.innerText || sv.textContent)) return true;
    // Ashby: only count a CLOSED menu + non-empty value as filled. Open menu
    // with filter text is not a commit (aria-expanded=true).
    const input = comboInput(root);
    if (isAshbyValueCombo(root, input) && input && clean(input.value) && !comboIsExpanded(input)) {
      return true;
    }
    if (isPlaceSearch(root, input)) return placeCommitted(input);
    return !!bareComboValue(root, input);
  }

  // ── Place search (Rippling Location, Google Places style) ─────────────────
  // A bare text input whose suggestions only load from a search service after
  // typing (2-5 s on Rippling). Picking a suggestion rewrites the input to the
  // place's full name ("Austin, TX, USA") and fills a hidden place-id input; a
  // typed value that was never picked is rejected as "required" on submit.
  const US_STATES = {
    al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
    ct: "connecticut", de: "delaware", dc: "district of columbia", fl: "florida", ga: "georgia",
    hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky",
    la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
    ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
    nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota",
    oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
    sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia",
    wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  };
  const US_NAMES = new Set(["us", "usa", "u s a", "united states", "united states of america"]);
  const PLACE_LABEL_RE = /\b(location|city|town|address|where .{0,20}(based|located|live))\b/i;

  function placeIdInput(input) {
    // Rippling keeps it in the next field block ([data-testid=externalPlaceId]),
    // so look outward and take the nearest one.
    let el = input && input.parentElement;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      for (const hit of el.querySelectorAll ? el.querySelectorAll('input[type="hidden"]') : []) {
        const tag = `${hit.name || ""} ${hit.id || ""} ${hit.getAttribute("data-testid") || ""} ${hit.getAttribute("data-input") || ""}`;
        if (/place/i.test(tag)) return hit;
      }
    }
    return null;
  }

  // Only a bare input (no react-select control around it) that searches as you type.
  function isPlaceSearch(root, input) {
    if (!input || root !== input || input.tagName !== "INPUT" || isDummyInput(input)) return false;
    if (isAshbyValueCombo(root, input)) return false;
    if (AF.lever && AF.lever.isAutocompleteInput && AF.lever.isAutocompleteInput(input)) return false; // lever.js owns it
    if (input.getAttribute("aria-autocomplete") !== "list") return false;
    if (placeIdInput(input)) return true;
    return PLACE_LABEL_RE.test(AF.dom.labelForControl(input) || "");
  }

  function placeCommitted(input) {
    if (!input || !clean(input.value) || comboIsExpanded(input)) return false;
    const pid = placeIdInput(input);
    return pid ? !!clean(pid.value) : true;
  }

  // "Austin, TX, USA" -> { city: "austin", region: "texas", country: "united states" }
  function placeParts(text) {
    const segs = String(text || "")
      .split(",")
      .map((s) => normText(s))
      .filter(Boolean);
    const out = { city: segs[0] || "", region: "", country: "" };
    for (const s of segs.slice(1)) {
      if (US_NAMES.has(s.replace(/\./g, " ").replace(/\s+/g, " ").trim())) out.country = "united states";
      else if (!out.region && (US_STATES[s] || Object.values(US_STATES).includes(s))) out.region = US_STATES[s] || s;
      else if (!out.region && segs.length > 2) out.region = s;
      else out.country = out.country || s;
    }
    if (out.region && !out.country && Object.values(US_STATES).includes(out.region)) out.country = "united states";
    return out;
  }

  // Best suggestion for the wanted place: same city first, then region, then country.
  // Search services rank well, so ties keep the service's order.
  function bestPlaceOption(nodes, want) {
    const w = placeParts(want);
    if (!w.city) return null;
    let best = null;
    let bestScore = 0;
    for (const o of nodes) {
      const g = placeParts(clean(o.innerText || o.textContent));
      if (g.city !== w.city) continue;
      let score = 4;
      if (w.region) score += g.region === w.region ? 2 : g.region ? -2 : 0;
      if (w.country) score += g.country === w.country ? 1 : g.country ? -1 : 0;
      if (score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    return best;
  }

  // Queries to try: "City, State" first (Rippling's search finds nothing for
  // "Austin, TX, USA"), then the full text, then the city alone.
  function placeQueries(want) {
    const segs = String(want || "")
      .split(",")
      .map((s) => clean(s))
      .filter(Boolean);
    const out = [segs.slice(0, 2).join(", "), segs.join(", ")];
    if (segs.length > 1) out.push(segs[0]);
    return [...new Set(out.filter(Boolean))];
  }

  async function writePlaceSearch(input, root, want) {
    const w = placeParts(want);
    if (placeCommitted(input) && placeParts(input.value).city === w.city) return true;
    const typeFn = AF.dom.typeReactValue;
    const clickFn = AF.dom.pageClick;
    const typeQuery = async (query) => {
      try {
        input.focus({ preventScroll: true });
      } catch {}
      // Open the widget the way a click does, then clear and let the empty value
      // settle so the search runs again even when the same text was already typed.
      openCombo(input, root);
      setNativeValue(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await delay(400);
      if (typeof typeFn === "function") typeFn(input, query);
      else {
        setNativeValue(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
    // Results arrive asynchronously; wait for a suggestion naming the city.
    const awaitOption = async (ms) => {
      let opt = null;
      await waitUntil(
        () => {
          const lb = comboListbox(input, root);
          if (lb && lb.getAttribute("aria-busy") === "true") return null;
          opt = bestPlaceOption(scopedOptionNodes(input, root), want);
          return opt ? true : null;
        },
        ms,
        120
      );
      return opt;
    };
    // Rippling's suggestions come from the Google Maps library, which loads on the
    // first focus: text typed before it is ready never gets an answer, and the
    // load can take 10 s. So "City, State" is typed again before the other forms.
    const queries = placeQueries(want);
    const plan = [queries[0], queries[0], ...queries.slice(1), queries[0]];
    const started = Date.now();
    for (const query of plan) {
      if (Date.now() - started > 50000) break;
      await typeQuery(query);
      const opt = await awaitOption(7000);
      diag(input, "place search", {
        query,
        ms: Date.now() - started,
        options: scopedOptionNodes(input, root).length,
        picked: opt && clean(opt.innerText),
      });
      if (!opt) continue;
      if (typeof clickFn === "function") clickFn(opt);
      else clickOption(opt);
      if (await waitUntil(() => (placeCommitted(input) ? true : null), 3000, 80)) return true;
    }
    return placeCommitted(input) && placeParts(input.value).city === w.city;
  }

  function diag(input, msg, extra) {
    try {
      console.log("[autofill] combo", (input && input.id) || "", msg, extra || "");
    } catch {}
  }

  // Input-less div[role=combobox] (Rippling): the committed option is the
  // div's own text; while empty it shows its aria-label placeholder in a <p>.
  function bareComboValue(root, input) {
    if (input || !root || root.getAttribute("role") !== "combobox") return "";
    const t = clean(root.innerText || root.textContent);
    if (!t) return "";
    const ph = clean(root.getAttribute("aria-label") || root.getAttribute("placeholder"));
    if (ph && normText(t) === normText(ph)) return "";
    if (/^(select|choose)\b.{0,12}$/i.test(t)) return "";
    return t;
  }

  function comboSelectionText(root) {
    const sv = root.querySelector && root.querySelector('[class*="singleValue"], [class*="single-value"]');
    if (sv) return clean(sv.innerText || sv.textContent);
    const input = comboInput(root);
    if (isAshbyValueCombo(root, input) && input && clean(input.value) && !comboIsExpanded(input)) {
      return clean(input.value);
    }
    if (isPlaceSearch(root, input) && placeCommitted(input)) return clean(input.value);
    return bareComboValue(root, input);
  }

  function valueMatchesWant(got, want) {
    return textsMatch(got, want);
  }

  function comboIsExpanded(input) {
    try {
      return !!(input && input.getAttribute && input.getAttribute("aria-expanded") === "true");
    } catch {
      return false;
    }
  }

  // Ashby: typed filter text sits in input.value WHILE the listbox is open
  // (screenshot: placeholder/empty commit, "LinkedIn Jobs" only highlighted).
  // That is NOT a committed selection, Enter often only highlights. Require
  // the menu to be collapsed and the value to still match.
  function ashbyComboCommitted(input, want) {
    if (!input || !want) return false;
    if (comboIsExpanded(input)) return false;
    return valueMatchesWant(input.value, want);
  }

  function ashbyDiag(cidHint, msg, extra) {
    try {
      console.log("[autofill] ashby-combo", cidHint || "", msg, extra || "");
    } catch {}
  }

  // Open the widget. Libraries disagree on which event opens the menu
  // (react-select v5 -> mousedown; others -> pointer/click), so dispatch the
  // FULL pointer+mouse+click sequence (single press, not a toggle) plus an
  // ArrowDown keyboard fallback that recovers a dropped first "cold" open.
  function openCombo(input, root) {
    (input || root).focus();
    try {
      root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    root.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    try {
      root.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    try {
      root.click();
    } catch {}
    if (input) {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", code: "ArrowDown" }));
    }
  }

  function closeMenu(input, root) {
    const tgt = input || root;
    // Escape inside a Bootstrap modal (JobDiva #quickApplyModal, etc.) calls
    // Modal.hide(), probe-verified stack: closeMenu → bootstrap hide. Never
    // send Escape / body clicks from within a .modal.
    try {
      if (tgt && tgt.closest && tgt.closest(".modal")) return;
      if (root && root.closest && root.closest(".modal")) return;
    } catch {}
    try {
      tgt.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
    } catch {}
    // react-select dismisses on an outside pointer event; Escape alone is often
    // ignored. Fire a full outside click on <body> so the menu reliably closes.
    try {
      for (const t of ["mousedown", "mouseup", "click"]) {
        document.body.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      }
    } catch {}
    try {
      tgt.blur && tgt.blur();
    } catch {}
  }

  function pickOption(nodes, want) {
    const w = normText(want);
    if (!w) return null;
    for (const o of nodes) {
      if (normText(o.innerText || o.textContent) === w) return o;
    }
    for (const o of nodes) {
      if (textsMatch(o.innerText || o.textContent, w)) return o;
    }
    return null;
  }

  function isActiveOption(o) {
    const cls = String((o.className && o.className.baseVal !== undefined ? o.className.baseVal : o.className) || "");
    return /is-focused|--focused|option--active/i.test(cls) || o.getAttribute("aria-selected") === "true";
  }

  function clickOption(opt) {
    opt.scrollIntoView && opt.scrollIntoView({ block: "nearest" });
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      opt.click();
    } catch {}
  }

  async function harvestOptions(root) {
    const input = comboInput(root);
    // Ashby: opening the location combobox clears a committed .value. Preserve
    // and restore so a harvest (or a missed isFilled) cannot empty the field.
    const ashbyPreserved =
      isAshbyValueCombo(root, input) && input ? clean(input.value) : "";
    let options = [];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        openCombo(input, root);
        const ready = await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 1000, 60);
        if (ready) break;
        await delay(120);
      }
      const lb = comboListbox(input, root);
      options = collectVisibleOptions(lb);
    } catch {
      options = [];
    } finally {
      closeMenu(input, root);
      if (ashbyPreserved && input && !clean(input.value)) {
        try {
          setNativeValue(input, ashbyPreserved);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          if (AF.dom.commitReactValue) AF.dom.commitReactValue(input, ashbyPreserved);
        } catch {}
      }
    }
    if (!options.length && AF.pinpoint && AF.pinpoint.rorOptionsFor) {
      options = AF.pinpoint.rorOptionsFor(input || root);
    }
    return options;
  }

  function pressEnter(el) {
    const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // The native react-select interaction: open, type the answer (which filters
  // the list and auto-highlights the first match), then commit. react-select
  // filters by plain substring, so typing "Male" lists "Female" first; Enter
  // would commit that. When the matching option is not the highlighted one,
  // click it instead.
  async function typeAndEnter(input, root, value) {
    (input || root).focus();
    openCombo(input, root);
    if (!input) return;
    setNativeValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 800, 50);
    const nodes = scopedOptionNodes(input, root);
    const opt = pickOption(nodes, value);
    const active = nodes.find(isActiveOption) || nodes[0];
    if (opt && !isActiveOption(opt)) clickOption(opt);
    else if (opt || !active || !wrongPick(active.innerText || active.textContent, value)) pressEnter(input);
    await delay(80);
  }

  // A pick that only holds the answer inside another word ("Female" for "Male").
  function wrongPick(got, want) {
    const g = normText(got);
    const w = normText(want);
    return !!g && !!w && (g.includes(w) || w.includes(g)) && !textsMatch(g, w);
  }

  async function writeSingle(root, want) {
    const value = clean(want);
    if (!value) return false;
    const input = comboInput(root);
    // Already showing the desired value -> nothing to do.
    const cur = comboSelectionText(root);
    if (cur && valueMatchesWant(cur, value)) return true;

    // Pinpoint EEO / equality selects use a read-only dummyInput, and Rippling's
    // combobox has no input at all: open the menu and click the option.
    if (!input || isDummyInput(input)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          openCombo(input, root);
          await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 1000, 60);
          const opt = pickOption(scopedOptionNodes(input, root), value);
          if (opt) {
            clickOption(opt);
            if (await waitUntil(() => (comboHasSelection(root) ? true : null), 700, 60)) return true;
          }
        } catch {}
        closeMenu(input, root);
        await delay(120);
      }
      const mob = pinpointMobileSelect(root);
      if (mob && (await writeNativeSelect(mob, value))) return true;
      return comboHasSelection(root);
    }

    // Rippling Location and other place searches: suggestions load after typing.
    if (isPlaceSearch(root, input)) return writePlaceSearch(input, root, value);

    // Ashby value-combobox, live probe evidence (jobs.ashbyhq.com):
    // - Options live in aria-controls listbox (DIV._floatingContainer_d7ago_103).
    // - Location: aria-selected stays "false"; Enter does NOT commit; option
    //   mousedown+click commits (ApiSetFormValue, aria-expanded=false).
    // - How-heard: aria-selected="true" + activedescendant; Enter alone commits.
    // - Must type via MAIN-world bridge WITHOUT blur (kind:"type"), then click
    //   the option via MAIN-world __af_page_click. Never commitReactValue after
    //   (that re-types+blurs and re-opens the menu).
    if (isAshbyValueCombo(root, input)) {
      const hint = (input && (input.getAttribute("data-autofill-cid") || input.id)) || "ashby-combo";
      if (ashbyComboCommitted(input, value)) {
        ashbyDiag(hint, "skip already committed", { value: clean(input.value) });
        return true;
      }
      const typeFn = AF.dom.typeReactValue;
      const clickFn = AF.dom.pageClick;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          ashbyDiag(hint, "attempt " + attempt, {
            want: value,
            beforeValue: clean(input && input.value),
            beforeExpanded: comboIsExpanded(input),
          });
          try {
            input.focus({ preventScroll: true });
          } catch {
            try {
              input.focus();
            } catch {}
          }
          // Open if collapsed; avoid toggle-closed when already open.
          if (!comboIsExpanded(input)) openCombo(input, root);
          if (typeof typeFn === "function") typeFn(input, value);
          else {
            setNativeValue(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          // Location geocode is async, wait longer than static option lists.
          await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 2500, 60);
          const nodes = scopedOptionNodes(input, root);
          let opt = pickOption(nodes, value);
          // Prefer aria-selected / activedescendant when text match is soft.
          if (!opt) {
            const activeId = input.getAttribute("aria-activedescendant");
            if (activeId) {
              try {
                opt = document.getElementById(activeId) || null;
              } catch {
                opt = null;
              }
            }
          }
          if (!opt) {
            opt = nodes.find((o) => (o.getAttribute("aria-selected") || "") === "true") || null;
          }
          ashbyDiag(hint, "options", {
            count: nodes.length,
            picked: opt ? clean(opt.innerText || opt.textContent) : null,
            expanded: comboIsExpanded(input),
            filterValue: clean(input.value),
            activedescendant: input.getAttribute("aria-activedescendant"),
            listbox: (input.getAttribute("aria-controls") || "").slice(0, 40),
          });
          if (opt) {
            if (typeof clickFn === "function") clickFn(opt);
            else clickOption(opt);
          } else if (input.getAttribute("aria-activedescendant") || nodes.some((o) => o.getAttribute("aria-selected") === "true")) {
            // Probe: Enter commits when an option is already active/selected.
            pressEnter(input);
          } else {
            ashbyDiag(hint, "no option to click");
          }
          const ok = await waitUntil(
            () => (ashbyComboCommitted(input, value) ? true : null),
            1500,
            50
          );
          ashbyDiag(hint, ok ? "committed" : "not committed", {
            value: clean(input && input.value),
            expanded: comboIsExpanded(input),
          });
          if (ok) {
            // Soft blur only, do NOT re-set the value (reopens autocomplete).
            try {
              input.blur && input.blur();
            } catch {}
            return true;
          }
        } catch (err) {
          ashbyDiag(hint, "threw", err && err.message);
        }
        try {
          input && input.blur && input.blur();
        } catch {}
        await delay(200);
      }
      const finalOk = ashbyComboCommitted(input, value);
      ashbyDiag(hint, "final", {
        ok: finalOk,
        value: clean(input && input.value),
        expanded: comboIsExpanded(input),
      });
      return finalOk;
    }

    const picked = () => comboHasSelection(root) && !wrongPick(comboSelectionText(root), value);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await typeAndEnter(input, root, value);
        if (await waitUntil(() => (picked() ? true : null), 700, 60)) return true;
        // Fallback: type+Enter silently no-ops when the model's answer is not a
        // byte-exact substring react-select's OWN filter accepts (e.g. a long
        // Greenhouse sentence whose live option uses an em-dash "-" the model
        // returned as a hyphen). The filter then hides every option, so reading
        // scopedOptionNodes now yields the EMPTY filtered list. Clear the typed
        // text first so the FULL list re-renders, then match with our own
        // dash/quote-robust normText (pickOption) and click.
        const opt = pickOption(await clearedOptionNodes(input, root), value);
        if (opt) {
          clickOption(opt);
          if (await waitUntil(() => (picked() ? true : null), 700, 60)) return true;
        }
      } catch {}
      closeMenu(input, root);
      await delay(120);
    }
    return picked();
  }

  async function writeMulti(root, values) {
    const list = (values || []).map(clean).filter(Boolean);
    if (!list.length) return false;
    const input = comboInput(root);
    for (const value of list) {
      // Already a chip for this value (e.g. retry) -> skip.
      if (chipMatches(root, value)) continue;
      try {
        // type + Enter per value; react-select keeps the menu open in multi mode.
        await typeAndEnter(input, root, value);
      } catch {}
      // Verify the chip actually landed. type+Enter silently no-ops when the
      // typed text doesn't auto-highlight an option, which is exactly how these
      // fields ended up empty. Fall back to opening the menu and clicking the
      // matching option node directly.
      const added = await waitUntil(() => (chipMatches(root, value) ? true : null), 600, 50);
      if (!added) {
        try {
          // Clear the residual typed text first: after a failed type+Enter the
          // menu is still filtered by it, so the full option list (needed for our
          // dash/quote-robust match) would otherwise be hidden.
          const opt = pickOption(await clearedOptionNodes(input, root), value);
          if (opt) clickOption(opt);
          await waitUntil(() => (chipMatches(root, value) ? true : null), 500, 50);
        } catch {}
      }
    }
    closeMenu(input, root);
    return chipTexts(root).length > 0;
  }

  AF.registerDriver({
    type: "react-select",
    priority: 20,
    match(el) {
      // intl-tel-input's flag picker is role=combobox but is NOT react-select;
      // claiming it harvests the entire 200-entry country list into options.
      if (el.closest && el.closest(".iti")) return null;
      // A native <select> is never a react-select, but iCIMS puts role="combobox"
      // on real ones (rcf3048 "How did you hear about us?" ships five inline
      // <option>s). Claiming those reports kind:"custom" with no options and
      // opens a menu that does not exist, so leave every <select> to
      // native-select / icims-dropdown.
      if (el.tagName === "SELECT") return null;
      // The iCIMS AJAX dropdown's search box and result list live inside
      // .dropdown-container; drivers/icims-dropdown.js owns that whole widget.
      if (el.closest && el.closest(".dropdown-container")) return null;
      if (el.id && /_icimsDropdown$/.test(el.id)) return null;
      if (el.tagName === "INPUT" && isComboInput(el)) return comboRoot(el);
      if (el.getAttribute && el.getAttribute("role") === "combobox" && el.tagName !== "INPUT") {
        // A container-level combobox with no inner input.
        if (el.querySelector && el.querySelector("input")) return null;
        return el;
      }
      return null;
    },
    // The stable cid comes from the inner combobox input's id (e.g. "gender",
    // "question_8820015005"), not the unidentified .select__control container.
    cidEl(root) {
      return comboInput(root) || root;
    },
    // Consume the hidden react-select "requiredInput" validation shim (sibling of
    // the control, inside the container) so the native driver never treats it as
    // a separate always-filled text field.
    consumes(root) {
      const extra = [];
      const shell = (root.closest && (root.closest(".select-shell") || root.closest('[class*="container"]'))) || root.parentElement;
      if (shell && shell.querySelectorAll) {
        shell
          .querySelectorAll('input[class*="requiredInput"], input[aria-hidden="true"], input[type="hidden"]')
          .forEach((n) => extra.push(n));
        shell.querySelectorAll('input[tabindex="-1"]').forEach((n) => {
          try {
            const r = n.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) extra.push(n);
          } catch {}
        });
      }
      return extra;
    },
    extract(root) {
      const input = comboInput(root);
      const req =
        (input && input.required) ||
        (root.getAttribute && root.getAttribute("aria-required") === "true") ||
        (input && input.getAttribute && input.getAttribute("aria-required") === "true");
      return {
        kind: "custom",
        label: AF.dom.labelForControl(input || root),
        required: !!req,
        multi: isMultiCombo(root, input),
        options: [],
      };
    },
    isFilled(root) {
      return comboHasSelection(root);
    },
    async harvestOptions(root) {
      // A place search lists nothing until something is typed.
      if (isPlaceSearch(root, comboInput(root))) return [];
      const opts = await harvestOptions(root);
      if (opts.length) return opts;
      const input = comboInput(root);
      if (AF.pinpoint && AF.pinpoint.rorOptionsFor) return AF.pinpoint.rorOptionsFor(input || root);
      return opts;
    },
    async write(root, answer) {
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
      // Treat as multi when the widget reports it OR the model returned several
      // values: RecruiterFlow's multi widget (css-dktw4y-container) carries no
      // detectable --is-multi marker, so a "select all / pick 2" answer would
      // otherwise commit only its first value.
      const multi = isMultiCombo(root, comboInput(root)) || values.length > 1;
      if (multi) return writeMulti(root, values);
      return writeSingle(root, answer.option || answer.value || "");
    },
  });

  // Collapse any react-select menus left open after a long harvest pass (avoids
  // stacked option lists bleeding across unrelated screening questions).
  AF.closeReactSelectMenus = function closeReactSelectMenus(scope) {
    // JobDiva Quick Apply is a Bootstrap modal with native .form-control inputs
    // (no react-select). The broad "[class*='-control']" selector matches
    // "form-control", and closeMenu's Escape then runs Bootstrap Modal.hide()
    // (stack-verified on www1.jobdiva.com). Skip entirely on JobDiva.
    try {
      if (
        (AF.jobdiva && AF.jobdiva.isJobDivaPage && AF.jobdiva.isJobDivaPage()) ||
        /jobdiva\.com$/i.test(location.hostname) ||
        document.querySelector("#quickApplyModal.show, .job-app-main")
      ) {
        return;
      }
    } catch {}
    const root = scope && scope.querySelectorAll ? scope : document;
    try {
      root.querySelectorAll('[class*="select__control"], [class*="-control"]').forEach((ctrl) => {
        try {
          // "form-control" / "jd-form" contain "-control" as a substring, those
          // are Bootstrap/JobDiva native inputs, not react-select.
          const cls = String(
            (ctrl.className && ctrl.className.baseVal !== undefined
              ? ctrl.className.baseVal
              : ctrl.className) || ""
          );
          if (/\bform-control\b|\bjd-form\b|\bmodal-?\b/i.test(cls)) return;
          if (ctrl.closest && ctrl.closest(".modal, .jd-form-layout, .job-app-main")) return;
          const inp = comboInput(ctrl);
          closeMenu(inp, ctrl);
        } catch {}
      });
    } catch {}
    try {
      for (const t of ["mousedown", "mouseup", "click"]) {
        document.body.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      }
    } catch {}
  };
})();
