import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/submit-watch.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (name) => {
  const i = src.indexOf(`  function ${name}(`);
  const j = src.indexOf("\n  }\n", i);
  return src.slice(i, j + 4);
};
const consts = src.slice(src.indexOf("  const ACCOUNT_ATTR_RE"), src.indexOf("  function isAccountControl("));
const names = [
  "textOf",
  "attrsOf",
  "isNavigationOnly",
  "looksLikeFinalSubmitText",
  "isAccountControl",
  "looksLikeFinalSubmit",
  "patternCompiles",
  "blockedByNativeValidation",
];
const fns = new Function(`${consts}\n${names.map(grab).join("\n")}\nreturn { ${names.join(", ")} };`)();

function el({ tag = "BUTTON", text = "", attrs = {}, form = null, scope = null } = {}) {
  return {
    tagName: tag,
    innerText: text,
    type: attrs.type || "",
    id: attrs.id || "",
    name: "",
    className: attrs.class || "",
    disabled: false,
    form,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    closest: (sel) => (scope && sel.includes(scope) ? {} : null),
  };
}

test("Workday sign in and create account buttons are not application submits", () => {
  const signIn = el({ text: "Sign In", attrs: { "data-automation-id": "signInSubmitButton" } });
  const create = el({ text: "Create Account", attrs: { "data-automation-id": "createAccountSubmitButton" } });
  assert.equal(fns.looksLikeFinalSubmit(signIn), false);
  assert.equal(fns.looksLikeFinalSubmit(create), false);
});

test("controls inside an account form are not application submits", () => {
  const inScope = el({ text: "Submit", attrs: { type: "submit" }, scope: "signInContent" });
  assert.equal(fns.looksLikeFinalSubmit(inScope), false);
  const passwordForm = { querySelector: (s) => (s.includes("password") ? {} : null) };
  assert.equal(fns.looksLikeFinalSubmit(el({ text: "Submit", attrs: { type: "submit" }, form: passwordForm })), false);
  assert.equal(fns.looksLikeFinalSubmit(el({ text: "Verify", attrs: { type: "submit" } })), false);
});

test("real application submits are still detected", () => {
  assert.equal(fns.looksLikeFinalSubmit(el({ text: "Submit", attrs: { "data-automation-id": "pageFooterSubmitButton" } })), true);
  assert.equal(fns.looksLikeFinalSubmit(el({ text: "Submit application", attrs: { type: "submit" } })), true);
  const appForm = { querySelector: () => null };
  assert.equal(fns.looksLikeFinalSubmit(el({ text: "Submit", attrs: { type: "submit" }, form: appForm })), true);
});

const LEVER_EMAIL =
  "[a-zA-Z0-9.!#$%&'*+\\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*";

function field(pattern, valid) {
  let read = false;
  return {
    willValidate: true,
    getAttribute: (k) => (k === "pattern" ? pattern : null),
    get validity() {
      read = true;
      return { valid };
    },
    wasRead: () => read,
  };
}

test("a pattern Chrome cannot compile is skipped, never read", () => {
  assert.equal(fns.patternCompiles(field(LEVER_EMAIL, true)), false);
  assert.equal(fns.patternCompiles(field("[0-9]{5}", true)), true);
  const lever = field(LEVER_EMAIL, false);
  const form = { noValidate: false, elements: [lever, field(null, true)] };
  assert.equal(fns.blockedByNativeValidation({ form }), false);
  assert.equal(lever.wasRead(), false);
});

test("an invalid required field still blocks the submit", () => {
  const form = { noValidate: false, elements: [field(LEVER_EMAIL, true), field(null, false)] };
  assert.equal(fns.blockedByNativeValidation({ form }), true);
  assert.equal(fns.blockedByNativeValidation({ form: { ...form, noValidate: true } }), false);
});
