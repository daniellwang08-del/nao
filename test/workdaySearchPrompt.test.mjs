// Workday School / Field of Study search prompts.
//
// Rules (any school, any field, any tenant; nothing hard-coded):
//   - search the profile's own text; tenants that search only on Enter get Enter;
//   - one result: the tenant's own match, keep it (Workday commits it on Enter);
//   - a result that is exactly the profile's text: take it;
//   - otherwise collect EVERY result and let the AI picker choose (education entry as context);
//   - the picker finds none: leave the field for the user, never guess.
// These tests run the REAL code from wd-steps.js against a simulated prompt; the picker is a stub
// that records what it was given (in the extension it is the backend AI).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/workday/wd-steps.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (name) => {
  const asyncAt = src.indexOf(`  async function ${name}(`);
  const i = asyncAt !== -1 ? asyncAt : src.indexOf(`  function ${name}(`);
  assert.ok(i !== -1, `missing ${name}`);
  const j = src.indexOf("\n  }\n", i);
  return src.slice(i, j + 4);
};
const grabConst = (name) => {
  const i = src.indexOf(`  const ${name} =`);
  return src.slice(i, src.indexOf(";\n", i) + 2);
};
const D0 = { norm: (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase() };

test("no hard-coded school geography or word-overlap ranking is left", () => {
  for (const gone of ["pickNearbyCampus", "campusCityAliases", "rankSearchResults", "seattle", "kent"]) {
    assert.equal(new RegExp(`\\b${gone}\\b`, "i").test(src.replace(/\/\/.*$/gm, "")), false, gone);
  }
});

test("Field of Study searches only the candidate's own field (fallback fields are ignored)", () => {
  const f = new Function("D", `${grab("fieldOfStudyCandidates")}\nreturn fieldOfStudyCandidates;`)(D0);
  assert.deepEqual(f({ fieldOfStudy: "Computer Science", fieldOfStudyFallbacks: ["Computer Engineering", "Software Engineering"] }), ["Computer Science"]);
});

// ── Simulated Workday prompt ──────────────────────────────────────────────────
// mode "enter": search runs only on Enter; one result commits on Enter. mode "type": results as you
// type. `results(query)` is the tenant's server search. `clickWorks` false: row clicks are ignored.
function makeWorkday({ results, mode = "enter", clickWorks = true, defaultList = [] }) {
  let clock = 0;
  const S = { open: false, typed: "", shown: [], searched: null, chip: null, highlight: -1, log: [], enters: 0 };
  const norm = D0.norm;
  const rowEl = (text, i) => ({ id: "row-" + i, text, isConnected: true, textContent: text, scrollIntoView() {}, querySelector: () => null });
  const rows = () => S.shown.map((t, i) => rowEl(t, i));
  const input = {
    focus() {},
    getAttribute: (a) => (a === "aria-activedescendant" && S.highlight >= 0 ? "row-" + S.highlight : ""),
    dispatchEvent() {
      if (mode === "type" && S.open) {
        S.shown = S.typed ? results(S.typed) : defaultList;
        S.highlight = S.shown.length ? 0 : -1;
      }
    },
  };
  const multi = { querySelector: (sel) => (sel === "input" ? input : null) };
  const commit = (text) => {
    S.chip = text;
    S.open = false;
    S.shown = [];
  };
  const env = {
    D: {
      norm,
      delay: async (ms) => {
        clock += ms;
      },
      clickEl: () => {
        S.open = true;
        S.shown = defaultList.slice();
      },
      nativeSet: (_el, v) => {
        S.typed = v;
      },
    },
    Date: { now: () => clock },
    InputEvent: class {},
    Event: class {},
    document: { getElementById: (id) => (id && id.startsWith("row-") ? rowEl(S.shown[Number(id.slice(4))], Number(id.slice(4))) : null) },
    WD: { log: (m) => S.log.push(m), warn: (m) => S.log.push("WARN " + m) },
    throwIfAborted: () => {},
    searchPicks: new Map(),
    activeMultiListRoot: () => (S.open ? {} : null),
    readMultiOptionRows: () => (S.open ? rows() : []),
    multiListNeedsScroll: () => false,
    multiListScroller: () => null,
    scrollCollectMultiOptions: async () => rows(),
    optionTextClean: (el) => (el && el.textContent) || "",
    isEmptyPromptRow: (t) => /^(no items|no results)\.?$/i.test(String(t || "").trim()),
    isPlaceholderOption: () => false,
    containsWordStart: new Function(`${grab("containsWordStart")}; return containsWordStart;`)(),
    promptSelectionNodes: () => (S.chip ? [{ textContent: S.chip, querySelector: () => ({ del: true }) }] : []),
    promptChosen: (_m, want) => {
      if (!S.chip) return false;
      const w = norm(want);
      return !w || norm(S.chip) === w || norm(S.chip).includes(w);
    },
    pressKey: (_el, key) => {
      if (!S.open) return;
      if (key === "Enter") {
        S.enters++;
        if (mode === "enter" && S.searched !== S.typed) {
          S.searched = S.typed;
          S.shown = results(S.typed);
          S.highlight = S.shown.length ? 0 : -1;
          if (S.shown.length === 1) commit(S.shown[0]); // Workday commits the only result
          return;
        }
        if (S.highlight >= 0 && S.shown[S.highlight]) commit(S.shown[S.highlight]);
      } else if (key === "ArrowDown" && S.shown.length) {
        S.highlight = Math.min(S.shown.length - 1, S.highlight + 1);
      }
    },
    clickMultiOptionRow: async (el) => {
      if (clickWorks) commit(el.text);
      return true;
    },
    firePointerClick: () => {
      S.chip = null; // the chip's delete button
    },
    closePrompt: async () => {
      S.open = false;
      S.typed = "";
      S.searched = null;
      S.shown = [];
    },
  };
  env.pressEnter = (el) => env.pressKey(el, "Enter", "Enter", 13);
  return { S, env, multi };
}

const flowSrc = [
  grabConst("SEARCH_STOPWORDS"),
  grab("canonOption"),
  grab("searchTokens"),
  grab("exactSearchResult"),
  grab("broaderSearchQuery"),
  grab("promptListTexts"),
  grab("waitForPromptResults"),
  grab("revealPromptRow"),
  grab("commitPromptRow"),
  grab("removePromptSelections"),
  grab("runPromptSearch"),
  grab("fillSearchPrompt"),
].join("\n");

function load(wd) {
  const names = Object.keys(wd.env);
  return new Function(...names, `${flowSrc}\nreturn { fillSearchPrompt };`)(...names.map((k) => wd.env[k]));
}

// A picker stub: records every call and answers from `answer(options)`.
function picker(answer) {
  const calls = [];
  const choose = async (value, options) => {
    calls.push({ value, options: options.slice() });
    return answer(options, value);
  };
  return { calls, choose };
}

const byPhrase = (list) => (q) => list.filter((o) => D0.norm(o).includes(D0.norm(q)));

test("one search result is kept as is, whatever its wording (tenant's own match), no picker", async () => {
  for (const only of ["University of Washington - Seattle Campus", "UW Seattle", "The University of Washington"]) {
    const wd = makeWorkday({ results: () => [only] });
    const p = picker(() => null);
    assert.equal(await load(wd).fillSearchPrompt(wd.multi, "University of Washington", { choose: p.choose }), true, only);
    assert.equal(wd.S.chip, only);
    assert.equal(p.calls.length, 0);
    assert.ok(wd.S.enters >= 1, "search-on-Enter tenant: Enter ran the search");
  }
});

test("a result with exactly the profile's text is taken among several, no picker", async () => {
  const fields = ["Computer and Information Science", "Computer Engineering", "Computer Science", "Computer Science Education"];
  const wd = makeWorkday({ results: byPhrase(fields) });
  const p = picker(() => null);
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "Computer Science", { choose: p.choose }), true);
  assert.equal(wd.S.chip, "Computer Science");
  assert.equal(p.calls.length, 0);
});

test("several results: the picker gets EVERY result (even ones sharing no words) and its choice is committed", async () => {
  const all = [
    "American University Washington College of Law",
    "George Washington University School of Business",
    "THE MICHAEL G. FOSTER SCHOOL OF BUSINESS, UNIVERSITY OF WASHINGTON",
    "The University of Washington",
    "University of Mary Washington",
    "UW Medicine",
  ];
  const wd = makeWorkday({ results: () => all });
  const p = picker(() => "The University of Washington");
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "University of Washington", { choose: p.choose }), true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "The University of Washington");
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0].options, all); // nothing filtered out before the AI decides
});

test("campuses: the picker decides (no built-in campus rule)", async () => {
  const campuses = ["University of Washington - Bothell", "University of Washington - Seattle", "University of Washington - Tacoma"];
  for (const want of campuses) {
    const wd = makeWorkday({ results: () => campuses });
    const p = picker(() => want);
    assert.equal(await load(wd).fillSearchPrompt(wd.multi, "University of Washington", { choose: p.choose }), true);
    assert.equal(wd.S.chip, want);
  }
});

test("the picker finds none: the field is left empty, nothing is guessed", async () => {
  const wd = makeWorkday({ results: () => ["Computer Engineering", "Computer Graphics"] });
  const p = picker(() => null);
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "Computer Science", { choose: p.choose }), false);
  assert.equal(wd.S.chip, null);
  assert.equal(p.calls.length, 1);
});

test("several results without a picker are left for the user (no local guess)", async () => {
  const wd = makeWorkday({ results: () => ["Computer and Information Science", "Computer Engineering"] });
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "Computer Science", {}), false);
  assert.equal(wd.S.chip, null);
});

test("full text finds nothing: a shorter search is tried and the picker chooses from its results", async () => {
  const fields = ["Computer and Information Science", "Computer Engineering", "Computer Graphics", "Computer Systems Analysis"];
  const wd = makeWorkday({ results: byPhrase(fields) });
  const p = picker((options) => options.find((o) => /information science/i.test(o)));
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "Computer Science", { choose: p.choose, broaden: true }), true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "Computer and Information Science");
  assert.deepEqual(p.calls[0].options, fields);
});

test("a shorter search's lone result is checked by the picker and removed when it is another field", async () => {
  const wd = makeWorkday({ results: byPhrase(["Computer Engineering"]) });
  const p = picker(() => null);
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "Computer Science", { choose: p.choose, broaden: true }), false);
  assert.equal(wd.S.chip, null);
  assert.deepEqual(p.calls[0].options, ["Computer Engineering"]);
});

test("Education 2 with the same school and results reuses the first answer (picker asked once)", async () => {
  const all = ["University of Washington - Bothell", "University of Washington - Seattle"];
  const wd = makeWorkday({ results: () => all });
  const { fillSearchPrompt } = load(wd);
  const p = picker(() => "University of Washington - Seattle");
  assert.equal(await fillSearchPrompt(wd.multi, "University of Washington", { choose: p.choose }), true);
  wd.S.chip = null;
  assert.equal(await fillSearchPrompt(wd.multi, "University of Washington", { choose: p.choose }), true);
  assert.equal(wd.S.chip, "University of Washington - Seattle");
  assert.equal(p.calls.length, 1);
});

test("search-as-you-type tenant with a default list: results are detected, no early Enter, picked row clicked", async () => {
  const all = ["Stanford University", "The University of Texas at Austin", "University of Texas at Dallas"];
  const wd = makeWorkday({ results: byPhrase(all.concat(["Texas A&M University"]).filter((x) => /texas/i.test(x))), mode: "type", defaultList: ["Harvard University", "MIT"] });
  const p = picker((options) => options.find((o) => /austin/i.test(o)));
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "University of Texas", { choose: p.choose }), true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "The University of Texas at Austin");
  assert.ok(!p.calls[0].options.includes("Harvard University"), "the default list is not taken as results");
});

test("a row click that is ignored falls back to arrow keys + Enter", async () => {
  const all = ["Alpha College", "Beta University", "Gamma Institute"];
  const wd = makeWorkday({ results: () => all, clickWorks: false });
  const p = picker(() => "Gamma Institute");
  assert.equal(await load(wd).fillSearchPrompt(wd.multi, "Gamma", { choose: p.choose }), true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "Gamma Institute");
});

// ── The pickers send every result plus the education entry to the AI ────────────
test("School and Field of Study pickers give the AI the education entry and the home city", async () => {
  const sent = [];
  const fns = new Function(
    "D",
    "requestOptionMatches",
    "activeProfile",
    `${grab("educationContext")}\n${grab("pickOne")}\n${grab("makeSchoolChooser")}\n${grab("makeFieldOfStudyChooser")}\nreturn { makeSchoolChooser, makeFieldOfStudyChooser };`,
  )(
    D0,
    async (items) => {
      sent.push(items[0]);
      return { [items[0].cid]: items[0].options[1] };
    },
    { address: { city: "Austin", state: "TX" } },
  );
  const entry = { school: "University of Texas", degree: "Master of Science", fieldOfStudy: "Statistics", startMMYYYY: "09/2015", endMMYYYY: "06/2017" };
  const opts = ["University of Texas at Dallas", "The University of Texas at Austin", "University of Texas at El Paso"];
  assert.equal(await fns.makeSchoolChooser(entry)("University of Texas", opts), "The University of Texas at Austin");
  assert.deepEqual(sent[0].options, opts);
  assert.match(sent[0].label, /Austin, TX/);
  assert.match(sent[0].label, /Master of Science/);
  assert.match(sent[0].label, /answer none/);
  const fos = ["Statistics and Data Science", "Applied Statistics"];
  await fns.makeFieldOfStudyChooser(entry)("Statistics", fos);
  assert.deepEqual(sent[1].options, fos);
  assert.match(sent[1].label, /"Statistics"/);
});
