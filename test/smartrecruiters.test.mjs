// SmartRecruiters screening questions: text and number answers carry their question in a
// slotted <span slot="label-content">, not a label attribute, and must still be labeled.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dom = readFileSync(new URL("../content/engine/dom.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (head) => {
  const i = dom.indexOf(head);
  assert.ok(i >= 0, `missing ${head}`);
  return dom.slice(i, dom.indexOf("\n  }\n", i) + 4);
};
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const { srLabel } = new Function("clean", `${grab("  function climbHosts(")}\n${grab("  function srLabel(")}\nreturn { srLabel };`)(clean);

// A light-DOM element; `shadow` children sit in a shadow root whose host is this element.
function el(tag, { attrs = {}, children = [], shadow = [], text = "" } = {}) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs, children, textContent: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
  };
  for (const c of children) c.parentNode = node;
  if (shadow.length) {
    const root = { nodeType: 11, host: node };
    for (const c of shadow) c.parentNode = root;
  }
  return node;
}

test("a screening text question is labeled by its slotted prompt", () => {
  const input = el("input");
  const wrap = el("div", { children: [input] });
  el("spl-textarea", {
    attrs: { id: "question_1", maxlength: "200" },
    children: [el("span", { attrs: { slot: "label-content" }, text: " Why did you leave or are you looking to leave your most recent employer? * " })],
    shadow: [wrap],
  });
  assert.equal(srLabel(input), "Why did you leave or are you looking to leave your most recent employer?");
});

test("the salary number question is labeled too", () => {
  const input = el("input", { attrs: { type: "number" } });
  el("spl-number-field", {
    children: [el("span", { attrs: { slot: "label-content" }, text: "What is your desired annual salary?" })],
    shadow: [input],
  });
  assert.equal(srLabel(input), "What is your desired annual salary?");
});

test("personal-info fields keep their label attribute", () => {
  const input = el("input");
  el("spl-input", { attrs: { label: "First name" }, shadow: [input] });
  assert.equal(srLabel(input), "First name");
});
