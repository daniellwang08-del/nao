import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { APPLY_ATTR, APPLY_TEXT, GONE_TEXT, GONE_URL, MIN_FORM_FIELDS, NOT_APPLY_TEXT, PROBE_RULES, isApplyText, isGoneText, probeApplyPage, reachApplicationForm } from "../src/applyForm.js";
import { CLOSED_UNSUBMITTED, closedWithoutSubmit } from "../src/autoapply/model.js";

const RULES = { applyText: APPLY_TEXT, notApplyText: NOT_APPLY_TEXT, applyAttr: APPLY_ATTR, minFields: MIN_FORM_FIELDS, goneText: GONE_TEXT, goneUrl: GONE_URL };

test("apply button text", () => {
  for (const t of ["Apply now", "APPLY", "Apply for this job", "Apply to this position", "Start application", "I'm interested", "Apply for Position"]) {
    assert.ok(isApplyText(t), t);
  }
  for (const t of ["Apply with LinkedIn", "Submit application", "Share job", "Applying tips", "Sign in to apply", ""]) {
    assert.ok(!isApplyText(t), t);
  }
});

test("apply button text may carry arrows, icons and punctuation", () => {
  for (const t of ["Apply now \u2192", "Apply now \u203a", "Apply Now \u00bb", "Apply for this job \u2197", "\u2192 Apply", "Apply now!", "Apply now arrow_forward", "Apply open_in_new", "Apply now (opens in a new tab)", "I\u2019m interested \u203a"]) {
    assert.ok(isApplyText(t), t);
  }
  for (const t of ["Apply with LinkedIn \u2192", "Sign in to apply \u00bb", "Applying tips \u2192", "Applied", "Apply filters", "Apply now to win a prize"]) {
    assert.ok(!isApplyText(t), t);
  }
});

test("the rules the probe runs with are the exported ones", () => {
  assert.deepEqual(PROBE_RULES, RULES);
});

// ── a tiny DOM for the in-page probe ────────────────────────────────────────

function el(tag, { text = "", attrs = {}, visible = true, inside = [], form = null } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    value: attrs.value || "",
    type: attrs.type || (tag === "input" ? "text" : ""),
    name: attrs.name || "",
    id: attrs.id || "",
    placeholder: attrs.placeholder || "",
    className: attrs.class || "",
    disabled: false,
    visible,
    clicks: 0,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getBoundingClientRect: () => (node.visible ? { width: 100, height: 20 } : { width: 0, height: 0 }),
    closest: (sel) => (sel === "form" ? form : inside.some((s) => sel.includes(s)) ? {} : null),
    scrollIntoView() {},
    click() {
      node.clicks += 1;
    },
  };
  return node;
}

// `hosts` are elements with an open shadow root (see shadowHost).
function page({ fields = [], controls = [], hosts = [], href = "https://jobs.workable.com/view/abc/role" } = {}) {
  globalThis.location = { href };
  globalThis.getComputedStyle = (n) => ({ display: n.visible ? "block" : "none", visibility: "visible" });
  globalThis.document = {
    querySelectorAll: (sel) => (sel === "*" ? hosts : sel.startsWith("input:not") ? fields : controls),
    querySelector: () => null,
  };
}

function shadowHost({ fields = [], controls = [] } = {}) {
  return { shadowRoot: { querySelectorAll: (sel) => (sel === "*" ? [] : sel.startsWith("input:not") ? fields : controls) } };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.getComputedStyle;
});

const inputs = (n) => Array.from({ length: n }, (_, i) => el("input", { attrs: { name: `f${i}` } }));
const input = (name, attrs = {}, opts = {}) => el(attrs.tag || "input", { attrs: { name, ...attrs }, ...opts });
// Upload inputs are usually hidden behind a styled button.
const upload = (name, opts = {}) => el("input", { attrs: { name, type: "file", ...(opts.attrs || {}) }, visible: false, form: opts.form || null });
// A short application: name, email, phone.
const applicationFields = (form = null) => [
  input("first_name", {}, { form }),
  input("last_name", {}, { form }),
  input("email", { type: "email" }, { form }),
  input("phone", { type: "tel" }, { form }),
];

test("a Workable listing: clicks Apply now", () => {
  const apply = el("button", { text: "Apply now", attrs: { "data-ui": "overview-apply-now" } });
  const share = el("button", { text: "Share job" });
  page({ controls: [share, apply] });
  const out = probeApplyPage(RULES, true);
  assert.deepEqual({ ready: out.ready, clicked: out.clicked, label: out.label }, { ready: false, clicked: true, label: "apply now" });
  assert.equal(apply.clicks, 1);
  assert.equal(share.clicks, 0);
});

test("a careers-page.com (Manatal) listing: clicks Apply for Position", () => {
  const top = el("button", { text: "Apply for Position", attrs: { class: "btn btn-lg btn-outline-light" } });
  page({ controls: [top], href: "https://www.careers-page.com/24-mag/job/V6768V8R" });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.clicked, true);
  assert.equal(top.clicks, 1);
});

test("an application form is ready and nothing is clicked", () => {
  const apply = el("button", { text: "Apply now" });
  page({ fields: applicationFields(), controls: [apply] });
  assert.equal(probeApplyPage(RULES, true).ready, true);
  assert.equal(apply.clicks, 0);
});

test("a resume upload with one field counts as a form", () => {
  const form = fakeForm({ id: "application" });
  page({ fields: [input("f0", {}, { form }), upload("resume", { form })] });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("visible fields without application evidence are not a form", () => {
  const apply = el("a", { text: "Apply now", attrs: { href: "https://jobs.lever.co/acme/1/apply" } });
  page({ fields: inputs(5), controls: [apply], href: "https://jobs.lever.co/acme/1" });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.ready, false);
  assert.equal(out.href, "https://jobs.lever.co/acme/1/apply");
});

test("search boxes, header fields and hidden inputs do not make a form", () => {
  page({
    fields: [
      el("input", { attrs: { name: "q", placeholder: "Search jobs" } }),
      el("input", { attrs: { name: "email" }, inside: ["footer"] }),
      el("input", { attrs: { name: "x" }, visible: false }),
    ],
  });
  assert.equal(probeApplyPage(RULES, false).ready, false);
});

function fakeForm({ id = "", className = "", text = "", inner = [], file = false, attrs = {} } = {}) {
  return {
    id,
    className,
    innerText: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    querySelector: (sel) => (sel === "input[type=file]" && file ? {} : null),
    querySelectorAll: () => inner.map((c) => ({ id: "", className: c })),
  };
}

test("a job-alert signup beside the description is not the application", () => {
  const alerts = fakeForm({ className: "form-template", inner: ["form-group form-template-field-job-alert"] });
  const fields = ["first", "last", "email", "departments", "locations"].map((n) => el("input", { attrs: { name: n }, form: alerts }));
  const apply = el("a", { text: "Apply now", attrs: { href: "https://boards.greenhouse.io/acme/jobs/1" } });
  page({ fields, controls: [apply], href: "https://careers.acme.com/jobs/1" });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.ready, false);
  assert.equal(out.href, "https://boards.greenhouse.io/acme/jobs/1");
});

test("an application form with a resume upload is never taken for a signup", () => {
  const form = fakeForm({ className: "form-template", text: "Apply. Join our talent community (optional)", file: true });
  page({ fields: [...["first", "last", "email"].map((n) => el("input", { attrs: { name: n }, form })), upload("resume", { form })] });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("expired and removed postings are recognised; live ones are not", () => {
  for (const t of ["Job not found", "This job can\u2019t be found", "Oops, you've gone too far!", "This job is no longer available", "Sorry, this position has been filled", "Page not found", "The job you are looking for is no longer open", "This posting has expired", "Applications are closed", "Hiring for this position has been put on hold at this time."]) {
    assert.ok(isGoneText(t), t);
  }
  for (const t of ["Senior Software Engineer", "Apply for this job", "We are no longer a small startup", "Application deadline: Friday", ""]) {
    assert.ok(!isGoneText(t), t);
  }
});

test("job boards' dead-posting redirects report gone", () => {
  for (const [pathname, search] of [["/gitlab", "?error=true"], ["/runware/", "?not_found=true"], ["/404", ""]]) {
    page();
    globalThis.location = { href: "https://x.test" + pathname + search, pathname, search };
    assert.equal(probeApplyPage(RULES, false).gone, true, pathname + search);
  }
  page();
  globalThis.location = { href: "https://jobs.lever.co/acme/1", pathname: "/acme/1", search: "?lever-source=error" };
  assert.equal(probeApplyPage(RULES, false).gone, false);
});

test("a not-found page without a form reports gone", () => {
  page({ href: "https://jobs.ashbyhq.com/runbook/x/application" });
  globalThis.document.title = "Jobs";
  const heading = el("h1", { text: "Job not found" });
  globalThis.document.querySelectorAll = (sel) => (sel.startsWith("input:not") ? [] : sel.startsWith("h1") ? [heading] : []);
  globalThis.document.body = { innerText: "Job not found The job you requested was not found. View all open positions" };
  assert.equal(probeApplyPage(RULES, false).gone, true);
});

test("a form page is never gone even if it mentions closing dates", () => {
  page({ fields: applicationFields() });
  globalThis.document.title = "Applications closed on Friday? No, apply now";
  assert.equal(probeApplyPage(RULES, false).gone, false);
});

test("an apply link is returned to load in the same tab", () => {
  const link = el("a", { text: "Apply for this job", attrs: { href: "/acme/j/ABC/apply/", target: "_blank" } });
  page({ controls: [link], href: "https://apply.workable.com/acme/j/ABC/" });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.href, "https://apply.workable.com/acme/j/ABC/apply/");
  assert.equal(link.clicks, 0);
});

test("sign-in and third-party apply buttons are left alone", () => {
  const linkedin = el("button", { text: "Apply with LinkedIn" });
  page({ controls: [linkedin] });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.clicked, undefined);
  assert.equal(linkedin.clicks, 0);
});

test("probe without act never clicks", () => {
  const apply = el("button", { text: "Apply" });
  page({ controls: [apply] });
  probeApplyPage(RULES, false);
  assert.equal(apply.clicks, 0);
});

// ── what counts as an application ───────────────────────────────────────────

test("career-page job filters are not the application: Apply is clicked", () => {
  const filters = fakeForm({ id: "job-filters" });
  const fields = [
    input("keyword", { placeholder: "Keyword" }, { form: filters }),
    input("location", { tag: "select" }, { form: filters }),
    input("department", { tag: "select" }, { form: filters }),
    input("team", { tag: "select" }, { form: filters }),
  ];
  const apply = el("button", { text: "Apply now \u2192" });
  page({ fields, controls: [apply] });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.ready, false);
  assert.equal(out.clicked, true);
  assert.equal(apply.clicks, 1);
});

test("a refer-a-friend form is not the application", () => {
  const byForm = fakeForm({ id: "refer-a-friend" });
  page({ fields: ["your_name", "your_email", "name", "email", "message"].map((n) => input(n, {}, { form: byForm })) });
  assert.equal(probeApplyPage(RULES, false).ready, false);
  // Unmarked form, but its fields are about the friend (iCIMS "Refer this job to a friend").
  const plain = fakeForm({ id: "f1" });
  const fields = [
    input("first_name", {}, { form: plain }),
    input("last_name", {}, { form: plain }),
    input("email", { type: "email" }, { form: plain }),
    input("friend_first_name", {}, { form: plain }),
    input("friend_email", { type: "email" }, { form: plain }),
  ];
  page({ fields });
  assert.equal(probeApplyPage(RULES, false).ready, false);
});

test("share and email-this-job forms are not the application", () => {
  for (const id of ["email-this-job", "share-job-form", "send-to-friend"]) {
    const form = fakeForm({ id });
    page({ fields: applicationFields(form) });
    assert.equal(probeApplyPage(RULES, false).ready, false, id);
  }
  const share = fakeForm({ text: "Share this job with a friend" });
  page({ fields: [...applicationFields(share), input("recipient_email", { type: "email" }, { form: share })] });
  assert.equal(probeApplyPage(RULES, false).ready, false);
});

test("a sign-up wall is reported as an account, not filled", () => {
  const form = fakeForm({ id: "register" });
  const fields = [
    input("first_name", {}, { form }),
    input("last_name", {}, { form }),
    input("email", { type: "email" }, { form }),
    input("password", { type: "password" }, { form }),
    input("confirm_password", { type: "password" }, { form }),
  ];
  page({ fields });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.ready, false);
  assert.equal(out.account, true);
  assert.equal(out.gone, false);
});

test("a sign-in wall is reported as an account", () => {
  const form = fakeForm({ id: "login" });
  page({ fields: [input("email", { type: "email" }, { form }), input("password", { type: "password" }, { form })] });
  assert.deepEqual(probeApplyPage(RULES, false), { ready: false, fields: 2, gone: false, account: true });
});

test("an email-first sign-in step is reported as an account", () => {
  const form = fakeForm({ text: "Log in or create account" });
  page({ fields: [input("email", { type: "email" }, { form })] });
  assert.equal(probeApplyPage(RULES, false).account, true);
  // The same lone email box on a description page (a job alert) is not.
  page({ fields: [input("email", { type: "email" }, { form: fakeForm({ text: "Similar jobs" }) })] });
  assert.equal(probeApplyPage(RULES, false).account, undefined);
});

test("an account wall with an Apply button still clicks Apply", () => {
  const login = fakeForm({ id: "sidebar-login" });
  const apply = el("a", { text: "Apply for this job", attrs: { href: "/jobs/1/apply" } });
  page({ fields: [input("email", { type: "email" }, { form: login }), input("password", { type: "password" }, { form: login })], controls: [apply], href: "https://acme.example/jobs/1" });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.href, "https://acme.example/jobs/1/apply");
});

test("an application that also creates a portal login is still an application", () => {
  const form = fakeForm({ id: "candidate-profile" });
  page({ fields: [...applicationFields(form), input("password", { type: "password" }, { form }), upload("resume", { form })] });
  const out = probeApplyPage(RULES, false);
  assert.equal(out.ready, true);
  assert.equal(out.account, undefined);
});

test("a sign-in inside one page-wide form with a job-alert block is an account wall", () => {
  // SuccessFactors wraps the whole page, alert settings included, in one form.
  const form = fakeForm({ id: "careerform", inner: ["jobAlertName", "alertFrequency"], text: "Sign In Search for Openings" });
  page({ fields: [input("username", { autocomplete: "username" }, { form }), input("password", { type: "password" }, { form })] });
  const out = probeApplyPage(RULES, false);
  assert.equal(out.ready, false);
  assert.equal(out.account, true);
});

test("an application with a text-message opt-in is not taken for a signup", () => {
  // HiringThing: the form carries an "sms-subscribe" block beside the contact fields.
  const form = fakeForm({ id: "job-application-form", inner: ["sms-subscribe"] });
  const fields = ["user.first_name", "user.last_name", "user.email", "user.linkedin_url"].map((n) => input(n, {}, { form }));
  page({ fields: [...fields, input("user.phone", { type: "tel" }, { form })] });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("a cookie-consent form is not the application", () => {
  const form = fakeForm({ id: "onetrust-consent" });
  page({ fields: ["analytics", "marketing", "functional"].map((n) => input(n, { tag: "select" }, { form })) });
  assert.equal(probeApplyPage(RULES, false).ready, false);
});

test("a photo upload is not a resume", () => {
  const form = fakeForm({ id: "profile" });
  page({ fields: [input("headline", {}, { form }), upload("avatar", { form, attrs: { accept: "image/png, image/jpeg" } })] });
  assert.equal(probeApplyPage(RULES, false).ready, false);
});

test("a stray upload control on a formless page is not the application", () => {
  page({ fields: [input("keyword"), upload("match-resume")] });
  assert.equal(probeApplyPage(RULES, false).ready, false);
  // With a name or email beside it, a formless page is an application (Ashby has no <form>).
  page({ fields: [input("_systemfield_name"), input("_systemfield_email", { type: "email" }), upload("_systemfield_resume")] });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("an application asking who referred you is still an application", () => {
  const form = fakeForm({ id: "application_form" });
  page({ fields: [...applicationFields(form), input("referred_by", {}, { form }), upload("resume", { form })] });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("fields inside open shadow roots are counted", () => {
  const host = shadowHost({ fields: applicationFields() });
  page({ hosts: [host] });
  const out = probeApplyPage(RULES, false);
  assert.equal(out.ready, true);
  assert.equal(out.fields, 4);
});

test("an Apply button inside a shadow root is clicked", () => {
  const apply = el("button", { text: "I'm interested" });
  page({ hosts: [shadowHost({ controls: [apply] })] });
  assert.equal(probeApplyPage(RULES, true).clicked, true);
  assert.equal(apply.clicks, 1);
});

test("an Apply link with an arrow or new-tab hint is followed", () => {
  for (const t of ["Apply now \u203a", "Apply Now \u00bb", "Apply for this job \u2197", "Apply now (opens in a new tab)", "Apply for this job online"]) {
    const link = el("a", { text: t, attrs: { href: "https://boards.greenhouse.io/acme/jobs/1" } });
    page({ controls: [link], href: "https://careers.acme.com/jobs/1" });
    assert.equal(probeApplyPage(RULES, true).href, "https://boards.greenhouse.io/acme/jobs/1", t);
  }
});

// ── real ATS markup that must keep working ─────────────────────────────────

// Field names, types and containers as recorded from live pages (2026-11-06).
const label = (text) => ({ labels: [{ innerText: text }] });
function withLabel(node, text) {
  node.labels = label(text).labels;
  return node;
}

test("Greenhouse application form is ready", () => {
  const form = fakeForm({ id: "application-form", className: "application--form" });
  const fields = [
    withLabel(input("", { id: "first_name", autocomplete: "given-name" }, { form }), "First Name*"),
    withLabel(input("", { id: "last_name", autocomplete: "family-name" }, { form }), "Last Name*"),
    withLabel(input("", { id: "email", type: "text", autocomplete: "email" }, { form }), "Email*"),
    withLabel(input("", { id: "phone", type: "tel" }, { form }), "Phone"),
    upload("", { form, attrs: { id: "resume", accept: ".pdf,.doc,.docx,.txt,.rtf" } }),
  ];
  page({ fields, href: "https://job-boards.greenhouse.io/acme/jobs/1" });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("Lever application form is ready", () => {
  const form = fakeForm({ id: "application-form" });
  const fields = [
    upload("resume", { form, attrs: { id: "resume-upload-input" } }),
    input("name", {}, { form }),
    input("email", { type: "email" }, { form }),
    input("phone", {}, { form }),
    input("org", {}, { form }),
    input("urls[LinkedIn]", {}, { form }),
  ];
  page({ fields, href: "https://jobs.lever.co/acme/1/apply" });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("Ashby application form (no <form> element) is ready", () => {
  const fields = [
    withLabel(input("_systemfield_name", { id: "_systemfield_name" }), "Name"),
    withLabel(input("_systemfield_email", { id: "_systemfield_email", type: "email" }), "Email"),
    upload("_systemfield_resume", { attrs: { id: "_systemfield_resume" } }),
    input("", { id: "8d1f-phone", type: "tel" }),
  ];
  page({ fields, href: "https://jobs.ashbyhq.com/acme/1/application" });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("Workable application form is ready", () => {
  const form = fakeForm({ attrs: { "data-ui": "application-form" } });
  const fields = [
    input("firstname", { "data-ui": "firstname" }, { form }),
    input("lastname", { "data-ui": "lastname" }, { form }),
    input("email", { type: "email", "data-ui": "email" }, { form }),
    input("phone", { type: "tel", "data-ui": "phone" }, { form }),
    upload("resume", { form, attrs: { "data-ui": "resume" } }),
  ];
  page({ fields, href: "https://apply.workable.com/acme/j/ABC/apply/" });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("an application without an upload but with name and email is ready", () => {
  // BambooHR / Rippling: the resume box is not labelled as such.
  const form = fakeForm({ id: "job-application-form" });
  page({ fields: [input("firstName", {}, { form }), input("lastName", {}, { form }), input("email", {}, { form }), input("phone", {}, { form })] });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

// ── the tab loop ────────────────────────────────────────────────────────────

function chromeWith(script) {
  const calls = [];
  globalThis.chrome = {
    scripting: {
      async executeScript({ args }) {
        calls.push(args[1] ? "act" : "probe");
        const next = script.shift();
        return next ? [{ result: next }] : [];
      },
    },
    tabs: {
      get: async (id) => ({ id, url: "https://jobs.workable.com/view/abc", status: "complete" }),
      update: async () => {},
      remove: async () => {},
      onCreated: { addListener() {}, removeListener() {} },
    },
  };
  return calls;
}

test("clicks through to the form, then reports it ready", async () => {
  const calls = chromeWith([{ ready: false }, { ready: false, clicked: true, label: "apply now" }, { ready: true }, { ready: true }]);
  const steps = [];
  const out = await reachApplicationForm(1, { onStep: (m) => steps.push(m), waitMs: 3000 });
  assert.equal(out.ready, true);
  assert.deepEqual(out.steps, ["apply now"]);
  assert.deepEqual(calls.slice(0, 3), ["probe", "act", "probe"]);
  assert.match(steps[0], /apply now/);
});

test("a background tab that does not show the form is brought forward once", async () => {
  const notYet = Array.from({ length: 5 }, () => ({ ready: false }));
  chromeWith([{ ready: false }, { ready: false, clicked: true, label: "apply now" }, ...notYet, { ready: true }, { ready: true }]);
  const focused = [];
  const out = await reachApplicationForm(7, { waitMs: 10_000, focus: (id) => focused.push(id) });
  assert.equal(out.ready, true);
  assert.deepEqual(focused, [7]);
});

test("a page that is already a form is left as it is", async () => {
  const calls = chromeWith([{ ready: true }]);
  const out = await reachApplicationForm(1);
  assert.equal(out.ready, true);
  assert.deepEqual(out.steps, []);
  assert.deepEqual(calls, ["probe"]);
});

test("a single-page site whose Apply button renders late is still clicked through", async () => {
  const calls = chromeWith([{ ready: false }, { ready: false }, { ready: false }, { ready: false, clicked: true, label: "apply now" }, { ready: true }, { ready: true }]);
  const out = await reachApplicationForm(1, { waitMs: 3000 });
  assert.equal(out.ready, true);
  assert.deepEqual(out.steps, ["apply now"]);
  assert.deepEqual(calls.slice(0, 4), ["probe", "act", "act", "act"]);
});

test("an expired posting is reported gone without clicking anything", async () => {
  chromeWith([{ ready: false }, { ready: false, gone: true }]);
  const out = await reachApplicationForm(1);
  assert.equal(out.gone, true);
  assert.equal(out.ready, false);
  assert.deepEqual(out.steps, []);
});

test("no form and no apply button: not ready, nothing clicked", async () => {
  chromeWith([{ ready: false }, { ready: false }]);
  const out = await reachApplicationForm(1);
  assert.equal(out.ready, false);
  assert.deepEqual(out.steps, []);
  assert.equal(out.account, undefined);
});

test("a sign-in wall is reported as needing an account", async () => {
  chromeWith([{ ready: false, account: true }, { ready: false, account: true }]);
  const out = await reachApplicationForm(1);
  assert.equal(out.ready, false);
  assert.equal(out.account, true);
  assert.equal(out.gone, false);
});

test("Apply that leads to a sign-in page reports the account wall", async () => {
  chromeWith([{ ready: false }, { ready: false, href: "https://acme.example/login", label: "apply now" }, { ready: false, account: true }, { ready: false, account: true }]);
  const out = await reachApplicationForm(1, { waitMs: 3000 });
  assert.equal(out.account, true);
  assert.deepEqual(out.steps, ["apply now"]);
});

test("Apply clicked again and again with a stray sign-in box reports the failed click, not an account", async () => {
  // Teamtailor: "Apply for this job" never opens the form; an employee "Log in" email box sits on the page.
  const click = { ready: false, clicked: true, label: "apply for this job", account: true };
  const wall = { ready: false, account: true };
  // Per hop: probe (wall), act (click), the wait loop re-probes (wall); the last hop only probes.
  chromeWith([wall, { ...click }, wall, wall, { ...click }, wall, wall, { ...click }, wall, wall]);
  const out = await reachApplicationForm(1, { waitMs: 1000 });
  assert.equal(out.ready, false);
  assert.notEqual(out.account, true);
  assert.equal(out.steps.length >= 2, true);
});

// ── closing a tab without submitting ────────────────────────────────────────

test("closing a waiting tab moves the job to apply later", () => {
  for (const status of ["needs_you", "filled", "failed"]) {
    const next = closedWithoutSubmit({ status, tabOpen: true, title: "Engineer" }, 5);
    assert.deepEqual(next, { status: "later", tabOpen: false, title: "Engineer", message: CLOSED_UNSUBMITTED, at: 5 });
  }
  for (const status of ["applied", "invalid", "later", "skipped"]) {
    assert.equal(closedWithoutSubmit({ status, tabOpen: true }), null, status);
  }
});
