// Oracle Recruiting (Candidate Experience) React widgets inside its Knockout forms (content/engine/oracle.js):
//   cx-select        input.cx-select-input[role=combobox]; options render in #<id>-listbox only while open, and the
//                    list filters only while the input has focus. Auto-suggest inputs (address, cities) take typed
//                    text and offer server suggestions, so they are answered as text.
//   cx-select-pills  ul.cx-select-pills-container of buttons (Title, Yes/No questions, short choice lists);
//                    role=radiogroup holds one choice, role=list several.
(() => {
  const AF = window.__AF;
  if (!AF || !AF.dom || !AF.registerDriver) return;
  const { clean } = AF.dom;

  const MAX_OPTIONS = 120; // backend MAX_OPTIONS_PER_CONTROL
  const applies = () => !!(AF.oracle && AF.oracle.isOraclePage && AF.oracle.isOraclePage());

  function rowOf(el) {
    return (el && el.closest && (el.closest(".input-row") || el.closest(".datepicker-row"))) || null;
  }

  function rowLabel(row, el) {
    if (!row) return AF.dom.labelForControl(el);
    const lab = row.querySelector(".input-row__label, label");
    const t = clean((lab && (lab.innerText || lab.textContent)) || "").replace(/\*+$/, "").trim();
    return t || AF.dom.labelForControl(el);
  }

  function rowRequired(row, el) {
    if (el && el.getAttribute && el.getAttribute("aria-required") === "true") return true;
    return !!(row && row.querySelector(".input-row__label--required, .cx-select__label--required, .input-row__label--required-star"));
  }

  AF.registerDriver({
    type: "oracle-cx-select",
    priority: 12,
    match(el) {
      if (!applies() || !el || el.tagName !== "INPUT") return null;
      if (!el.classList.contains("cx-select-input")) return null;
      if (AF.oracle.shouldSkipControl(el)) return null;
      return el;
    },
    cidEl(root) {
      return root;
    },
    extract(input) {
      const row = rowOf(input);
      let label = rowLabel(row, input);
      // A date part: "Start Date Month".
      const part = clean(input.getAttribute("aria-label") || "");
      if (row && row.classList.contains("datepicker-row") && part && !part.toLowerCase().includes(label.toLowerCase())) label = `${label} ${part}`.trim();
      return {
        kind: "custom",
        label,
        required: rowRequired(row, input),
        multi: false,
        options: [],
        placeholder: input.getAttribute("placeholder") || "",
      };
    },
    isFilled(input) {
      return !!clean(input.value);
    },
    async harvestOptions(input) {
      if (AF.oracle.cx.autoSuggest(input)) return [];
      const all = await AF.oracle.cx.options(input, MAX_OPTIONS + 1);
      // A list too long to send (countries, dialing codes) is answered as text and found by search when written.
      return all.length > MAX_OPTIONS ? [] : all;
    },
    async write(input, answer) {
      const want = answer.option || answer.value || (Array.isArray(answer.option_values) ? answer.option_values[0] : "");
      if (!want) return false;
      return AF.oracle.cx.pick(input, String(want));
    },
  });

  AF.registerDriver({
    type: "oracle-pills",
    priority: 12,
    match(el) {
      if (!applies() || !el) return null;
      const ul = el.matches && el.matches("ul.cx-select-pills-container") ? el : el.closest && el.closest("ul.cx-select-pills-container");
      if (!ul) return null;
      if (AF.oracle.shouldSkipControl(ul)) return null;
      return ul;
    },
    consumes(ul) {
      return [...ul.querySelectorAll("button")];
    },
    cidEl(ul) {
      return ul;
    },
    extract(ul) {
      const row = rowOf(ul);
      const label = clean(ul.getAttribute("aria-label") || "") || rowLabel(row, ul);
      return {
        kind: "select",
        label,
        required: rowRequired(row, ul),
        multi: ul.getAttribute("role") === "list",
        options: AF.oracle.pills.buttons(ul).filter((b) => !b.disabled).map(AF.oracle.pills.text).filter(Boolean),
      };
    },
    isFilled(ul) {
      return AF.oracle.pills.buttons(ul).some(AF.oracle.pills.selected);
    },
    async write(ul, answer) {
      const wants = Array.isArray(answer.option_values) && answer.option_values.length ? answer.option_values : [answer.option || answer.value || ""];
      return AF.oracle.pills.pick(ul, wants.filter(Boolean));
    },
  });
})();
