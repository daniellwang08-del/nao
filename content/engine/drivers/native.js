// Native HTML control drivers: <input> (text-like), <textarea>, and <select>.
// These are the standard, non-widget controls. Each driver is self-contained:
// it claims the elements it owns (match), reads a spec (extract), reports
// whether the page already holds a value (isFilled), and writes a value.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, containsWord, setNativeValue, fireInput, setReactTextValue, setReactSelectValue, labelForControl, constraintsOf } =
    AF.dom;

  const SKIP_INPUT_TYPES = ["hidden", "submit", "button", "image", "reset"];

  // Write a value the way a user does: focus → type → blur, via the React-safe
  // setter in dom.js. Ashby (and other controlled React forms) only keep the
  // value in submit state when onChange fires and the field blurs; writing the
  // DOM alone produces the "Missing entry for required field: Email" error
  // while the input still looks filled.
  function setTextInput(el, value) {
    if (typeof setReactTextValue === "function") {
      return setReactTextValue(el, value == null ? "" : String(value));
    }
    // Fallback if an older dom.js is somehow injected without setReactTextValue.
    let focused = false;
    try {
      el.focus({ preventScroll: true });
      focused = document.activeElement === el;
    } catch {}
    const lastValue = el.value;
    setNativeValue(el, value);
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === "function") tracker.setValue(lastValue);
    fireInput(el, value);
    if (focused) {
      try {
        el.blur();
      } catch {}
    } else {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
    return true;
  }

  function inputKind(inp) {
    const t = (inp.type || "text").toLowerCase();
    if (["email", "tel", "url", "number", "date", "password", "search"].includes(t)) {
      return t === "password" || t === "search" ? "text" : t;
    }
    if (["datetime-local", "month", "week", "time"].includes(t)) return "date";
    return "text";
  }

  // react-datepicker (Ashby "Pick date..."): a plain text input that parses typed
  // text with its dateFormat on blur and clears anything it cannot parse,
  // ISO dates included. Probe on Ashby: "11/12/2026" and "November 12, 2026"
  // commit, "2026-11-12" is wiped.
  const DEFAULT_DATE_FORMAT = "MM/DD/YYYY";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function isDatePickerInput(inp) {
    try {
      return !!(
        (inp.closest && inp.closest(".react-datepicker__input-container")) ||
        /\bashby-application-form-input-date\b/.test(String(inp.className || ""))
      );
    } catch {
      return false;
    }
  }

  function datePickerFormat(inp) {
    const ph = clean(inp.getAttribute && inp.getAttribute("placeholder"));
    return /^(?=.*y{2})(?=.*m{1,2})(?=.*d{1,2})[ymd\s/.-]+$/i.test(ph) ? ph.toUpperCase() : DEFAULT_DATE_FORMAT;
  }

  function validParts(y, m, d) {
    if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? { y, m, d } : null;
  }

  // Answer text -> {y, m, d}. Slash dates are month first (the server asks for
  // MM/DD/YYYY) unless the first number cannot be a month.
  function parseDateAnswer(text, format) {
    const s = clean(text);
    if (!s) return null;
    if (/^(today|now)$/i.test(s)) {
      const t = new Date();
      return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
    }
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return validParts(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (m) {
      const dayFirst = /^D/i.test(format || "") || +m[1] > 12;
      return dayFirst ? validParts(+m[3], +m[2], +m[1]) : validParts(+m[3], +m[1], +m[2]);
    }
    const t = new Date(s.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
    if (!isNaN(t.getTime()) && /[a-z]/i.test(s)) return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
    return null;
  }

  function formatDate(p, format) {
    const pad = (n) => String(n).padStart(2, "0");
    return (format || DEFAULT_DATE_FORMAT).replace(/Y{4}|Y{2}|M{1,2}|D{1,2}/gi, (tok) => {
      const t = tok.toUpperCase();
      if (t === "YYYY") return String(p.y);
      if (t === "YY") return pad(p.y % 100);
      if (t === "MM") return pad(p.m);
      if (t === "M") return String(p.m);
      if (t === "DD") return pad(p.d);
      return String(p.d);
    });
  }

  // Workable's picker masks typed text as MM/DD/YYYY ("November 5, 2026" turns
  // into "05/02/6"), and the calendar opening on first focus can wipe the first
  // write. A write counts only when the field reads back as the wanted date.
  async function writeDatePicker(el, answer) {
    const raw = clean(answer.value || "");
    if (!raw) return false;
    const format = datePickerFormat(el);
    const parts = parseDateAnswer(raw, format);
    if (!parts) {
      setTextInput(el, raw);
      return !!clean(el.value);
    }
    const numeric = formatDate(parts, format);
    const tries = [numeric, numeric, `${MONTHS[parts.m - 1]} ${parts.d}, ${parts.y}`];
    const holds = () => {
      const got = parseDateAnswer(el.value, format);
      return !!got && got.y === parts.y && got.m === parts.m && got.d === parts.d;
    };
    for (const value of tries) {
      setTextInput(el, value);
      await new Promise((r) => setTimeout(r, 150));
      try {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
      if (holds()) return true;
    }
    if (!holds()) setTextInput(el, "");
    return false;
  }

  // A combobox input belongs to react-select et al., not the native driver.
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

  // ── <select> ────────────────────────────────────────────────────────────
  // A <select> usually ships a pre-selected placeholder as its first option
  // ("No answer", "-- Select --", ...). Crucially the placeholder often has a
  // NON-empty value (ApplyToJob uses value="0" / "resumator_no_selection"), so a
  // bare value check wrongly reports the control as already filled and we skip
  // it. Detect the placeholder by its option text/value so we still answer it.
  function isPlaceholderSelected(sel) {
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    if (!opt) return true;
    if (!clean(opt.value)) return true; // empty value = nothing chosen
    const t = normText(opt.text);
    if (!t) return true;
    if (/no answer|please select|select one|select an option|choose one/.test(t)) return true;
    if (/^--/.test(t) || /^-+$/.test(t)) return true; // "-- No answer --", "----"
    if (/^(select|choose|none|n\/a)$/.test(t)) return true;
    if (/(^|_)no_?selection$/.test(normText(opt.value))) return true; // ATS sentinel
    // ApplyToJob EEO selects open on "Decline to answer" (value "0"): the page's
    // default, not the candidate's answer.
    if (sel.selectedIndex === 0 && isDeclineText(t)) {
      const defaults = [...sel.options].filter((o) => o.defaultSelected);
      if (!defaults.length || defaults[0] === opt) return true;
    }
    return false;
  }

  function isDeclineText(t) {
    return /^(i )?(decline|choose not|prefer not|do not wish|don.?t wish|wish not)\b/.test(t);
  }

  function selectOption(sel, want) {
    const w = clean(want).toLowerCase();
    if (!w) return false;
    let best = null;
    for (const o of sel.options) {
      if (clean(o.text).toLowerCase() === w || clean(o.value).toLowerCase() === w) {
        best = o;
        break;
      }
    }
    if (!best) {
      for (const o of sel.options) {
        if (containsWord(clean(o.text).toLowerCase(), w)) {
          best = o;
          break;
        }
      }
    }
    if (!best) return false;
    setNativeValue(sel, best.value);
    fireInput(sel);
    syncSiblingCustomDropdown(sel, best.value);
    return true;
  }

  // Grid Dynamics / CF7: native <select> is display:none; a .custom-dropdown
  // mirrors the value. Click the matching item so their JS + CF7 stay in sync.
  function syncSiblingCustomDropdown(sel, value) {
    try {
      const field =
        (sel.closest &&
          sel.closest(".apply-to-vacancy-form__field, .select, .wpcf7-form-control-wrap")) ||
        sel.parentElement;
      if (!field) return;
      const want = clean(value);
      if (!want) return;
      const items = field.querySelectorAll(
        ".custom-dropdown__item, [class*='dropdown__item'][data-value], [class*='dropdown__item']"
      );
      for (const item of items) {
        const v = clean(item.getAttribute("data-value") || item.innerText || "");
        if (!v) continue;
        if (v === want || v.toLowerCase() === want.toLowerCase()) {
          try {
            item.click();
          } catch {}
          return;
        }
      }
      const current = field.querySelector(".custom-dropdown__current, [class*='dropdown__current']");
      if (current && !clean(current.innerText)) current.textContent = want;
    } catch {}
  }

  function selectOptionsMulti(sel, wants) {
    const list = (wants || []).map((x) => clean(x).toLowerCase()).filter(Boolean);
    if (!list.length) return false;
    let any = false;
    for (const o of sel.options) {
      const t = clean(o.text).toLowerCase();
      const v = clean(o.value).toLowerCase();
      if (list.some((w) => t === w || v === w || containsWord(t, w) || containsWord(w, t))) {
        o.selected = true;
        any = true;
      }
    }
    if (any) fireInput(sel);
    return any;
  }

  AF.registerDriver({
    type: "native-select",
    priority: 40,
    match(el) {
      if (el.tagName !== "SELECT") return null;
      // Pinpoint mobile fallback <select> duplicates a react-select on desktop;
      // skip it when a react-select widget is present in the same question block.
      try {
        const block = el.closest && el.closest(".col-md-1-1, .frow, .pad-v-3");
        if (block && block.querySelector(".react-select, [class*='select__control']")) return null;
      } catch {}
      // iCIMS: a select with icimsdropdown-enabled="1" holds no real options
      // (they arrive over AJAX) and is driven through its visible widget by
      // drivers/icims-dropdown.js. Disabled/dependent selects are skipped until
      // their parent field is answered.
      if (AF.icims && AF.icims.dropdownAnchorFor && AF.icims.dropdownAnchorFor(el)) return null;
      if (AF.icims && AF.icims.shouldSkipControl && AF.icims.shouldSkipControl(el)) return null;
      return el;
    },
    extract(root) {
      return {
        kind: "select",
        label: labelForControl(root),
        required:
          !!root.required ||
          (root.getAttribute && root.getAttribute("aria-required") === "true") ||
          !!(AF.manatal && AF.manatal.isRequiredControl && AF.manatal.isRequiredControl(root)) ||
          !!(AF.jobdiva && AF.jobdiva.isRequiredControl && AF.jobdiva.isRequiredControl(root)) ||
          !!(AF.icims && AF.icims.isRequiredControl && AF.icims.isRequiredControl(root)),
        multi: !!root.multiple,
        options: [...root.options].map((o) => clean(o.text)).filter(Boolean),
      };
    },
    isFilled(root) {
      if (root.multiple) return !!(root.selectedOptions && root.selectedOptions.length);
      return !isPlaceholderSelected(root);
    },
    async write(root, answer) {
      const multi = !!root.multiple;
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
      if (!multi && values[0] != null && typeof setReactSelectValue === "function") {
        if (setReactSelectValue(root, values[0])) return true;
      }
      return multi ? selectOptionsMulti(root, values) : selectOption(root, answer.option || answer.value);
    },
  });

  // ── <textarea> ────────────────────────────────────────────────────────────
  AF.registerDriver({
    type: "native-textarea",
    priority: 60,
    match(el) {
      return el.tagName === "TEXTAREA" ? el : null;
    },
    extract(root) {
      return {
        kind: "textarea",
        label: labelForControl(root),
        required:
          !!root.required ||
          !!(AF.manatal && AF.manatal.isRequiredControl && AF.manatal.isRequiredControl(root)) ||
          !!(AF.jobdiva && AF.jobdiva.isRequiredControl && AF.jobdiva.isRequiredControl(root)) ||
          !!(AF.icims && AF.icims.isRequiredControl && AF.icims.isRequiredControl(root)),
        constraints: constraintsOf(root),
      };
    },
    isFilled(root) {
      return clean(root.value) !== "";
    },
    async write(root, answer) {
      return setTextInput(root, answer.value || "");
    },
  });

  // ── text-like <input> (catch-all, lowest priority) ──────────────────────────
  AF.registerDriver({
    type: "native-input",
    priority: 100,
    match(el) {
      if (el.tagName !== "INPUT") return null;
      const t = (el.type || "text").toLowerCase();
      if (SKIP_INPUT_TYPES.includes(t)) return null;
      if (t === "file" || t === "radio" || t === "checkbox") return null;
      if (isComboInput(el)) return null; // react-select inner input
      if (el.closest && el.closest(".react-select, [class*='select__']")) return null;
      if (el.closest && el.closest(".iti")) return null; // intl-tel-input owns it
      if (AF.lever && AF.lever.shouldSkipControl && AF.lever.shouldSkipControl(el)) return null;
      if (AF.workable && AF.workable.shouldSkipControl && AF.workable.shouldSkipControl(el)) return null;
      // iCIMS: login/password (written deterministically by the prep), the
      // dropdown widget's search box, and hidden mirror inputs.
      if (AF.icims && AF.icims.shouldSkipControl && AF.icims.shouldSkipControl(el)) return null;
      if (AF.jobdiva && AF.jobdiva.shouldSkipControl && AF.jobdiva.shouldSkipControl(el)) return null;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return null;
      if (el.className && /requiredInput/i.test(String(el.className))) return null; // react-select shim
      return el;
    },
    extract(root) {
      const datePicker = isDatePickerInput(root);
      const constraints = constraintsOf(root);
      if (datePicker) constraints.date_format = datePickerFormat(root);
      return {
        kind: datePicker ? "date" : inputKind(root),
        label: labelForControl(root),
        required:
          !!root.required ||
          (root.getAttribute && root.getAttribute("aria-required") === "true") ||
          !!(AF.manatal && AF.manatal.isRequiredControl && AF.manatal.isRequiredControl(root)) ||
          !!(AF.jobdiva && AF.jobdiva.isRequiredControl && AF.jobdiva.isRequiredControl(root)) ||
          !!(AF.icims && AF.icims.isRequiredControl && AF.icims.isRequiredControl(root)),
        constraints,
      };
    },
    isFilled(root) {
      return clean(root.value) !== "";
    },
    async write(root, answer) {
      if (isDatePickerInput(root)) return writeDatePicker(root, answer);
      return setTextInput(root, answer.value || "");
    },
  });

  // Exposed for reuse by other drivers (e.g. intl-tel-input writes a text input).
  AF.native = { setTextInput, selectOption, selectOptionsMulti, inputKind, normText, parseDateAnswer, formatDate };
})();
