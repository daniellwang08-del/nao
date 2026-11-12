// Dayforce (jobs.dayforcehcm.com) candidate portal: a React app on Ant Design.
//
// Itinerary (live, Diversified posting 21538, 2026-11-11):
//   posting  /jobs/<id>                        "Apply"
//   choice   /jobs/<id>/apply?flowSelection=true "Apply without an Account" | "Apply With LinkedIn" | "Sign In"
//   step 0   /apply/manualApplication            Candidate Info: Import Resume, Personal Information
//            (#jobPostingApplication_personalInfo_*), Employment / Education History rows, Work Hours
//            Availability (required: one day with start/end times), each section its own <form> with Update.
//   step 1   ...&step=1&q=<n>                     "Questionnaire n of N": radio groups, Ant selects, text answers
//            (jobPostingApplication_sections_<i>_questionnaire_questions_<j>_selectedOption|answerText|...)
//   step 2   ...&step=2                           Candidate Acknowledgement (#jobPostingApplication_userAcknowledged);
//            Submit stays disabled until it is checked. NAO never clicks Submit.
//
// Next validates on the client, then asks Dayforce to validate the sections; it moves on only when the step is
// valid. Every select is an Ant Design select (drivers/antd-select.js); this module owns the steps, the resume
// import, the parts with fixed answers (work hours, phone dialing codes, the acknowledgement) and the labels the
// generic engine shows the answer model.
(() => {
  const AF = window.__AF;
  if (!AF || !AF.dom || AF.dayforce) return;
  const { clean, isVisible, delay, waitUntil, setNativeValue } = AF.dom;

  const FIELD_PREFIX = "jobPostingApplication_";
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  function isDayforcePage() {
    try {
      return /(^|\.)dayforcehcm\.com$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  const textOf = (el) => clean((el && (el.innerText || el.textContent)) || "");

  function buttons(re) {
    return [...document.querySelectorAll("button, a[role=button]")].filter((b) => isVisible(b) && re.test(textOf(b)));
  }

  function enabledButton(re) {
    return buttons(re).find((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true") || null;
  }

  function mainText() {
    return textOf(document.querySelector("main") || document.body);
  }

  // Ant form items with a validation error: "<label>: <message>".
  function visibleErrors() {
    const out = [];
    for (const item of document.querySelectorAll(".ant-form-item-has-error")) {
      if (!isVisible(item)) continue;
      const label = clean(((item.querySelector(".ant-form-item-label label") || {}).innerText || "").replace(/\*/g, ""));
      const msg = textOf(item.querySelector(".ant-form-item-explain-error"));
      const text = [qualify(item.querySelector("input, textarea") || item, label), msg].filter(Boolean).join(": ");
      if (text && !out.includes(text)) out.push(text);
    }
    return out;
  }

  // Where the run is. `key` changes whenever the visible step changes (used to confirm Next advanced).
  function stage() {
    if (!isDayforcePage()) return { kind: "none" };
    const errors = visibleErrors();
    const ack = document.getElementById(FIELD_PREFIX + "userAcknowledged");
    const submit = enabledButton(/^submit$/i) || buttons(/^submit$/i)[0] || null;
    const next = enabledButton(/^next$/i);
    const text = mainText();
    const q = text.match(/Questionnaire\s+(\d+)\s+of\s+(\d+)/i);
    let kind = "unknown";
    if (ack) kind = "submit";
    else if (q) kind = "questionnaire";
    else if (document.getElementById(FIELD_PREFIX + "personalInfo_email") || document.getElementById("personalInfo")) kind = "candidate";
    else if (enabledButton(/^apply without an account$/i)) kind = "account-choice";
    else if (enabledButton(/^apply$/i)) kind = "posting";
    let qTitle = "";
    if (q) {
      // The questionnaire's title is the first heading after the job title that is not "Questionnaire" itself
      // ("Application Questionnaire - Revised 2025", "Equal Employment Opportunity", "Veteran Form Questionnaire").
      const heads = [...document.querySelectorAll("main h1, main h2, main h3, main h4")].filter(isVisible).map(textOf).filter(Boolean);
      qTitle = heads.slice(1).find((h) => !/^questionnaire$/i.test(h) && !/cookie/i.test(h)) || "";
    }
    return {
      kind,
      index: q ? Number(q[1]) : 0,
      total: q ? Number(q[2]) : 0,
      title: qTitle,
      key: `${kind}|${location.search}|${q ? q[1] : ""}|${qTitle}`,
      hasNext: !!next,
      ackChecked: !!(ack && ack.checked),
      submitEnabled: !!(submit && !submit.disabled),
      errors,
    };
  }

  // ── step navigation ───────────────────────────────────────────────────────

  // "Apply without an Account": the guest application. Never signs in or creates an account.
  async function applyAsGuest() {
    const b = enabledButton(/^apply without an account$/i);
    if (!b) return { ok: stage().kind === "candidate" };
    b.click();
    const ok = await waitUntil(() => document.getElementById(FIELD_PREFIX + "personalInfo_email"), 20000, 250);
    return { ok: !!ok };
  }

  // Click Next and wait until the step changes or validation errors show.
  async function next({ timeoutMs = 20000 } = {}) {
    const before = stage();
    if (before.kind === "submit") return { advanced: false, stage: before, final: true };
    const b = enabledButton(/^next$/i);
    if (!b) return { advanced: false, stage: before, error: "no Next button" };
    b.click();
    let errorsSince = 0;
    const done = await waitUntil(() => {
      const now = stage();
      if (now.key !== before.key && now.kind !== "unknown") return now;
      if (now.errors.length) {
        errorsSince = errorsSince || Date.now();
        if (Date.now() - errorsSince > 1500) return now; // errors that stay: the step did not pass
      } else errorsSince = 0;
      return null;
    }, timeoutMs, 250);
    const now = done || stage();
    if (now.key !== before.key) {
      try {
        window.scrollTo(0, 0);
      } catch {}
      await delay(600); // the next step's fields mount after the URL changes
      return { advanced: true, stage: stage() };
    }
    return { advanced: false, stage: now, errors: now.errors };
  }

  // The last step: tick "I agree to the Candidate Acknowledgement". Submit is the candidate's.
  async function acknowledge() {
    const box = document.getElementById(FIELD_PREFIX + "userAcknowledged");
    if (!box) return { ok: false, error: "no acknowledgement on this page" };
    if (!box.checked) box.click();
    await waitUntil(() => box.checked, 3000, 100);
    const st = stage();
    return { ok: box.checked, submitEnabled: st.submitEnabled };
  }

  // ── resume import ─────────────────────────────────────────────────────────

  function resumeInput() {
    return document.querySelector(`input[type=file]#${FIELD_PREFIX}files_resume`);
  }

  function noticeTexts() {
    return [...document.querySelectorAll(".ant-notification-notice, .ant-message-notice")].map(textOf).filter(Boolean);
  }

  // "Import Resume": Dayforce parses the file and fills Personal Information, Employment and Education History
  // itself (then shows "imported" or, when it cannot read the file, a warning). Waits for that outcome.
  async function importResume({ name, type, b64 }, { timeoutMs = 60000 } = {}) {
    const input = resumeInput();
    if (!input) return { ok: false, error: "Import Resume is not on this page." };
    const bin = atob(b64 || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name || "resume.pdf", { type: type || "application/pdf" });
    const before = new Set(noticeTexts());
    const email = document.getElementById(FIELD_PREFIX + "personalInfo_email");
    const emailBefore = email ? email.value : "";
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Dayforce's notices: "imported" (parsed into the form), "uploaded. However, the application couldn't use it to
    // fill in your profile" (kept as the attachment, nothing filled), or an upload error.
    const NOT_USED = /however|couldn'?t|could not|can'?t|cannot|unable|warn|error|fail/i;
    const outcome = await waitUntil(() => {
      const fresh = noticeTexts().filter((t) => !before.has(t));
      if (fresh.some((t) => NOT_USED.test(t))) return { parsed: false, notice: fresh.join(" | ") };
      if (fresh.some((t) => /import|success|upload/i.test(t))) return { parsed: true, notice: fresh.join(" | ") };
      if (buttons(/^replace resume$/i).length && email && email.value && email.value !== emailBefore) return { parsed: true, notice: "" };
      return null;
    }, timeoutMs, 300);
    if (!outcome) return { ok: false, error: "The resume import did not finish in time." };
    await delay(800); // the parsed values settle into the form
    return { ok: true, parsed: outcome.parsed, notice: outcome.notice };
  }

  function resumeImported() {
    return buttons(/^replace resume$/i).length > 0;
  }

  // ── fixed parts of Candidate Info ─────────────────────────────────────────

  function setTime(input, value) {
    if (!input || input.value === value) return;
    setNativeValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Work Hours Availability (required: at least one day with a start and end time). When the candidate has not
  // set any day, mark weekdays 8:00 AM to 5:00 PM.
  async function prepareWorkHours({ days = ["monday", "tuesday", "wednesday", "thursday", "friday"], start = "08:00", end = "17:00" } = {}) {
    const box = (d) => document.getElementById(`${FIELD_PREFIX}workHoursAvailability_${d}_isChecked`);
    if (!box("monday")) return { present: false };
    if (DAYS.some((d) => box(d) && box(d).checked)) return { present: true, changed: false };
    for (const d of days) {
      const b = box(d);
      if (!b || b.checked) continue;
      b.click();
      await waitUntil(() => document.getElementById(`${FIELD_PREFIX}workHoursAvailability_${d}_start`), 2000, 80);
      setTime(document.getElementById(`${FIELD_PREFIX}workHoursAvailability_${d}_start`), start);
      setTime(document.getElementById(`${FIELD_PREFIX}workHoursAvailability_${d}_end`), end);
    }
    return { present: true, changed: true };
  }

  // Phone numbers sit beside a "Country dialing code" select; a number without one is "invalid".
  function phonePairs() {
    return [...document.querySelectorAll(`input[id^="${FIELD_PREFIX}"][id$="Phone"]`)]
      .map((input) => {
        const group = input.closest(".ant-space-compact") || input.parentElement;
        const select = group && group.querySelector(".ant-select");
        return select ? { input, select } : null;
      })
      .filter(Boolean);
  }

  // Before the answer pass: give the required phone (Mobile) its dialing code. After it: give every phone that has
  // a number one, and keep the number national when it was written with the country code.
  async function prepareDialCodes(country, { onlyFilled = false } = {}) {
    const want = clean(country) || "United States";
    let set = 0;
    for (const { input, select } of phonePairs()) {
      const required = input.getAttribute("aria-required") === "true";
      if (onlyFilled ? !clean(input.value) : !required && !clean(input.value)) continue;
      if (!select.querySelector(".ant-select-selection-item") && AF.antd && AF.antd.pick) {
        if (await AF.antd.pick(select, want)) set += 1;
      }
      const digits = (input.value || "").replace(/\D/g, "");
      const code = textOf(select.querySelector(".ant-select-selection-item")).match(/\+(\d{1,3})/);
      if (code && digits.length > 10 && digits.startsWith(code[1])) {
        setNativeValue(input, digits.slice(code[1].length));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return { set };
  }

  // ── labels and grouping for the generic engine ────────────────────────────

  const SECTION_NAMES = { workHistory: "Employment History", educationHistory: "Education History", reference: "Reference" };

  // Qualify a repeated label with its section row: "Country" in Employment History #1 is not the candidate's.
  function qualify(el, label) {
    const id = (el && el.id) || "";
    const m = id.match(/^jobPostingApplication_(workHistory|educationHistory|reference)_(\d+)_/);
    if (m && label) return `${SECTION_NAMES[m[1]] || m[1]} #${Number(m[2]) + 1} - ${label}`;
    return label;
  }

  function formItemLabel(el) {
    const item = el && el.closest && el.closest(".ant-form-item");
    if (!item) return "";
    const lab = item.querySelector(":scope > .ant-row > .ant-form-item-label label, .ant-form-item-label label");
    return clean(((lab && (lab.innerText || lab.textContent)) || "").replace(/\*/g, ""));
  }

  // The questionnaire / form question for a control (labelForControl and groupLabel hooks).
  function questionTitleFor(el) {
    if (!isDayforcePage() || !el) return "";
    const id = el.id || "";
    if (/files_coverLetter$/.test(id)) return "Cover Letter";
    if (/files_resume$/.test(id)) return "Resume";
    // Phone dialing code selects: "Mobile Phone Number - country dialing code".
    const compact = el.closest && el.closest(".ant-space-compact");
    if (compact && el.closest(".ant-select")) {
      const phone = compact.querySelector('input[id$="Phone"]');
      const base = formItemLabel(phone || el);
      return base ? `${base} - country dialing code` : "Country dialing code";
    }
    const group = el.closest && el.closest(".ant-radio-group, .ant-checkbox-group");
    const target = group || el;
    let label = formItemLabel(target);
    if (!label || /^[A-Za-z]+Answers$/.test(label) || /^[A-Z]{6,}$/.test(label)) {
      // Government forms label their one question with an internal name ("VeteranFormAnswers"); name it after the
      // questionnaire instead.
      const st = stage();
      if (/veteran/i.test(st.title)) label = "Protected veteran status (Veteran self-identification form)";
      else if (/disability/i.test(st.title)) label = "Disability status (Voluntary Self-Identification of Disability, Form CC-305)";
      else if (group) label = st.title || label;
    }
    return qualify(target, label);
  }

  // Ant checkbox groups carry no name; their options are the boxes inside the group.
  function groupInputs(root) {
    if (!isDayforcePage() || !root || !root.closest) return null;
    const group = root.closest(".ant-radio-group, .ant-checkbox-group");
    if (!group) return null;
    const inputs = [...group.querySelectorAll("input[type=radio], input[type=checkbox]")];
    return inputs.length ? inputs : null;
  }

  function optionLabelFor(input) {
    if (!isDayforcePage() || !input || !input.closest) return "";
    const wrap = input.closest(".ant-radio-wrapper, .ant-checkbox-wrapper, label");
    return wrap ? clean(wrap.innerText || wrap.textContent || "") : "";
  }

  function isRequiredControl(el) {
    const item = el && el.closest && el.closest(".ant-form-item");
    return !!(item && item.querySelector(".ant-form-item-required"));
  }

  // Controls the run handles itself (or that are not the candidate's to fill).
  function shouldSkipControl(el) {
    if (!isDayforcePage() || !el) return false;
    const id = el.id || "";
    if (id === "lang-select" || /recaptcha/i.test(id + " " + (el.name || ""))) return true;
    if (el.disabled || (el.closest && el.closest(".ant-select-disabled, .ant-input-disabled"))) {
      // State/Province is disabled only until a country is chosen; it is filled on a later pass.
      return !(el.closest && el.closest(".ant-select-disabled") && /stateCode$/.test(id));
    }
    if (/files_resume$|files_additionalDocument$/.test(id)) return true; // imported first / not ours
    if (/workHoursAvailability_/.test(id) && !/_comment$/.test(id)) return true; // prepareWorkHours
    if (el.closest && el.closest(".ant-space-compact") && el.closest(".ant-select")) return true; // dialing codes
    if (el.closest && el.closest("header, footer, .cookie-banner, [class*=cookie]")) return true;
    return false;
  }

  // The step being filled: every section form on it (not just the first <form>).
  function applicationRoot() {
    const st = stage().kind;
    if (st !== "candidate" && st !== "questionnaire" && st !== "submit") return null;
    const main = document.querySelector("main");
    return main && isVisible(main) ? main : document.body;
  }

  AF.dayforce = {
    applicationRoot,
    isDayforcePage,
    stage,
    applyAsGuest,
    next,
    acknowledge,
    importResume,
    resumeImported,
    prepareWorkHours,
    prepareDialCodes,
    questionTitleFor,
    groupInputs,
    optionLabelFor,
    isRequiredControl,
    shouldSkipControl,
    visibleErrors,
  };
})();
