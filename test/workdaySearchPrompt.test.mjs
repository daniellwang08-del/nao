// Workday School / Field of Study search prompts (Epiq Systems tenant, 2026-11-05).
//
// Live evidence: after autofill both School and Field of Study were empty in Education 1 and 2
// ("4 to check"). The tenant runs the search only when Enter is pressed; the old code typed, waited
// for results that never came, and gave up without pressing Enter. These tests run the REAL
// fillSearchPrompt code (pulled from wd-steps.js) against a simulated prompt that behaves like that
// tenant, plus the ranking rules on the exact result lists from the screenshots.
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

// ── Ranking ────────────────────────────────────────────────────────────────
const D0 = { norm: (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase() };
const rankingSrc = [
  grabConst("SEARCH_STOPWORDS"),
  grab("containsWordStart"),
  grab("isEmptyPromptRow"),
  grab("isPlaceholderOption"),
  grab("canonOption"),
  grab("searchTokens"),
  grab("rankSearchResults"),
  grab("broaderSearchQuery"),
].join("\n");
const R = new Function("D", `${rankingSrc}\nreturn { rankSearchResults, broaderSearchQuery, canonOption };`)(D0);

// The 19 School results for "University of Washington" (first 11 from the screenshot, then the
// rest of an alphabetical Workday school list).
const UW_RESULTS = [
  "American University Washington College of Law",
  "American University, Washington College of Law",
  "George Washington University School of Business",
  "George Washington University School of Project Management",
  "Olin School of Business at Washington University",
  "THE MICHAEL G. FOSTER SCHOOL OF BUSINESS, UNIVERSITY OF WASHINGTON",
  "The University of Washington",
  "University of Mary Washington",
  "University of Phoenix-Eastern Washington Campus",
  "University of Phoenix-Washington DC Campus",
  "University of Phoenix-Western Washington Campus",
  "Washington & Jefferson College",
  "Washington and Lee University",
  "Washington College",
  "Washington State University",
  "Washington University in St. Louis",
  "Central Washington University",
  "Eastern Washington University",
  "Western Washington University",
];
const FOS_COMPUTER = ["Computer and Information Science", "Computer Engineering", "Computer Graphics", "Computer Systems Analysis"];

test("School: 'The University of Washington' is the best of the 19 results", () => {
  const r = R.rankSearchResults("University of Washington", UW_RESULTS);
  assert.equal(r.best, "The University of Washington");
  assert.equal(r.exact, true);
});

test("School: campuses with no plain row go to the profile-aware picker, Mary Washington never wins", () => {
  const r = R.rankSearchResults("University of Washington", [
    "University of Mary Washington",
    "University of Washington Bothell",
    "University of Washington-Seattle Campus",
    "University of Washington-Tacoma Campus",
  ]);
  assert.equal(r.best, null); // several campuses: the picker (near Kent, WA -> Seattle) decides
  assert.deepEqual(r.ranked.slice(0, 3).map((x) => x.text).sort(), [
    "University of Washington Bothell",
    "University of Washington-Seattle Campus",
    "University of Washington-Tacoma Campus",
  ]);
});

test("Field of Study: 'Computer Science' picks 'Computer and Information Science', not Computer Engineering", () => {
  const r = R.rankSearchResults("Computer Science", FOS_COMPUTER);
  assert.equal(r.best, "Computer and Information Science");
  assert.equal(R.broaderSearchQuery("Computer Science"), "computer");
  assert.equal(R.broaderSearchQuery("Informatics"), null);
});

test("Field of Study: exact and '&' spellings match; unrelated lists match nothing", () => {
  assert.equal(R.rankSearchResults("Information Technology", ["Information Systems", "Information Technology", "Information Science"]).best, "Information Technology");
  assert.equal(R.rankSearchResults("Science, Technology & Society", ["Science, Technology and Society"]).best, "Science, Technology and Society");
  assert.equal(R.rankSearchResults("Computer Science", ["Accounting", "Biology"]).best, null);
  assert.equal(R.rankSearchResults("Computer Science", ["Accounting", "Biology"]).ranked.length, 0);
});

test("Field of Study candidates are the profile's own field only (no hard-coded other fields)", () => {
  const f = new Function("D", `${grab("fieldOfStudyCandidates")}\nreturn fieldOfStudyCandidates;`)(D0);
  assert.deepEqual(f({ fieldOfStudy: "Computer Science" }), ["Computer Science"]);
  assert.deepEqual(f({ fieldOfStudy: "Computer Science", fieldOfStudyFallbacks: ["CS", "computer science"] }), ["Computer Science", "CS"]);
});

// ── fillSearchPrompt against a simulated Workday prompt ───────────────────────
//
// mode "enter": the search runs only when Enter is pressed (Epiq Systems); one result commits on
// Enter. mode "type": results appear as you type (other tenants). `match` decides which options a
// query returns: "words" = every typed word appears, "phrase" = the typed text appears as is.
function makeWorkday({ options, mode = "enter", match = "words", clickWorks = true }) {
  let clock = 0;
  const S = { open: false, typed: "", shown: [], searched: null, chip: null, highlight: -1, log: [], enters: 0 };
  const norm = D0.norm;
  const search = (q) => {
    const n = norm(q);
    const words = n.split(" ").filter(Boolean);
    return options.filter((o) => (match === "phrase" ? norm(o).includes(n) : words.every((w) => norm(o).includes(w))));
  };
  const rowEl = (text, i) => ({
    id: "row-" + i,
    text,
    isConnected: true,
    textContent: text,
    scrollIntoView() {},
    querySelector: () => null,
  });
  const rows = () => S.shown.map((t, i) => rowEl(t, i));
  const input = {
    focus() {},
    getAttribute: (a) => (a === "aria-activedescendant" && S.highlight >= 0 ? "row-" + S.highlight : ""),
    dispatchEvent() {
      if (mode === "type" && S.open) {
        S.shown = S.typed ? search(S.typed) : [];
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
          S.shown = search(S.typed);
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
      S.chip = null;
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
  rankingSrc,
  grab("relatedPromptRows"),
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

test("search-on-Enter tenant: School presses Enter, reads all 19 results and commits 'The University of Washington' (7th row)", async () => {
  const wd = makeWorkday({ options: UW_RESULTS.concat(["Harvard University"]), match: "phrase" });
  const ok = await load(wd).fillSearchPrompt(wd.multi, "University of Washington", {});
  assert.equal(ok, true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "The University of Washington");
  assert.ok(wd.S.enters >= 1, "Enter must run the search");
});

test("old behaviour reproduced: without Enter the search never runs and nothing is filled", async () => {
  // What the old code did: type, wait for results, never press Enter. The simulated tenant shows
  // nothing, so the field stays empty, exactly like the screenshot.
  const wd = makeWorkday({ options: UW_RESULTS, match: "phrase" });
  wd.env.D.clickEl(wd.multi);
  wd.env.D.nativeSet(null, "University of Washington");
  wd.multi.querySelector("input").dispatchEvent({});
  assert.deepEqual(wd.env.readMultiOptionRows(), []);
  assert.equal(wd.S.chip, null);
});

test("Field of Study 'Computer Science': one word-match result commits itself on Enter", async () => {
  const fields = FOS_COMPUTER.concat(["Information Technology", "Information Systems", "Software Engineering"]);
  const wd = makeWorkday({ options: fields, match: "words" });
  const ok = await load(wd).fillSearchPrompt(wd.multi, "Computer Science", { broaden: true });
  assert.equal(ok, true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "Computer and Information Science");
});

test("Field of Study 'Computer Science' with phrase search: no result, then 'Computer' lists 4 and the best is chosen", async () => {
  const wd = makeWorkday({ options: FOS_COMPUTER, match: "phrase" });
  const ok = await load(wd).fillSearchPrompt(wd.multi, "Computer Science", { broaden: true });
  assert.equal(ok, true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "Computer and Information Science");
});

test("Field of Study 'Information Technology' among several 'Information' results picks the exact one", async () => {
  const wd = makeWorkday({ options: ["Information Systems", "Information Technology", "Information Technology Management"], match: "words" });
  const ok = await load(wd).fillSearchPrompt(wd.multi, "Information Technology", { broaden: true });
  assert.equal(ok, true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "Information Technology");
});

test("a lone broader result that is a different field is removed, not kept", async () => {
  const wd = makeWorkday({ options: ["Computer Engineering"], match: "phrase" });
  const ok = await load(wd).fillSearchPrompt(wd.multi, "Computer Science", { broaden: true });
  assert.equal(ok, false);
  assert.equal(wd.S.chip, null);
});

test("several campuses ask the picker once; Education 2 with the same school reuses the answer", async () => {
  const campuses = ["University of Mary Washington", "University of Washington Bothell", "University of Washington-Seattle Campus", "University of Washington-Tacoma Campus"];
  const wd = makeWorkday({ options: campuses, match: "phrase" });
  const { fillSearchPrompt } = load(wd);
  let asked = 0;
  const choose = async (_v, options) => {
    asked++;
    assert.ok(!options.includes("University of Mary Washington") || options.indexOf("University of Mary Washington") > 2);
    return "University of Washington-Seattle Campus";
  };
  assert.equal(await fillSearchPrompt(wd.multi, "University of Washington", { choose }), true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "University of Washington-Seattle Campus");
  wd.S.chip = null; // Education 2
  assert.equal(await fillSearchPrompt(wd.multi, "University of Washington", { choose }), true);
  assert.equal(wd.S.chip, "University of Washington-Seattle Campus");
  assert.equal(asked, 1);
});

test("search-as-you-type tenant: no Enter before choosing; a non-first row is committed by click", async () => {
  const wd = makeWorkday({ options: UW_RESULTS, mode: "type", match: "phrase" });
  const ok = await load(wd).fillSearchPrompt(wd.multi, "University of Washington", {});
  assert.equal(ok, true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "The University of Washington");
});

test("when a row click is ignored, arrow keys move to the row and Enter commits it", async () => {
  const wd = makeWorkday({ options: UW_RESULTS, match: "phrase", clickWorks: false });
  const ok = await load(wd).fillSearchPrompt(wd.multi, "University of Washington", {});
  assert.equal(ok, true, wd.S.log.join("\n"));
  assert.equal(wd.S.chip, "The University of Washington");
});
