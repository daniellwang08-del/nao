// Oracle Recruiting Cloud, Candidate Experience (<pod>.fa.<dc>.oraclecloud.com/hcmUI/CandidateExperience/...).
//
// Read from the live site (edqv.fa.us2 / GCI job 21003622, 2026-11-12) and Oracle's own bundle
// (static.oracle.com/cdn/fa/oj-hcm-ce/<ver>/js/main-minimal.js):
//   posting   .../job/<id>: button.apply-now-button ("Apply Now")
//   email     .../job/<id>/apply/email: input[name=primary-email], a honeypot input[name=honey-pot] in a zero-height
//             .input-row--invisible row (must stay empty), "I agree with the terms and conditions"
//             (input#legal-disclaimer-checkbox.input-row__hidden-control, 0x0 + opacity 0, Knockout `checked`),
//             footer.apply-flow-pagination__buttons button[type=submit] "Next"
//   pin       "Confirm Your Identity": six input.pin-code-input__input (#pin-code-1..6, valueUpdate 'input', a paste
//             handler spreads a pasted code), "Verify", "Send New Code"
//   flow      sections ("Personal Info", "Job Application Questions", "Experience", "More About You", ...), one per
//             page with BACK, page numbers (.apply-flow-navigation-pages__link--current) and NEXT
//             ([data-qa=applyFlowPaginationNextButton]); the last one has Submit (.apply-flow-pagination__submit-button,
//             the candidate's). Single-click flows show every section on one page with Submit only.
//   blocks    .apply-flow-block: profile import (input.apply-flow-profile-import-awli__file-upload; "Profile
//             successfully imported."), contact info, address (geo-hierarchy cx-selects), questions (cx-select-pills),
//             education / experience tiles (article.apply-flow-profile-item-tile: hover pencil
//             .apply-flow-profile-item-tile__edit-item-icon, .apply-flow-profile-item-tile__delete-icon, "Fields to
//             fix: N"; button.apply-flow-profile-item-tile__new-tile "Add Education" / "Add Experience"; the edit form
//             opens inline in .profile-item-content with .cancel-btn / .save-btn), documents, diversity, e-signature.
//   widgets   cx-select (React): input.cx-select-input[role=combobox], list #<id>-listbox .cx-select__list-item
//             (filters only while the input has focus; async lists debounce 500 ms); cx-select-pills (React):
//             ul.cx-select-pills-container (role radiogroup = one choice, list = many) of button.cx-select-pill-section.
(() => {
  const AF = window.__AF;
  if (!AF || !AF.dom || AF.oracle) return;
  const { clean, normText, isVisible, delay, waitUntil, setNativeValue } = AF.dom;

  function isOraclePage() {
    try {
      return /\/hcmUI\/CandidateExperience\//i.test(location.pathname);
    } catch {
      return false;
    }
  }

  const textOf = (el) => clean((el && (el.innerText || el.textContent)) || "");

  function shown(el) {
    if (!el || !isVisible(el)) return false;
    try {
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none";
    } catch {
      return true;
    }
  }

  // A visually hidden input (Oracle's .input-row__hidden-control: 0x0, opacity 0) counts as shown when its styled
  // label is.
  function controlShown(el) {
    if (!el) return false;
    if (shown(el)) return true;
    const lab = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label");
    return !!(lab && shown(lab));
  }

  const enabled = (b) => !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";

  function buttonByText(re, scope = document) {
    return (
      [...scope.querySelectorAll("button, a[role=button], [role=button]")].find(
        (b) => shown(b) && (re.test(textOf(b)) || re.test(clean(b.getAttribute("aria-label") || "")) || re.test(clean(b.getAttribute("title") || ""))) && enabled(b)
      ) || null
    );
  }

  function mouse(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // Announce focus/blur ourselves: a background tab fires no focus events, and Knockout's hasFocus / value
  // bindings and React's focus handlers listen for them.
  function focusIn(el) {
    try {
      el.focus({ preventScroll: true });
    } catch {}
    try {
      if (!document.hasFocus() || document.activeElement !== el) {
        el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("focus"));
      }
    } catch {}
  }

  function focusOut(el) {
    try {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur"));
    } catch {}
    try {
      el.blur();
    } catch {}
  }

  // Knockout text: `value` binding commits on change (blur), `textInput` on input.
  async function typeText(el, value) {
    if (!el) return false;
    const v = value == null ? "" : String(value);
    focusIn(el);
    setNativeValue(el, v);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    focusOut(el);
    await delay(60);
    return clean(el.value) === clean(v);
  }

  // ── cx-select (React combobox) ───────────────────────────────────────────────

  function isCxInput(el) {
    return !!el && el.tagName === "INPUT" && el.classList.contains("cx-select-input");
  }

  function cxList(input) {
    const id = input && input.getAttribute("aria-controls");
    return (id && document.getElementById(id)) || null;
  }

  function cxItems(input) {
    const list = cxList(input);
    if (!list) return [];
    return [...list.querySelectorAll(".cx-select__list-item")].filter((o) => o.getAttribute("aria-disabled") !== "true");
  }

  const cxItemText = (o) => textOf(o.querySelector(".cx-select__list-item-container") || o);

  function cxLoading(input) {
    const list = cxList(input);
    return !!(list && (list.getAttribute("aria-busy") === "true" || list.querySelector(".cx-select__list-item--loading")));
  }

  function cxOpen(input) {
    return input && input.getAttribute("aria-expanded") === "true";
  }

  async function cxOpenList(input) {
    focusIn(input);
    mouse(input, "mousedown");
    mouse(input, "mouseup");
    input.click();
    await waitUntil(() => cxOpen(input) || cxItems(input).length, 1500, 60);
    await waitUntil(() => !cxLoading(input), 6000, 100);
    return cxOpen(input) || cxItems(input).length > 0;
  }

  async function cxClose(input) {
    if (cxOpen(input)) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      await waitUntil(() => !cxOpen(input), 800, 60);
    }
    focusOut(input);
    await delay(60);
  }

  function cxAutoSuggest(input) {
    return !!input && input.classList.contains("cx-select-input--auto-suggest");
  }

  // Comparable text: lowercase, no punctuation, "+1 (United States)" -> "+1 united states".
  const norm = (s) =>
    normText(String(s || ""))
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9+@ ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const ALIASES = {
    usa: "united states",
    us: "united states",
    "u s": "united states",
    "u s a": "united states",
    "united states of america": "united states",
    america: "united states",
    uk: "united kingdom",
    "great britain": "united kingdom",
  };

  // Best option for `want`: exact > alias > word-start > contains (the shortest wins ties).
  function bestText(options, want, textFn = (x) => x) {
    const w = norm(want);
    if (!w) return null;
    const wa = ALIASES[w] || w;
    const scored = [];
    for (const o of options) {
      const t = norm(textFn(o));
      if (!t) continue;
      const ta = ALIASES[t] || t;
      let score = 0;
      if (t === w || t === wa) score = 100;
      else if (ta === wa) score = 90;
      else if (t.startsWith(w + " ") || t.startsWith(wa + " ")) score = 70;
      else if (w.startsWith(t + " ")) score = 60;
      else if ((" " + t + " ").includes(" " + wa + " ") || (" " + t + " ").includes(" " + w + " ")) score = 55;
      else if (t.includes(w) || t.includes(wa)) score = 50;
      else if (w.includes(t) && t.length > 3) score = 40;
      if (score) scored.push({ o, score, len: t.length });
    }
    scored.sort((a, b) => b.score - a.score || a.len - b.len);
    return scored.length ? scored[0].o : null;
  }

  function searchTerms(want) {
    const w = clean(String(want || ""));
    const alias = ALIASES[norm(w)];
    const words = w.split(/\s+/);
    return [...new Set([w, alias, words.slice(0, 2).join(" "), words[0]].filter((t) => t && t.length >= 1))];
  }

  async function cxType(input, text) {
    focusIn(input);
    setNativeValue(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    // React debounces async lists by 500 ms; the list then shows a loading row.
    await delay(cxAutoSuggest(input) ? 650 : 120);
    await waitUntil(() => !cxLoading(input), 6000, 100);
    await delay(80);
  }

  async function cxClickItem(input, item) {
    try {
      item.scrollIntoView({ block: "nearest" });
    } catch {}
    const label = cxItemText(item);
    mouse(item, "mousedown");
    mouse(item, "mouseup");
    item.click();
    await waitUntil(() => !cxOpen(input) || norm(input.value) === norm(label), 1500, 60);
    return label;
  }

  // Choose `want` in a cx-select. `match(options)` may pick the option itself (dates, degrees); otherwise the closest
  // text wins. Free-text (auto-suggest) inputs keep the typed text when no suggestion fits.
  async function cxPick(input, want, { match = null, freeText = null } = {}) {
    if (!input || want == null || want === "") return false;
    if (input.readOnly || input.disabled) return false;
    const chooser = (items) => (match ? match(items, cxItemText) : bestText(items, want, cxItemText));
    const current = clean(input.value);
    if (current && !cxAutoSuggest(input) && chooser([{ textContent: current, innerText: current, querySelector: () => null }])) {
      return true;
    }
    const allowFree = freeText == null ? cxAutoSuggest(input) : freeText;
    let item = null;
    if (!cxAutoSuggest(input) && (await cxOpenList(input))) item = chooser(cxItems(input));
    if (!item) {
      for (const term of searchTerms(want)) {
        await cxType(input, term);
        item = chooser(cxItems(input));
        if (item || allowFree) break;
      }
    }
    if (item) {
      await cxClickItem(input, item);
      await cxClose(input);
      return !!clean(input.value);
    }
    if (allowFree) {
      await cxType(input, String(want));
      // Enter commits a typed value in a combobox (and picks a lone match).
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      await delay(150);
      await cxClose(input);
      return !!clean(input.value);
    }
    // Nothing matched: clear the search text so the select does not keep a half-typed value.
    if (clean(input.value) && clean(input.value) !== current) await cxType(input, current);
    await cxClose(input);
    return false;
  }

  async function cxOptions(input, max = 400) {
    if (!input || input.readOnly || input.disabled || cxAutoSuggest(input)) return [];
    if (!(await cxOpenList(input))) {
      await cxClose(input);
      return [];
    }
    const out = [];
    for (const o of cxItems(input)) {
      const t = cxItemText(o);
      if (t && !out.includes(t)) out.push(t);
      if (out.length >= max) break;
    }
    await cxClose(input);
    return out;
  }

  // ── cx-select-pills (Title, Yes/No questions) ───────────────────────────────

  function pillButtons(ul) {
    return ul ? [...ul.querySelectorAll("button.cx-select-pill-section")] : [];
  }

  const pillText = (b) => textOf(b.querySelector(".cx-select-pill-name") || b);
  const pillSelected = (b) => b.classList.contains("cx-select-pill-section--selected") || b.getAttribute("aria-checked") === "true" || b.getAttribute("aria-pressed") === "true";

  async function pickPill(ul, want) {
    const wants = (Array.isArray(want) ? want : [want]).filter((w) => w != null && String(w).trim());
    if (!ul || !wants.length) return false;
    const multi = ul.getAttribute("role") === "list";
    const btns = pillButtons(ul);
    let ok = true;
    for (const w of multi ? wants : wants.slice(0, 1)) {
      const b = bestText(btns, yesNo(w) || w, pillText);
      if (!b) {
        ok = false;
        continue;
      }
      if (!pillSelected(b)) {
        b.click();
        await waitUntil(() => pillSelected(b), 1200, 50);
      }
      ok = ok && pillSelected(b);
    }
    return ok;
  }

  function yesNo(v) {
    const s = norm(v);
    if (/^(yes|y|true|i do|i am|i have)$/.test(s)) return "Yes";
    if (/^(no|n|false|i do not|i am not|i have not)$/.test(s)) return "No";
    return null;
  }

  // ── stages ─────────────────────────────────────────────────────────────────

  function emailInput() {
    return [...document.querySelectorAll('input[name="primary-email"], input#primary-email-0')].find((i) => shown(i) && !i.readOnly) || null;
  }

  function legalCheckbox() {
    return document.getElementById("legal-disclaimer-checkbox") || null;
  }

  function pinInputs() {
    return [...document.querySelectorAll("input.pin-code-input__input")].filter(shown);
  }

  function nextButton() {
    const b = document.querySelector('[data-qa="applyFlowPaginationNextButton"]');
    return b && shown(b) ? b : null;
  }

  function submitButton() {
    const b = document.querySelector(".apply-flow-pagination__submit-button");
    return b && shown(b) ? b : null;
  }

  function gateNextButton() {
    const foot = [...document.querySelectorAll("footer.apply-flow-pagination__buttons, .apply-flow-pagination__buttons")].find(shown);
    if (foot) {
      const b = [...foot.querySelectorAll("button")].find((x) => shown(x) && (x.type === "submit" || /next/i.test(textOf(x) + " " + (x.getAttribute("title") || ""))));
      if (b) return b;
    }
    return buttonByText(/^next\b/i);
  }

  function blocks() {
    return [...document.querySelectorAll(".apply-flow-block")].filter(shown);
  }

  function blockTitle(block) {
    return textOf(block.querySelector(".apply-flow-block__title")) || "";
  }

  function currentSection() {
    const cur = document.querySelector(".apply-flow-navigation-pages__link--current");
    const all = [...document.querySelectorAll(".apply-flow-navigation-pages__link")];
    const number = cur ? parseInt(textOf(cur), 10) || all.indexOf(cur) + 1 : 0;
    return { number, total: all.length, title: (cur && clean(cur.getAttribute("title") || "")) || "" };
  }

  function visibleErrors(scope = document) {
    const out = [];
    const push = (t) => {
      t = clean(t);
      if (t && t.length < 220 && !out.includes(t)) out.push(t);
    };
    for (const row of scope.querySelectorAll(".input-row--invalid")) {
      if (!shown(row) && !row.querySelector(".input-row__validation")) continue;
      const lab = textOf(row.querySelector(".input-row__label, label, legend")) || clean(row.getAttribute("aria-label") || "");
      const msg = textOf(row.querySelector(".input-row__validation"));
      if (lab || msg) push(lab ? `${lab}: ${msg || "required"}` : msg);
    }
    for (const t of scope.querySelectorAll('[data-profile-item-invalid="true"]')) {
      if (!shown(t)) continue;
      const art = t.closest(".apply-flow-profile-item-tile");
      if (art) push(`${textOf(art.querySelector(".apply-flow-profile-item-tile__summary-title")) || "Item"}: ${textOf(art.querySelector(".apply-flow-profile-item-tile__summary-validation")) || "needs fixing"}`);
    }
    for (const e of scope.querySelectorAll(".apply-flow-pagination__error-message, .profile-inline-validation, .apply-flow-profile-import__validation")) {
      if (shown(e)) push(textOf(e));
    }
    return out.slice(0, 15);
  }

  function stage() {
    if (!isOraclePage()) return { kind: "none" };
    const text = textOf(document.body);
    const sec = currentSection();
    let kind = "unknown";
    if (/this job is no longer available|job (posting )?(has been|was|is) (closed|filled|removed)|no longer accepting applications/i.test(text) && !blocks().length) kind = "gone";
    else if (/you already applied for this job/i.test(text)) kind = "already-applied";
    else if (/thank you for (your|confirming your) job application/i.test(text) && !nextButton() && !submitButton()) kind = "submitted";
    else if (pinInputs().length >= 4) kind = "pin";
    else if (emailInput() && (legalCheckbox() || /\/apply\/email/i.test(location.pathname)) && !blocks().length) kind = "email";
    else if (/click the link in the email to confirm your identity/i.test(text) && !blocks().length) kind = "email-link";
    else if (blocks().length || nextButton() || submitButton()) kind = "flow";
    else if ([...document.querySelectorAll("button.apply-now-button, .apply-now-button")].some((b) => shown(b))) kind = "posting";
    const importInput = profileImportInput();
    return {
      kind,
      section: sec.number,
      sections: sec.total,
      title: sec.title,
      key: `${kind}|${sec.number}|${location.pathname}`,
      hasNext: !!nextButton(),
      hasSubmit: !!submitButton(),
      importAvailable: !!importInput && !importInput.disabled,
      imported: importSucceeded(),
      importing: importInProgress(),
      profileBlocks: profileBlocks().length,
      errors: kind === "flow" || kind === "email" || kind === "pin" ? visibleErrors() : [],
    };
  }

  async function waitForChange(beforeKey, timeoutMs) {
    let since = 0;
    const st = await waitUntil(() => {
      const now = stage();
      if (now.key !== beforeKey && now.kind !== "unknown") return now;
      if (now.errors.length) {
        since = since || Date.now();
        if (Date.now() - since > 1800) return now;
      } else since = 0;
      return null;
    }, timeoutMs, 250);
    return st || stage();
  }

  // ── gates ──────────────────────────────────────────────────────────────────

  async function apply() {
    const b = [...document.querySelectorAll("button.apply-now-button, .apply-now-button")].find((x) => shown(x) && enabled(x));
    if (!b) return { ok: false, error: "No Apply Now button." };
    const before = stage().key;
    b.click();
    return { ok: true, stage: await waitForChange(before, 20000) };
  }

  // "You don't need to have an account": the email, the terms checkbox, Next. The honeypot beside the email stays
  // empty (filling it marks the visit as a bot).
  async function emailGate(email, { pressNext = true } = {}) {
    const input = emailInput();
    if (!input) return { ok: false, error: "No email box on the page." };
    if (!email) return { ok: false, error: "No email in your profile." };
    if (clean(input.value).toLowerCase() !== clean(email).toLowerCase()) await typeText(input, email);
    const box = legalCheckbox();
    if (box && !box.checked) {
      box.click();
      await waitUntil(() => box.checked, 1500, 60);
    }
    // Ticking may open the terms dialog first; accept it.
    const agree = await waitUntil(() => {
      const d = [...document.querySelectorAll("oj-dialog, [role=dialog], .app-dialog")].find(shown);
      return d ? buttonByText(/^agree$/i, d) : null;
    }, 1200, 100);
    if (agree) {
      agree.click();
      await delay(400);
    }
    if (box && !box.checked) {
      box.click();
      await waitUntil(() => box.checked, 1500, 60);
    }
    const typed = clean(input.value).toLowerCase() === clean(email).toLowerCase();
    if (!typed) return { ok: false, error: "Could not enter the email." };
    if (box && !box.checked) return { ok: false, error: 'Could not tick "I agree with the terms and conditions".' };
    if (!pressNext) return { ok: true };
    const next = gateNextButton();
    if (!next || !enabled(next)) return { ok: false, error: "The Next button is not available." };
    const before = stage().key;
    next.click();
    const st = await waitForChange(before, 30000);
    return { ok: st.key !== before || st.kind !== "email", stage: st };
  }

  // The emailed verification code, one digit per box (Oracle's paste handler spreads a pasted code too).
  async function enterPin(code) {
    const boxes = pinInputs();
    const digits = String(code || "").replace(/\D/g, "");
    if (!boxes.length) return { ok: false, error: "No verification code boxes on the page." };
    if (digits.length < boxes.length) return { ok: false, error: "The code is too short." };
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      focusIn(b);
      setNativeValue(b, digits[i]);
      b.dispatchEvent(new InputEvent("input", { bubbles: true, data: digits[i], inputType: "insertText" }));
      b.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(40);
    }
    focusOut(boxes[boxes.length - 1]);
    await delay(250);
    const typed = pinInputs().map((b) => b.value).join("");
    if (typed !== digits.slice(0, boxes.length)) return { ok: false, error: "Could not type the code.", typed };
    const verify = await waitUntil(() => buttonByText(/^verify$/i), 4000, 100);
    if (!verify) return { ok: false, error: "No Verify button." };
    const before = stage().key;
    verify.click();
    const st = await waitForChange(before, 30000);
    return { ok: st.kind !== "pin", stage: st, errors: st.kind === "pin" ? visibleErrors() : [] };
  }

  // ── profile import (resume first) ──────────────────────────────────────────

  function profileImportInput() {
    return document.querySelector("input.apply-flow-profile-import-awli__file-upload") || null;
  }

  function importSucceeded() {
    const box = document.querySelector(".apply-flow-profile-import");
    return !!(box && (box.classList.contains("apply-flow-profile-import--success") || /profile successfully imported/i.test(textOf(box))));
  }

  function importFailed() {
    const box = document.querySelector(".apply-flow-profile-import");
    if (!box) return "";
    const v = [...box.querySelectorAll(".input-row__validation, .apply-flow-profile-import__validation")].filter(shown).map(textOf).filter(Boolean);
    return v.join(" ");
  }

  function importInProgress() {
    const box = document.querySelector(".apply-flow-profile-import");
    return !!(box && /parsing|importing|uploading/i.test(textOf(box)) && !importSucceeded());
  }

  async function importResume({ name, type, b64 }, { timeoutMs = 90000 } = {}) {
    if (importSucceeded()) return { ok: true, already: true };
    const input = profileImportInput();
    if (!input) return { ok: false, error: "No resume import on this page." };
    const bin = atob(b64 || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name || "resume.pdf", { type: type || "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const outcome = await waitUntil(() => {
      if (importSucceeded()) return { ok: true };
      const err = importFailed();
      if (err) return { ok: false, error: err };
      return null;
    }, timeoutMs, 300);
    if (!outcome) return { ok: false, error: "The resume import did not finish in time." };
    if (outcome.ok) await delay(1500); // the parsed profile settles into the blocks below
    return outcome;
  }

  // ── education / experience tiles ───────────────────────────────────────────

  // Each profile-item block: its kind (from the block title or the Add button), its tiles and its open form.
  function profileBlocks() {
    return [...document.querySelectorAll(".profile-item-container")].filter((c) => shown(c) || c.querySelector(".apply-flow-profile-item-tile__new-tile, .profile-item-content"));
  }

  function blockKind(container) {
    const block = container.closest(".apply-flow-block");
    const add = container.querySelector(".apply-flow-profile-item-tile__new-tile");
    const t = `${blockTitle(block || container)} ${textOf(add)}`.toLowerCase();
    if (/education|school|degree/.test(t)) return "education";
    if (/experience|employment|work history|job/.test(t)) return "experience";
    if (/licen[cs]e|certif/.test(t)) return "certification";
    if (/language/.test(t)) return "language";
    if (/skill/.test(t)) return "skill";
    return "other";
  }

  function tiles(container) {
    return [...container.querySelectorAll("article.apply-flow-profile-item-tile")];
  }

  function tileInfo(tile, index) {
    return {
      index,
      title: textOf(tile.querySelector(".apply-flow-profile-item-tile__summary-title")),
      subtitle: textOf(tile.querySelector(".apply-flow-profile-item-tile__summary-subtitle")),
      invalid: tile.classList.contains("apply-flow-profile-item-tile--invalid") || !!tile.querySelector('[data-profile-item-invalid="true"]'),
      issues: textOf(tile.querySelector(".apply-flow-profile-item-tile__summary-validation")),
      readOnly: tile.classList.contains("apply-flow-profile-item-tile--readonly"),
      done: tile.getAttribute("data-af-oracle-done") === "1",
    };
  }

  function listProfileItems() {
    return profileBlocks().map((c, block) => ({
      block,
      kind: blockKind(c),
      title: blockTitle(c.closest(".apply-flow-block") || c),
      canAdd: !!c.querySelector(".apply-flow-profile-item-tile__new-tile"),
      editing: !!c.querySelector(".profile-item-content"),
      tiles: tiles(c).map(tileInfo),
    }));
  }

  function formOf(container) {
    return container.querySelector(".profile-item-content") || null;
  }

  async function openTile(blockIndex, tileIndex) {
    const c = profileBlocks()[blockIndex];
    if (!c) return { ok: false, error: "No such block." };
    if (formOf(c)) return { ok: false, error: "Another entry is open in this block." };
    const tile = tiles(c)[tileIndex];
    if (!tile) return { ok: false, error: "No such entry." };
    // The pencil shows on hover; the button is in the DOM either way.
    mouse(tile, "mouseover");
    const edit = tile.querySelector(".apply-flow-profile-item-tile__edit-item-icon, .apply-flow-profile-item-tile__view-icon");
    if (!edit) return { ok: false, error: "This entry cannot be edited." };
    // Handled once per run, whatever the outcome (Oracle keeps the tile element across re-renders).
    tile.setAttribute("data-af-oracle-done", "1");
    edit.click();
    const form = await waitUntil(() => formOf(c), 5000, 100);
    if (!form) return { ok: false, error: "The entry did not open." };
    await delay(400);
    return { ok: true };
  }

  async function addTile(blockIndex) {
    const c = profileBlocks()[blockIndex];
    if (!c) return { ok: false, error: "No such block." };
    if (formOf(c)) return { ok: false, error: "Another entry is open in this block." };
    const add = c.querySelector(".apply-flow-profile-item-tile__new-tile");
    if (!add || !enabled(add)) return { ok: false, error: "This block cannot take another entry." };
    c.__afBeforeAdd = new Set(tiles(c));
    add.click();
    const form = await waitUntil(() => formOf(c), 5000, 100);
    if (!form) return { ok: false, error: "The new entry form did not open." };
    await delay(400);
    return { ok: true };
  }

  async function deleteTile(blockIndex, tileIndex) {
    const c = profileBlocks()[blockIndex];
    const tile = c && tiles(c)[tileIndex];
    if (!tile) return { ok: false, error: "No such entry." };
    const before = tiles(c).length;
    mouse(tile, "mouseover");
    const del = tile.querySelector(".apply-flow-profile-item-tile__delete-icon");
    if (!del) return { ok: false, error: "This entry cannot be removed." };
    del.click();
    // Oracle removes the tile about a second after the click.
    const gone = await waitUntil(() => tiles(c).length < before, 5000, 100);
    return { ok: !!gone };
  }

  async function saveTile(blockIndex) {
    const c = profileBlocks()[blockIndex];
    const form = c && formOf(c);
    if (!form) return { ok: false, error: "No open entry." };
    const save = c.querySelector(".profile-item-footer .save-btn") || buttonByText(/^(save|add (education|experience)|done)/i, c);
    if (!save) return { ok: false, error: "No Save button." };
    save.click();
    const done = await waitUntil(() => {
      if (!formOf(c)) return { ok: true };
      const errs = visibleErrors(formOf(c));
      const footErr = textOf(c.querySelector(".profile-item-errors"));
      if (footErr) errs.push(footErr);
      return null;
    }, 15000, 200);
    if (done) {
      await delay(300);
      // A saved new entry: its tile is the one that was not there before Add.
      if (c.__afBeforeAdd) {
        for (const t of tiles(c)) if (!c.__afBeforeAdd.has(t)) t.setAttribute("data-af-oracle-done", "1");
        c.__afBeforeAdd = null;
      }
      return { ok: true };
    }
    const f = formOf(c);
    const errors = f ? visibleErrors(f) : [];
    const footErr = textOf(c.querySelector(".profile-item-errors"));
    if (footErr) errors.push(footErr);
    return { ok: false, errors: errors.length ? errors : ["The entry was not saved."] };
  }

  async function cancelTile(blockIndex) {
    const c = profileBlocks()[blockIndex];
    if (!c || !formOf(c)) return { ok: true };
    const cancel = c.querySelector(".profile-item-footer .cancel-btn");
    c.__afBeforeAdd = null;
    if (cancel) cancel.click();
    await waitUntil(() => !formOf(c), 3000, 100);
    return { ok: !formOf(c) };
  }

  // ── fill an open entry from one resume entry ───────────────────────────────

  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  // "06/2019" | "2019-06" | "2019" -> { month: 6, year: 2019 }
  function parseMonthYear(s) {
    const t = clean(String(s || ""));
    if (!t) return null;
    let m = t.match(/^(\d{1,2})\s*[/.-]\s*(\d{4})$/);
    if (m) return { month: +m[1], year: +m[2] };
    m = t.match(/^(\d{4})\s*[/.-]\s*(\d{1,2})/);
    if (m) return { month: +m[2], year: +m[1] };
    m = t.match(/^([a-z]{3,9})\.?\s+(\d{4})$/i);
    if (m) {
      const i = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
      if (i >= 0) return { month: i + 1, year: +m[2] };
    }
    m = t.match(/^(\d{4})$/);
    if (m) return { month: 0, year: +m[1] };
    return null;
  }

  // Month option for a number: "June", "Jun", "06", "6".
  function monthMatcher(month) {
    return (items, textFn) => {
      for (const it of items) {
        const t = norm(textFn(it));
        if (!t) continue;
        if (t === MONTHS[month - 1] || t === MONTHS[month - 1].slice(0, 3)) return it;
        if (/^\d{1,2}$/.test(t) && +t === month) return it;
        if (t.startsWith(MONTHS[month - 1].slice(0, 3) + " ")) return it;
      }
      return null;
    };
  }

  const exactMatcher = (want) => (items, textFn) => items.find((it) => norm(textFn(it)) === norm(want)) || null;

  // Degree level of free text (resume "B.S. Computer Science", option "Bachelor's Degree").
  function degreeLevel(s) {
    const t = ` ${norm(s).replace(/\./g, "")} `;
    if (/\b(phd|ph d|doctor|doctorate|dphil|edd|md|jd)\b/.test(t)) return "doctorate";
    if (/\b(master|masters|ms|msc|ma|mba|meng|mfa|mph|mpa|mcs|m s|m a)\b/.test(t)) return "master";
    if (/\b(bachelor|bachelors|bs|bsc|ba|beng|btech|bba|be|b s|b a|undergraduate)\b/.test(t)) return "bachelor";
    if (/\b(associate|associates|aa|as|aas)\b/.test(t)) return "associate";
    if (/\b(high school|ged|secondary|diploma)\b/.test(t)) return "highschool";
    if (/\b(certificate|certification)\b/.test(t)) return "certificate";
    return "";
  }

  function degreeMatcher(degree) {
    const lvl = degreeLevel(degree);
    return (items, textFn) => {
      const exact = bestText(items, degree, textFn);
      if (exact && norm(textFn(exact)) === norm(degree)) return exact;
      if (lvl) {
        const same = items.filter((it) => degreeLevel(textFn(it)) === lvl);
        if (same.length) return same.sort((a, b) => norm(textFn(a)).length - norm(textFn(b)).length)[0];
      }
      return exact;
    };
  }

  // The controls of an open entry, each with its label.
  function formControls(form) {
    const out = [];
    for (const row of form.querySelectorAll(".input-row, .datepicker-row")) {
      if (row.parentElement && row.parentElement.closest(".datepicker-row")) continue;
      const lab =
        textOf(row.querySelector(":scope > form-element-label .input-row__label, :scope > label.input-row__label, :scope > .input-row__label, label.input-row__label")) ||
        clean(row.getAttribute("aria-label") || "") ||
        textOf(row.querySelector(".apply-flow-input-checkbox__label, .input-row__label, label, legend"));
      const label = lab.replace(/\*+$/, "").trim();
      const cx = [...row.querySelectorAll("input.cx-select-input")];
      const pills = row.querySelector("ul.cx-select-pills-container");
      const text = row.querySelector("input.input-row__control:not(.cx-select-input):not([type=checkbox]):not([type=radio]), textarea");
      const checks = [...row.querySelectorAll("input[type=checkbox], input[type=radio]")];
      out.push({ row, label, cx, pills, text, checks, date: row.classList.contains("datepicker-row") });
    }
    return out;
  }

  // Location parts of a resume line "Seattle, WA" / "Seattle, Washington, United States".
  function splitLocation(loc) {
    const parts = clean(loc || "").split(/\s*,\s*/).filter(Boolean);
    return { city: parts[0] || "", state: parts.length >= 2 ? parts[1] : "", country: parts.length >= 3 ? parts[parts.length - 1] : "" };
  }

  async function writeDate(field, my) {
    if (!my) return false;
    const month = field.cx.find((i) => /month/i.test(`${i.getAttribute("aria-label") || ""} ${i.name || ""} ${i.id || ""} ${i.placeholder || ""}`));
    const year = field.cx.find((i) => /year/i.test(`${i.getAttribute("aria-label") || ""} ${i.name || ""} ${i.id || ""} ${i.placeholder || ""}`));
    const day = field.cx.find((i) => /\bday\b/i.test(`${i.getAttribute("aria-label") || ""} ${i.id || ""}`));
    const yearText = field.row.querySelector("input:not(.cx-select-input)");
    let ok = true;
    if (month && my.month) ok = (await cxPick(month, MONTHS[my.month - 1], { match: monthMatcher(my.month) })) && ok;
    if (day) ok = (await cxPick(day, "1", { match: exactMatcher("1") })) && ok;
    if (year) ok = (await cxPick(year, String(my.year), { match: exactMatcher(String(my.year)) })) && ok;
    else if (yearText) ok = (await typeText(yearText, String(my.year))) && ok;
    return ok;
  }

  async function setCheck(input, on) {
    if (!input || input.checked === !!on) return true;
    input.click();
    await waitUntil(() => input.checked === !!on, 1000, 50);
    return input.checked === !!on;
  }

  // Write one resume entry into the open form. Returns which labels were written and which the form left over.
  async function fillEntry(blockIndex, kind, entry, { country = "", fallbackCity = "", fallbackState = "" } = {}) {
    const c = profileBlocks()[blockIndex];
    const form = c && formOf(c);
    if (!form) return { ok: false, error: "No open entry." };
    entry = entry || {};
    const loc = splitLocation(entry.location);
    const start = parseMonthYear(entry.startMMYYYY || entry.start);
    const end = entry.current ? null : parseMonthYear(entry.endMMYYYY || entry.end);
    const wrote = [];
    const skipped = [];
    const fields = formControls(form);
    const isCurrentField = (f) => /current|present|i currently|still (work|attend)/i.test(f.label);

    for (const f of fields) {
      const L = f.label.toLowerCase();
      let value = null;
      let kindOf = "text";
      if (f.date) {
        if (/start|from|begin/.test(L)) value = start;
        else if (/end|to\b|until|complet|graduat|finish/.test(L)) value = end;
        else value = kind === "education" ? end : start;
        if (value && (await writeDate(f, value))) wrote.push(f.label);
        else if (value) skipped.push(f.label);
        continue;
      }
      if (kind === "experience") {
        if (isCurrentField(f)) {
          kindOf = "bool";
          value = !!entry.current;
        } else if (/job title|position|^title$|role/.test(L)) value = entry.title;
        else if (/employer|company|organi[sz]ation/.test(L) && !/phone|address|city|state|country/.test(L)) value = entry.company;
        else if (/responsib|description|duties|summary|achievement|accomplish/.test(L)) value = entry.description;
        else if (/country/.test(L)) value = loc.country || country;
        else if (/state|province|region/.test(L)) {
          value = stateName(loc.state || fallbackState);
          kindOf = "state";
        }
        else if (/city|town|location/.test(L)) value = loc.city || fallbackCity;
      } else if (kind === "education") {
        if (/degree|qualification|level/.test(L) && !/area|field|major/.test(L)) {
          value = entry.degree;
          kindOf = "degree";
        } else if (/school|institution|university|college|establishment/.test(L)) value = entry.school;
        else if (/area of study|major|field of study|discipline|specialization|program/.test(L)) value = entry.fieldOfStudy;
        else if (/minor/.test(L)) value = null;
        else if (/average grade|gpa|grade point/.test(L)) value = entry.gpa;
        else if (isCurrentField(f)) {
          kindOf = "bool";
          value = !end && !!start;
        } else if (/graduated|degree (completed|obtained)|completed/.test(L)) {
          kindOf = "bool";
          value = !!end && new Date(end.year, Math.max(0, (end.month || 12) - 1), 28) <= new Date();
        } else if (/status/.test(L)) {
          value = end && new Date(end.year, Math.max(0, (end.month || 12) - 1), 28) <= new Date() ? "Completed" : "In Progress";
        } else if (/country/.test(L)) value = country;
      } else if (kind === "certification") {
        if (/name|title|license|certificat/.test(L) && !/number|issuer|issued by|authority/.test(L)) value = entry.name || entry.title;
        else if (/issu|authority|organi[sz]ation/.test(L)) value = entry.issuer;
      }
      if (value == null || value === "") {
        if (f.text || f.cx.length || f.pills || f.checks.length) skipped.push(f.label);
        continue;
      }
      let ok = false;
      if (kindOf === "bool") {
        if (f.pills) ok = await pickPill(f.pills, value ? "Yes" : "No");
        else if (f.checks.length === 1 && f.checks[0].type === "checkbox") ok = await setCheck(f.checks[0], value);
        else if (f.cx.length) ok = await cxPick(f.cx[0], value ? "Yes" : "No");
      } else if (f.cx.length) {
        const opts = kindOf === "degree" ? { match: degreeMatcher(String(value)) } : kindOf === "state" ? { match: stateMatcher(String(value)) } : {};
        ok = await cxPick(f.cx[0], String(value), opts);
      } else if (f.pills) {
        ok = await pickPill(f.pills, String(value));
      } else if (f.text) {
        ok = await typeText(f.text, String(value));
      }
      (ok ? wrote : skipped).push(f.label);
      await delay(60);
    }
    return { ok: true, wrote, skipped };
  }

  // ── phone, address, e-signature ────────────────────────────────────────────

  function phoneRow(scope = document) {
    return [...scope.querySelectorAll(".phone-row")].find(shown) || null;
  }

  // "+1 (United States)"-style prefix select and the national number.
  async function setPhone({ countryCode = "1", national = "", country = "United States" } = {}) {
    const row = phoneRow();
    if (!row) return { ok: false, present: false };
    const container = row.closest(".input-row") || row;
    // A verified phone shows read-only behind an edit pencil.
    let tel = row.querySelector("input[type=tel]");
    if (tel && tel.readOnly) {
      const edit = container.parentElement && container.parentElement.querySelector(".communication-channel__value-phone-edit");
      if (edit) {
        edit.click();
        await waitUntil(() => !row.querySelector("input[type=tel]").readOnly, 2000, 100);
        tel = row.querySelector("input[type=tel]");
      }
    }
    if (!tel || tel.readOnly) return { ok: false, present: true, error: "The phone number is locked." };
    const prefix = row.querySelector("input.cx-select-input");
    let prefixOk = true;
    if (prefix) {
      const cc = String(countryCode || "1").replace(/\D/g, "") || "1";
      const countryWord = norm(country) && (ALIASES[norm(country)] || norm(country));
      prefixOk = await cxPick(prefix, country || `+${cc}`, {
        match: (items, textFn) => {
          const withCode = items.filter((it) => new RegExp(`(^|\\D)\\+?${cc}(\\D|$)`).test(textFn(it)));
          const byCountry = withCode.find((it) => countryWord && norm(textFn(it)).includes(countryWord));
          return byCountry || (withCode.length === 1 ? withCode[0] : null) || bestText(items, country, textFn);
        },
      });
    }
    const digits = String(national || "").replace(/\D/g, "");
    const numOk = digits ? await typeText(tel, digits) : false;
    const after = String(tel.value || "").replace(/\D/g, "");
    return { ok: prefixOk && numOk && after.endsWith(digits.slice(-7)), present: true, prefix: prefix ? prefix.value : "", number: tel.value };
  }

  function addressBlock() {
    return blocks().find((b) => /address/i.test(blockTitle(b)) || b.querySelector(".geo-hierarchy-form-element")) || null;
  }

  function rowByLabel(scope, re) {
    for (const row of scope.querySelectorAll(".input-row")) {
      const lab = textOf(row.querySelector("label, .input-row__label")).replace(/\*+$/, "").trim();
      if (re.test(lab)) return row;
    }
    return null;
  }

  // Country, street lines, then the postal code (Oracle's suggestion "98030, Kent, King, WA" fills city, county and
  // state together); city and state are written directly when no suggestion fits.
  async function setAddress({ country = "", line1 = "", line2 = "", city = "", state = "", postalCode = "" } = {}) {
    const block = addressBlock();
    if (!block) return { ok: false, present: false };
    const done = {};
    const countryRow = rowByLabel(block, /^country$/i);
    const countryInput = countryRow && countryRow.querySelector("input.cx-select-input");
    if (countryInput && country) {
      done.country = await cxPick(countryInput, country);
      await delay(600); // the address format re-renders for the country
    }
    const fresh = addressBlock() || block;
    const l1 = rowByLabel(fresh, /address line 1|street|^address$/i);
    if (l1 && line1) done.line1 = await typeText(l1.querySelector("input, textarea"), line1);
    const l2 = rowByLabel(fresh, /address line 2/i);
    if (l2) {
      const i2 = l2.querySelector("input, textarea");
      if (i2 && (line2 || clean(i2.value))) done.line2 = await typeText(i2, line2 || "");
    }
    const l3 = rowByLabel(fresh, /address line 3/i);
    if (l3) {
      const i3 = l3.querySelector("input, textarea");
      if (i3 && clean(i3.value)) done.line3 = await typeText(i3, "");
    }
    const stateAbbr = US_STATES[norm(state)] || (/^[A-Za-z]{2}$/.test(state) ? state.toUpperCase() : "");
    const placeMatcher = (items, textFn) => {
      const want = items.filter((it) => {
        const t = ` ${norm(textFn(it))} `;
        return (!city || t.includes(` ${norm(city)} `)) && (!state || t.includes(` ${norm(state)} `) || (stateAbbr && t.includes(` ${stateAbbr.toLowerCase()} `)));
      });
      return want[0] || null;
    };
    const postalRow = rowByLabel(fresh, /postal|zip/i);
    const postalInput = postalRow && postalRow.querySelector("input.cx-select-input, input");
    if (postalInput && postalCode) {
      done.postal = postalInput.classList.contains("cx-select-input") ? await cxPick(postalInput, postalCode, { match: placeMatcher, freeText: true }) : await typeText(postalInput, postalCode);
      await delay(500);
    }
    const cityRow = rowByLabel(fresh, /^(city|town)/i);
    const cityInput = cityRow && cityRow.querySelector("input.cx-select-input, input");
    if (cityInput && city && norm(cityInput.value) !== norm(city)) {
      done.city = cityInput.classList.contains("cx-select-input") ? await cxPick(cityInput, city, { match: placeMatcher, freeText: true }) : await typeText(cityInput, city);
      await delay(400);
    } else if (cityInput) done.city = !!clean(cityInput.value);
    const stateRow = rowByLabel(fresh, /^(state|province|region)/i);
    const stateInput = stateRow && stateRow.querySelector("input.cx-select-input, input");
    if (stateInput && state && !stateMatches(stateInput.value, state, stateAbbr)) {
      done.state = stateInput.classList.contains("cx-select-input")
        ? await cxPick(stateInput, stateName(state), { match: stateMatcher(state) })
        : await typeText(stateInput, state);
    } else if (stateInput) done.state = !!clean(stateInput.value);
    const ok = Object.values(done).every(Boolean);
    return { ok, present: true, done };
  }

  // "WA", "Washington" and "Washington (WA)" are the same state.
  function stateMatches(text, state, abbr) {
    const t = norm(text);
    if (!t) return false;
    const a = (abbr || US_STATES[norm(state)] || (/^[A-Za-z]{2}$/.test(state || "") ? state.toUpperCase() : "")).toLowerCase();
    const full = norm(stateName(state));
    return t === norm(state) || t === full || (!!a && (t === a || t.split(" ").includes(a))) || (!!full && full.length > 2 && t.startsWith(full + " "));
  }

  // Full name of a US state abbreviation ("WA" -> "Washington"); anything else as given.
  function stateName(s) {
    const v = clean(s || "");
    if (!/^[A-Za-z]{2}$/.test(v)) return v;
    const k = Object.keys(US_STATES).find((n) => US_STATES[n] === v.toUpperCase());
    return k ? k.replace(/\b\w/g, (c) => c.toUpperCase()) : v;
  }

  const stateMatcher = (state) => (items, textFn) => items.find((it) => stateMatches(textFn(it), state)) || null;

  const US_STATES = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
    "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
    mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
    pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
    vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  };

  function esignInput() {
    const box = [...document.querySelectorAll(".apply-flow-esign, .esign-form")].find(shown);
    if (!box) return null;
    return [...box.querySelectorAll("input")].find((i) => shown(i) && !/checkbox|radio|hidden/i.test(i.type || "")) || null;
  }

  async function sign(fullName) {
    const input = esignInput();
    if (!input) return { ok: false, present: false };
    if (!fullName) return { ok: false, present: true, error: "No name in your profile." };
    if (clean(input.value) !== clean(fullName)) await typeText(input, fullName);
    return { ok: clean(input.value) === clean(fullName), present: true };
  }

  // ── navigation ─────────────────────────────────────────────────────────────

  async function next({ timeoutMs = 25000 } = {}) {
    const before = stage();
    const b = await waitUntil(() => {
      const x = nextButton();
      return x && enabled(x) ? x : null;
    }, 8000, 200);
    if (!b) return { advanced: false, stage: before, errors: before.hasSubmit ? [] : ["The Next button is not available."].concat(visibleErrors()), last: before.hasSubmit };
    b.click();
    const st = await waitForChange(before.key, timeoutMs);
    if (st.key !== before.key) {
      await delay(900); // the next section mounts its blocks
      try {
        window.scrollTo(0, 0);
      } catch {}
      return { advanced: true, stage: stage() };
    }
    return { advanced: false, stage: st, errors: visibleErrors() };
  }

  // ── engine hooks ───────────────────────────────────────────────────────────

  // Controls the generic fill must leave alone: the honeypot, the page shell (search, chat assistant, menus), the
  // email gate and code (handled above), the profile import, entries edited by fillEntry, read-only values (the
  // verified email), the phone and address when written above, the e-signature, and marketing opt-ins.
  function shouldSkipControl(el) {
    if (!isOraclePage() || !el) return false;
    try {
      if (el.closest('[data-af-oracle-owned="1"]')) return true;
      if (el.closest(".input-row--invisible") || /honey/i.test(el.name || el.id || "")) return true;
      if (el.closest(".apply-flow-profile-import, .profile-item-content, .pin-code-input, legal-disclaimer, .app-header, .app-menu, header, oda-chat-widget, .oda-chat-wrapper, [class*='ai-assistant'], .search-box, .cookie-consent")) return true;
      if (/oda-work-summary|copy-link/i.test(el.id || "")) return true;
      if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.readOnly && !el.classList.contains("cx-select-input")) return true;
      if (el.closest(".apply-flow-esign, .esign-form")) return true;
      const wrap = textOf(el.closest(".input-row, label") || el.parentElement);
      if (/marketing communications|receive (job alerts|marketing|promotional)|talent community/i.test(wrap)) return true;
    } catch {}
    return false;
  }

  // Hidden-control checkboxes and radios count as fillable when their styled label shows.
  function hasVisibleProxy(el) {
    return isOraclePage() && !!el && el.classList && el.classList.contains("input-row__hidden-control") && controlShown(el);
  }

  // The open section (multi-page flows) or the whole application (single-page flows).
  function applicationRoot() {
    const st = stage();
    if (st.kind !== "flow") return null;
    return (
      [...document.querySelectorAll(".apply-flow__content-form, .apply-flow__content, .apply-flow-content")].find(shown) ||
      [...document.querySelectorAll(".apply-flow")].find(shown) ||
      document.body
    );
  }

  // Mark a block written deterministically so the generic pass skips it.
  function markOwned(which) {
    let el = null;
    if (which === "address") el = addressBlock();
    else if (which === "phone") {
      const r = phoneRow();
      el = r && (r.closest(".input-row") || r);
    }
    if (el) el.setAttribute("data-af-oracle-owned", "1");
    return !!el;
  }

  AF.oracle = {
    isOraclePage,
    stage,
    apply,
    emailGate,
    enterPin,
    importResume,
    listProfileItems,
    openTile,
    addTile,
    deleteTile,
    saveTile,
    cancelTile,
    fillEntry,
    setPhone,
    setAddress,
    sign,
    next,
    visibleErrors,
    shouldSkipControl,
    hasVisibleProxy,
    applicationRoot,
    markOwned,
    // widgets, for the drivers
    cx: { isCxInput, pick: cxPick, options: cxOptions, autoSuggest: cxAutoSuggest },
    pills: { buttons: pillButtons, text: pillText, selected: pillSelected, pick: pickPill },
    _test: { parseMonthYear, degreeLevel, bestText, norm, splitLocation },
  };
})();
