// Rippling applications: the Location place search picks the right suggestion, and an
// upload labeled "Cover letter" gets the cover letter even when the model leaves it out.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const slice = (src, head, end) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `missing ${head}`);
  return src.slice(i, src.indexOf(end, i) + end.length);
};

const drv = read("../content/engine/drivers/react-select.js");
const dom = read("../content/engine/dom.js");
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const place = new Function(
  "clean",
  [
    slice(dom, "  function normText(", "\n  }\n"),
    slice(drv, "  const US_STATES = {", "};\n"),
    slice(drv, "  const US_NAMES =", ";\n"),
    slice(drv, "  function placeParts(", "\n  }\n"),
    slice(drv, "  function bestPlaceOption(", "\n  }\n"),
    slice(drv, "  function placeQueries(", "\n  }\n"),
    "return { placeParts, bestPlaceOption, placeQueries };",
  ].join("\n"),
)(clean);

const option = (text) => ({ innerText: text });

test("place search types City, State first, then the full answer, then the city", () => {
  assert.deepEqual(place.placeQueries("Austin, TX, USA"), ["Austin, TX", "Austin, TX, USA", "Austin"]);
  assert.deepEqual(place.placeQueries("Austin, TX"), ["Austin, TX", "Austin"]);
  assert.deepEqual(place.placeQueries("Berlin"), ["Berlin"]);
});

test("the suggestion for the same city and state wins over same-named cities elsewhere", () => {
  const nodes = ["Portland, ME, USA", "Portland, OR, USA", "Portland, Victoria, Australia"].map(option);
  assert.equal(place.bestPlaceOption(nodes, "Portland, OR, USA"), nodes[1]);
  assert.equal(place.bestPlaceOption(nodes, "Portland, Oregon, United States"), nodes[1]);
  const austin = ["Austin, TX, USA", "Austin, MN, USA"].map(option);
  assert.equal(place.bestPlaceOption(austin, "Austin, Texas"), austin[0]);
});

test("no suggestion is picked when none names the city", () => {
  const nodes = ["Austintown, OH, USA", "Round Rock, TX, USA"].map(option);
  assert.equal(place.bestPlaceOption(nodes, "Austin, TX, USA"), null);
  assert.equal(place.bestPlaceOption([], "Austin, TX"), null);
});

test("ties keep the search service's order", () => {
  const nodes = ["Springfield, IL, USA", "Springfield, MO, USA"].map(option);
  assert.equal(place.bestPlaceOption(nodes, "Springfield"), nodes[0]);
});

const form = read("../src/panel/autofill/form.js");
const top = (name) => slice(form, `function ${name}(`, "\n}\n");
const { normalizeFileRolesInResults } = new Function(
  [top("foldLabel"), top("inferFileRoleFromLabel"), top("strictFileRoleFromLabel"), top("normalizeFileRolesInResults"),
    "return { normalizeFileRolesInResults };"].join("\n"),
)();

const specs = [
  {
    handle: 3,
    label: "Application",
    controls: [
      { cid: "af:res", label: "Résumé", is_file: true },
      { cid: "field-8", label: "First name" },
      { cid: "af:cov", label: "Cover Letter", is_file: true },
      { cid: "af:other", label: "Portfolio", is_file: true },
    ],
  },
];

test("a Cover letter upload the model left out still gets the cover letter", () => {
  const results = [{ handle: 3, controls: [{ cid: "af:res", file_role: "resume" }, { cid: "field-8", value: "Jordan" }] }];
  normalizeFileRolesInResults(results, specs);
  const cov = results[0].controls.find((c) => c.cid === "af:cov");
  assert.equal(cov.file_role, "cover_letter");
  assert.equal(cov.needs_user, false);
  assert.equal(results[0].controls.find((c) => c.cid === "af:other"), undefined); // unnamed uploads stay untouched
});

test("identical upload widgets get their role from the label, not the model's guess", () => {
  const results = [{ handle: 3, controls: [{ cid: "af:res", file_role: "resume" }, { cid: "af:cov", file_role: "resume" }] }];
  normalizeFileRolesInResults(results, specs);
  assert.equal(results[0].controls.find((c) => c.cid === "af:cov").file_role, "cover_letter");
});

test("uploads in a block the model skipped entirely are added", () => {
  const results = [];
  normalizeFileRolesInResults(results, specs);
  assert.deepEqual(results.map((r) => r.handle), [3]);
  assert.deepEqual(results[0].controls.map((c) => [c.cid, c.file_role]), [["af:res", "resume"], ["af:cov", "cover_letter"]]);
});

const engine = read("../content/engine/engine.js");

test("a control re-mounted without an id is found again by its position hash, never written detached", () => {
  const relocate = slice(engine, "  function relocate(cid) {", "\n  }\n");
  const refind = slice(engine, "  function refind(cid, entry) {", "\n  }\n");
  const fresh = { tagName: "INPUT", isConnected: true, attrs: {}, hasAttribute(k) { return k in this.attrs; }, setAttribute(k, v) { this.attrs[k] = v; } };
  const stale = { tagName: "INPUT", isConnected: false };
  const document = { querySelector: () => null, getElementById: () => null, querySelectorAll: () => [fresh] };
  const CSS = { escape: (s) => s };
  const controls = new Map([["af:cov", { root: stale, driver: {} }], ["af:gone", { root: stale, driver: {} }]]);
  const run = new Function("document", "CSS", "controls", "cidFor", `${relocate}\n${refind}\nreturn relocate;`);
  const rel = run(document, CSS, controls, (n) => (n === fresh ? "af:cov" : "x"));
  assert.equal(rel("af:cov"), fresh);
  assert.equal(fresh.attrs["data-autofill-cid"], "af:cov");
  const none = run({ ...document, querySelectorAll: () => [] }, CSS, controls, () => "x");
  assert.equal(none("af:gone"), null);
});
