// ADP Workforce Now recruitment (workforcenow.adp.com/mascsr/.../recruitment.html): the candidate flow.
//
// Live page, CaringBridge job 595185 (2026-11-12):
//   posting   #recruitment_jobDescription_apply / _candidateApply ("Apply")
//   consent   sdf-focus-pane: sdf-button "Consent & Continue" | "Decline & Close"
//   login     "Tell us about yourself": #guestFirstName #guestLastName #guestEmail, phone (react-phone-number-input:
//             select[name=phoneCountry] + input#login_view_phone, prefilled "+1"); Continue =
//             sdf-button#recruitment_login_recaptcha (runs Google reCAPTCHA in the candidate's browser)
//   otp       "Get your verification code": a radio per masked identifier (mobile, email) + "Send"
//             (#recruitment_login_sendOtp); then "Enter the Verification Code": one input + "Verify"
//             (#recruitment_login_verifyOTP), "Resend Code" (#recruitment_login_resendOTP)
//   wizard    "Applying for <title>": Personal Information -> Resume -> Questions (1..n) -> Voluntary Self-ID ->
//             Review Your Application -> Self-Attest & Submit, each with "Next"
//   attest    "Self Attestation is required": "Yes, I agree to sign electronically." reveals "Please type your
//             full name." Submit is the candidate's (auto-apply's submit step presses it in live mode)
//   done      "Application Submitted!"
// ADP's newer controls are SDF web components with open shadow roots (sdf-button, sdf-focus-pane): searches
// below pierce them.
(() => {
  const AF = window.__AF;
  if (!AF || !AF.dom || AF.adp) return;
  const { clean, isVisible, delay, waitUntil, setNativeValue } = AF.dom;

  function isAdpPage() {
    try {
      return /(^|\.)workforcenow\.adp\.com$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  const textOf = (el) => clean((el && (el.innerText || el.textContent)) || "");

  // querySelectorAll through open shadow roots.
  function deepAll(sel, root = document, depth = 0) {
    const out = [...root.querySelectorAll(sel)];
    if (depth > 6) return out;
    for (const n of root.querySelectorAll("*")) if (n.shadowRoot) out.push(...deepAll(sel, n.shadowRoot, depth + 1));
    return out;
  }

  const shown = (el) => {
    if (!el || !isVisible(el)) return false;
    try {
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none";
    } catch {
      return true;
    }
  };

  const labelOf = (b) => clean(b.getAttribute("aria-label") || textOf(b));

  // A visible, enabled button (native, [role=button] or sdf-button) whose text matches.
  function button(re) {
    const all = deepAll("button, [role=button], sdf-button, input[type=submit], input[type=button]");
    return (
      all.find(
        (b) =>
          shown(b) &&
          re.test(labelOf(b) || b.value || "") &&
          !b.disabled &&
          b.getAttribute("aria-disabled") !== "true" &&
          !b.hasAttribute("disabled")
      ) || null
    );
  }

  function anyButton(re) {
    return deepAll("button, [role=button], sdf-button").find((b) => shown(b) && re.test(labelOf(b))) || null;
  }

  function byId(id) {
    const el = document.getElementById(id);
    return el && shown(el) ? el : null;
  }

  function dialogs() {
    return deepAll("[role=dialog], [role=alertdialog], .vdl-modal, .modal, sdf-focus-pane, sdf-modal").filter(shown);
  }

  // The verification code modal's one-time code input.
  function codeInput() {
    for (const d of dialogs()) {
      if (!/verification code/i.test(textOf(d))) continue;
      const input = [...d.querySelectorAll("input")].find(
        (i) => shown(i) && !/radio|checkbox|hidden/i.test(i.type || "") && !i.disabled
      );
      if (input) return input;
    }
    return null;
  }

  function otpMethodDialog() {
    return dialogs().find((d) => /where would you like to receive a verification code/i.test(textOf(d))) || null;
  }

  function attestCheckbox() {
    return (
      deepAll("input[type=checkbox]").find((c) => {
        const wrap = c.closest("label") || c.parentElement;
        return /agree to sign electronically/i.test(textOf(wrap)) || /agree to sign electronically/i.test(c.getAttribute("aria-label") || "");
      }) || null
    );
  }

  function attestNameInput() {
    const box = attestCheckbox();
    const scope = (box && (box.closest("form, [role=dialog], main, section") || document)) || document;
    return (
      [...scope.querySelectorAll("input")].find((i) => {
        if (!shown(i) || /checkbox|radio|hidden/i.test(i.type || "")) return false;
        const lbl = textOf((i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) || i.closest("label") || i.parentElement);
        return /type your full name|full name/i.test(lbl + " " + (i.getAttribute("aria-label") || "") + " " + (i.placeholder || ""));
      }) || null
    );
  }

  // The wizard's current step: its heading in the content area.
  const STEP_NAMES = ["Personal Information", "Resume", "Questions", "Voluntary Self-ID", "Review Your Application", "Self-Attest & Submit"];
  function wizardStep() {
    const text = textOf(document.body);
    if (!/Applying for /i.test(text)) return "";
    if (attestCheckbox() || /Self Attestation is required/i.test(text)) return "Self-Attest & Submit";
    const heads = deepAll("h1, h2, h3, h4, legend, [role=heading]").filter(shown).map(textOf);
    if (heads.some((h) => /^review your application$/i.test(h))) return "Review Your Application";
    if (heads.some((h) => /^voluntary self-id/i.test(h))) return "Voluntary Self-ID";
    if (heads.some((h) => /please answer the following questions/i.test(h)) || /please answer the following questions/i.test(text)) return "Questions";
    if (heads.some((h) => /^resume$/i.test(h))) return "Resume";
    if (heads.some((h) => /^personal information$/i.test(h))) return "Personal Information";
    return "Application";
  }

  function visibleErrors() {
    const out = [];
    for (const e of deepAll(".vdl-validation-error, [role=alert], .error-message, .vdl-alert--error").filter(shown)) {
      const t = textOf(e);
      if (t && t.length < 200 && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 15);
  }

  function stage() {
    if (!isAdpPage()) return { kind: "none" };
    const text = textOf(document.body);
    let kind = "unknown";
    let step = "";
    if (/Application Submitted/i.test(text)) kind = "submitted";
    else if (codeInput()) kind = "otp-code";
    else if (otpMethodDialog()) kind = "otp-method";
    else if (byId("guestFirstName") || byId("guestEmail")) kind = "login";
    else if (button(/^consent\s*&\s*continue$/i)) kind = "consent";
    else if ((step = wizardStep())) kind = step === "Self-Attest & Submit" ? "attest" : "wizard";
    else if (byId("recruitment_jobDescription_apply") || byId("recruitment_jobDescription_candidateApply")) kind = "posting";
    const challenge = [...document.querySelectorAll('iframe[src*="recaptcha"][src*="bframe"]')].some((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 50 && r.height > 50;
    });
    return {
      kind,
      step,
      key: `${kind}|${step}|${location.hash}`,
      hasNext: !!button(/^next\b/i),
      submit: !!anyButton(/^submit$/i),
      challenge,
      errors: kind === "wizard" || kind === "attest" || kind === "login" ? visibleErrors() : [],
    };
  }

  // ADP's MDFTextbox keeps typed text only while its state says it has focus (getDerivedStateFromProps resets the
  // value from the form model otherwise), and commits to the model on blur. focus() fires no focus events in a
  // page without focus (auto-apply's background tab), so announce focus and blur ourselves (live-verified: a plain
  // value set, input/change events, execCommand and calling onChange all left the field empty).
  async function typeValue(input, value) {
    try {
      input.focus({ preventScroll: true });
    } catch {}
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focus"));
    await delay(80);
    setNativeValue(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
    await delay(80);
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur"));
    try {
      input.blur();
    } catch {}
    await delay(150);
  }

  async function waitForChange(beforeKey, timeoutMs) {
    let since = 0;
    const st = await waitUntil(() => {
      const now = stage();
      if (now.key !== beforeKey && now.kind !== "unknown") return now;
      if (now.errors.length) {
        since = since || Date.now();
        if (Date.now() - since > 1500) return now;
      } else since = 0;
      return null;
    }, timeoutMs, 250);
    return st || stage();
  }

  // ── gate actions ───────────────────────────────────────────────────────────

  async function apply() {
    const b = byId("recruitment_jobDescription_apply") || byId("recruitment_jobDescription_candidateApply");
    if (!b) return { ok: false };
    const before = stage().key;
    b.click();
    return { ok: true, stage: await waitForChange(before, 15000) };
  }

  async function consent() {
    const b = button(/^consent\s*&\s*continue$/i);
    if (!b) return { ok: false };
    const before = stage().key;
    b.click();
    return { ok: true, stage: await waitForChange(before, 15000) };
  }

  // "Tell us about yourself", then Continue (ADP sends the verification-code choice next).
  async function login({ firstName, lastName, email, phone }, { pressContinue = true } = {}) {
    const set = async (id, v) => {
      const el = document.getElementById(id);
      if (el && v && clean(el.value) !== clean(v)) await typeValue(el, v);
      return !!(el && clean(el.value));
    };
    const filled = {
      first: await set("guestFirstName", firstName),
      last: await set("guestLastName", lastName),
      email: await set("guestEmail", email),
    };
    const tel = document.getElementById("login_view_phone");
    if (tel && phone) {
      const digits = String(phone).replace(/[^\d+]/g, "");
      const e164 = digits.startsWith("+") ? digits : digits.length === 10 ? "+1" + digits : "+" + digits;
      if (tel.value.replace(/\D/g, "") !== e164.replace(/\D/g, "")) await typeValue(tel, e164);
      filled.phone = tel.value.replace(/\D/g, "").length >= 10;
    }
    await delay(300);
    if (!filled.first || !filled.last || !filled.email) return { ok: false, filled, error: "Could not fill the sign-in details." };
    if (!pressContinue) return { ok: true, filled, phoneValue: tel ? tel.value : "" };
    const go = document.getElementById("recruitment_login_recaptcha") || button(/^continue$/i);
    if (!go) return { ok: false, filled, error: "No Continue button." };
    const before = stage().key;
    go.click();
    return { ok: true, filled, stage: await waitForChange(before, 30000) };
  }

  // "Where would you like to receive a verification code?": the email, then Send.
  async function sendCodeByEmail(email) {
    const d = otpMethodDialog();
    if (!d) return { ok: false, error: "No verification-code choice on the page." };
    const radios = [...d.querySelectorAll("input[type=radio]")];
    const want = clean(email).toLowerCase();
    const pick =
      radios.find((r) => textOf(r.closest("label") || r.parentElement).toLowerCase().includes(want)) ||
      radios.find((r) => /@/.test(textOf(r.closest("label") || r.parentElement) + " " + (r.value || "")));
    if (!pick) return { ok: false, error: "No email option to receive the code." };
    if (!pick.checked) pick.click();
    await waitUntil(() => pick.checked, 2000, 80);
    const send = document.getElementById("recruitment_login_sendOtp") || [...d.querySelectorAll("button, sdf-button, [role=button]")].find((b) => /^send$/i.test(labelOf(b)));
    if (!send) return { ok: false, error: "No Send button." };
    const before = stage().key;
    send.click();
    return { ok: true, sentAt: Date.now(), stage: await waitForChange(before, 20000) };
  }

  async function enterCode(code) {
    const input = codeInput();
    if (!input) return { ok: false, error: "No verification code box on the page." };
    await typeValue(input, String(code).trim());
    await delay(300);
    const verify = document.getElementById("recruitment_login_verifyOTP") || button(/^verify$/i);
    if (!verify) return { ok: false, error: "No Verify button." };
    await waitUntil(() => !verify.disabled && verify.getAttribute("aria-disabled") !== "true", 3000, 100);
    const before = stage().key;
    verify.click();
    const st = await waitForChange(before, 25000);
    return { ok: st.kind !== "otp-code", stage: st };
  }

  // ── wizard ─────────────────────────────────────────────────────────────────

  // Next on a wizard step: waits for it to enable (Resume keeps it disabled until the upload finishes).
  async function next({ timeoutMs = 25000 } = {}) {
    const before = stage();
    if (before.kind === "attest" || before.kind === "submitted") return { advanced: false, stage: before };
    const b = await waitUntil(() => button(/^next\b/i), 15000, 250);
    if (!b) return { advanced: false, stage: stage(), errors: ["The Next button stayed disabled."].concat(visibleErrors()) };
    b.click();
    const st = await waitForChange(before.key, timeoutMs);
    if (st.key !== before.key) {
      await delay(800); // the next step mounts its fields
      try {
        window.scrollTo(0, 0);
      } catch {}
      return { advanced: true, stage: stage() };
    }
    return { advanced: false, stage: st, errors: st.errors };
  }

  // Self-Attest: "Yes, I agree to sign electronically." then the full name it asks for.
  async function attest(fullName) {
    const box = attestCheckbox();
    if (!box) return { ok: false, error: "No attestation on this page." };
    if (!box.checked) box.click();
    await waitUntil(() => box.checked, 3000, 100);
    const nameInput = await waitUntil(() => attestNameInput(), 5000, 150);
    if (nameInput && fullName && clean(nameInput.value) !== clean(fullName)) await typeValue(nameInput, fullName);
    await delay(300);
    return { ok: box.checked && !!(nameInput && clean(nameInput.value)), checked: box.checked, named: !!(nameInput && clean(nameInput.value)) };
  }

  // ── engine hooks ──────────────────────────────────────────────────────────

  // Controls a fill must not touch: cookie banner, page shell, the attestation (attest() owns it), and choices that
  // are the candidate's to make (AI-review opt-out, text-message consent).
  function shouldSkipControl(el) {
    if (!isAdpPage() || !el) return false;
    const id = el.id || "";
    if (/^(onetrust|ot-|vendor-search|chkbox-id|select-all|filter-)/i.test(id) || (el.closest && el.closest("#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk"))) return true;
    if (el.closest && el.closest("sfc-shell-app-bar, sfc-shell-left-nav-flat, header, footer")) return true;
    if (el === attestCheckbox() || el === attestNameInput()) return true;
    const wrap = textOf((el.closest && (el.closest("label") || el.parentElement)) || null);
    if (/opt out from having my resume reviewed|receive text messages/i.test(wrap)) return true;
    return false;
  }

  // The step being filled: the application dialog (or the page when it is not a dialog).
  function applicationRoot() {
    const st = stage();
    if (st.kind !== "wizard" && st.kind !== "attest") return null;
    const next = anyButton(/^next\b|^submit$/i);
    let node = next;
    for (let i = 0; node && i < 12; i++) {
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      if (node && node.querySelectorAll && node.querySelectorAll("input, select, textarea").length >= 1 && /Applying for/i.test(textOf(node))) return node;
    }
    return document.body;
  }

  AF.adp = {
    isAdpPage,
    stage,
    apply,
    consent,
    login,
    sendCodeByEmail,
    enterCode,
    next,
    attest,
    applicationRoot,
    shouldSkipControl,
    visibleErrors,
    STEP_NAMES,
  };
})();
