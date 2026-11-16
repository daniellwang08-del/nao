// Workday "My Experience" work entries (issue #39): the profile wins over Workday's resume parse, and the current
// role gets "I currently work here". Runs the REAL code from wd-steps.js against a modelled panel.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/workday/wd-steps.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (n, prefix = "  ") => {
  const i = src.indexOf(`${prefix}function ${n}(`);
  assert.ok(i !== -1, `missing ${n}`);
  return src.slice(i, src.indexOf("\n  }\n", i) + 4);
};

const AID = (id) => `[data-automation-id="${id}"]`;

const text = (v) => {
  const input = { value: v || "" };
  return { kind: "text", input, querySelector: (sel) => (/checkbox|dateSection/.test(sel) ? null : input) };
};
const date = (v) => {
  const [mm, yyyy] = (v || "/").split("/");
  const month = { value: mm || "" };
  const year = { value: yyyy || "" };
  return {
    kind: "date",
    month,
    year,
    querySelector: (sel) => (sel === AID("dateSectionMonth-input") ? month : sel === AID("dateSectionYear-input") ? year : null),
  };
};

// A Workday work-experience panel: text fields, MM/YYYY dates and the "I currently work here" box. Ticking the box
// removes the End Date field, as Workday does.
function panel(values) {
  const fields = {};
  for (const k of ["jobTitle", "companyName", "location", "roleDescription"]) fields[k] = text(values[k]);
  fields.startDate = date(values.startDate);
  fields.endDate = date(values.endDate);
  const box = { checked: !!values.current };
  fields.currentlyWorkHere = { kind: "check", box, querySelector: (sel) => (sel === 'input[type="checkbox"]' ? box : null) };
  return { fields, writes: [] };
}

function load(root) {
  const env = {
    WD: { log() {} },
    panelRoots: () => [root],
    AID,
    D: { delay: async () => {} },
    stripMarkdown: (s) => String(s || "").replace(/\*\*/g, ""),
    record: (r, label, ok) => (ok ? r.filled : r.missed).push(label),
    panelField: (r, key) => r.fields[key] || null,
    isDateContainer: (c) => c.kind === "date",
    fieldHasCommittedValue: (c) =>
      c.kind === "date" ? !!(c.month.value || c.year.value) : c.kind === "check" ? c.box.checked : !!c.input.value,
    commitCheckable: async (box, on) => {
      box.checked = on;
      return true;
    },
    writeField: async (c, value) => {
      const key = Object.keys(root.fields).find((k) => root.fields[k] === c);
      root.writes.push(key);
      if (c.kind === "check") {
        c.box.checked = true;
        delete root.fields.endDate; // Workday drops "To" once the role is current
      } else if (c.kind === "date") {
        const [mm, yyyy] = String(value).split("/");
        c.month.value = String(parseInt(mm, 10));
        c.year.value = yyyy;
      } else c.input.value = String(value);
      return true;
    },
  };
  const code = [
    grab("workFieldMatches"),
    grab("setWorkField", "  async "),
    grab("setCurrentRole", "  async "),
    grab("fillWorkPanel", "  async "),
    grab("reassertWorkEntries", "  async "),
  ].join("\n");
  return new Function(...Object.keys(env), `${code}\nreturn { fillWorkPanel, reassertWorkEntries };`)(...Object.values(env));
}

const newRep = () => ({ filled: [], missed: [] });

const CURRENT = {
  title: "Senior Software Engineer",
  company: "Avanade Inc.",
  location: "",
  startMMYYYY: "10/2023",
  endMMYYYY: "",
  current: true,
  description: "Built the **platform**.",
};

test("the current role is ticked and the parse's wrong end date goes (screenshot: From 10/2023, To 09/2023)", async () => {
  const root = panel({ jobTitle: "Senior Software Engineer", companyName: "Avanade Inc.", startDate: "10/2023", endDate: "09/2023" });
  const rep = newRep();
  await load(root).fillWorkPanel(root, CURRENT, 1, rep);
  assert.equal(root.fields.currentlyWorkHere.box.checked, true);
  assert.equal(root.fields.endDate, undefined, "Workday removed To once the role is current");
  assert.ok(rep.filled.includes("Work 1 Current"));
  for (const k of ["jobTitle", "companyName", "startDate"]) assert.ok(!root.writes.includes(k), `${k} matched and was not retyped`);
});

test("a past role gets the profile's dates and title over a wrong parse, and a parsed current tick is removed", async () => {
  const root = panel({ jobTitle: "Engineer", companyName: "Avanade Inc.", startDate: "10/2021", endDate: "10/2023", current: true });
  const rep = newRep();
  await load(root).fillWorkPanel(
    root,
    { title: "Senior Software Engineer", company: "Avanade Inc.", startMMYYYY: "10/2021", endMMYYYY: "09/2023", current: false },
    1,
    rep,
  );
  assert.equal(root.fields.currentlyWorkHere.box.checked, false);
  assert.equal(root.fields.jobTitle.input.value, "Senior Software Engineer");
  assert.equal(`${root.fields.endDate.month.value}/${root.fields.endDate.year.value}`, "9/2023");
  for (const k of ["startDate", "companyName"]) assert.ok(!root.writes.includes(k), `${k} matched and was not retyped`);
  assert.deepEqual(rep.missed, []);
});

test("a resume parse that lands after the fill is undone: the tick comes back and To goes again", async () => {
  const root = panel({ jobTitle: "Senior Software Engineer", companyName: "Avanade Inc.", startDate: "10/2023" });
  const { fillWorkPanel, reassertWorkEntries } = load(root);
  await fillWorkPanel(root, CURRENT, 1, newRep());
  assert.equal(root.fields.currentlyWorkHere.box.checked, true);
  // Workday's parser re-populates the panel from the resume afterwards.
  root.fields.currentlyWorkHere.box.checked = false;
  root.fields.endDate = date("09/2023");
  await reassertWorkEntries([CURRENT]);
  assert.equal(root.fields.currentlyWorkHere.box.checked, true);
  assert.equal(root.fields.endDate, undefined);
});
