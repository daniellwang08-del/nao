import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/engine/drivers/native.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (name) => {
  const i = src.indexOf(`  function ${name}(`);
  const j = src.indexOf("\n  }\n", i);
  return src.slice(i, j + 4);
};
const domSrc = readFileSync(new URL("../content/engine/dom.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const normBody = domSrc.slice(domSrc.indexOf("  function normText("), domSrc.indexOf("\n  }\n", domSrc.indexOf("  function normText(")) + 4);
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const { isPlaceholderSelected } = new Function(
  "clean",
  `${normBody}\n${grab("isPlaceholderSelected")}\n${grab("isDeclineText")}\nreturn { isPlaceholderSelected };`,
)(clean);

const select = (texts, selectedIndex, defaultIndex = selectedIndex) => {
  const options = texts.map((text, i) => ({ text, value: String(i), defaultSelected: i === defaultIndex }));
  return { options, selectedIndex, selectedOptions: [options[selectedIndex]] };
};

test("issue 32: ApplyToJob EEO selects opening on 'Decline to answer' still get answered", () => {
  assert.equal(isPlaceholderSelected(select(["Decline to answer", "Female", "Male"], 0)), true);
  assert.equal(isPlaceholderSelected(select(["I don\u2019t wish to answer", "Yes", "No"], 0)), true);
  assert.equal(isPlaceholderSelected(select(["Prefer not to say", "Yes", "No"], 0)), true);
});

test("a chosen answer, or a decline the candidate picked over another default, counts as filled", () => {
  assert.equal(isPlaceholderSelected(select(["Decline to answer", "Female", "Male"], 2)), false);
  assert.equal(isPlaceholderSelected(select(["Decline to answer", "Female", "Male"], 0, 2)), false);
  assert.equal(isPlaceholderSelected(select(["Female", "Male", "Decline to answer"], 2)), false);
});
