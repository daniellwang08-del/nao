import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { ENGINES, detectPlatform } from "../src/engines.js";

const { oraclePhone, oraclePlanTiles, oracleTileScore } = await import("../src/panel/autofill/platforms.js");

// content/engine/oracle.js on top of dom.js, in a bare context (no DOM: only its pure helpers are exercised).
function oracle() {
  const window = { scrollX: 0, scrollY: 0 };
  const ctx = vm.createContext({ window, console, location: { pathname: "/hcmUI/CandidateExperience/en/sites/CX/job/1/apply/section/1", hostname: "x.fa.us2.oraclecloud.com" } });
  vm.runInContext(readFileSync(new URL("../content/engine/dom.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("../content/engine/oracle.js", import.meta.url), "utf8"), ctx);
  return window.__AF.oracle;
}

test("Oracle Candidate Experience pages use the Oracle engine (description, email gate, apply flow)", () => {
  for (const url of [
    "https://edqv.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/21003622",
    "https://edqv.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/21003622/apply/email",
    "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210612345/apply/section/2",
    "https://careers.example.com/hcmUI/CandidateExperience/en/sites/CX_1/job/42",
  ]) {
    assert.equal(detectPlatform({ pageUrl: url }), "oracle", url);
  }
  assert.equal(ENGINES.oracle.available, true);
  assert.equal(ENGINES.oracle.autoDiscover, true);
  assert.notEqual(detectPlatform({ pageUrl: "https://www.oracle.com/careers/" }), "oracle");
  assert.notEqual(detectPlatform({ pageUrl: "https://edqv.fa.us2.oraclecloud.com/fscmUI/faces/FuseWelcome" }), "oracle");
});

test("the phone splits into the dialing code and the national number, never the code twice", () => {
  assert.deepEqual(oraclePhone("+1 253-220-9979", "1"), { countryCode: "1", national: "2532209979" });
  assert.deepEqual(oraclePhone("2532209979", ""), { countryCode: "1", national: "2532209979" });
  assert.deepEqual(oraclePhone("(253) 220-9979", "1"), { countryCode: "1", national: "2532209979" });
  assert.deepEqual(oraclePhone("+44 7911 123456", "44"), { countryCode: "44", national: "7911123456" });
  assert.deepEqual(oraclePhone("", "1"), { countryCode: "1", national: "" });
});

const WORK = [
  { company: "Avanade", title: "Senior Software Engineer", startMMYYYY: "06/2021", endMMYYYY: "", current: true },
  { company: "Avanade", title: "Software Engineer", startMMYYYY: "07/2018", endMMYYYY: "05/2021" },
  { company: "Microsoft", title: "Software Engineer Intern", startMMYYYY: "06/2017", endMMYYYY: "09/2017" },
  { company: "Amazon", title: "SDE Intern", startMMYYYY: "06/2016", endMMYYYY: "09/2016" },
];

test("parsed experience tiles are matched to the resume entries they are, and the missing ones are added", () => {
  // Oracle's parse kept only the two latest jobs.
  const tiles = [
    { title: "Senior Software Engineer", subtitle: "Avanade 06/2021 - Present" },
    { title: "Software Engineer", subtitle: "Avanade 07/2018 - 05/2021" },
  ];
  const plan = oraclePlanTiles("experience", tiles, WORK);
  assert.deepEqual(plan.edits, [
    { tile: 0, entry: 0 },
    { tile: 1, entry: 1 },
  ]);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.adds, [2, 3]);
});

test("a garbled tile still takes a resume entry; tiles beyond the resume are removed", () => {
  const plan = oraclePlanTiles("experience", [{ title: "Unnamed Job Title", subtitle: "" }], WORK.slice(0, 1));
  assert.deepEqual(plan.edits, [{ tile: 0, entry: 0 }]);
  const extra = oraclePlanTiles("experience", [{ title: "Senior Software Engineer", subtitle: "Avanade" }, { title: "Unnamed Job Title", subtitle: "1 20-9979" }], WORK.slice(0, 1));
  assert.deepEqual(extra.edits, [{ tile: 0, entry: 0 }]);
  assert.deepEqual(extra.deletes, [1]);
});

test("education tiles match on the school even when the major is unnamed", () => {
  const edu = [
    { school: "University of Washington", degree: "Bachelor of Science", fieldOfStudy: "Computer Science", endMMYYYY: "06/2014" },
    { school: "Bellevue College", degree: "Associate of Arts", fieldOfStudy: "General Studies", endMMYYYY: "06/2010" },
  ];
  const tile = { title: "Unnamed Major", subtitle: "University of Washington 06/2014" };
  assert.ok(oracleTileScore("education", tile, edu[0]) > oracleTileScore("education", tile, edu[1]));
  const plan = oraclePlanTiles("education", [tile], edu);
  assert.deepEqual(plan.edits, [{ tile: 0, entry: 0 }]);
  assert.deepEqual(plan.adds, [1]);
});

test("resume dates, degrees and locations read the way Oracle's entry forms need them", () => {
  const { parseMonthYear, degreeLevel, splitLocation, bestText } = oracle()._test;
  assert.deepEqual({ ...parseMonthYear("06/2019") }, { month: 6, year: 2019 });
  assert.deepEqual({ ...parseMonthYear("2019-06") }, { month: 6, year: 2019 });
  assert.deepEqual({ ...parseMonthYear("Jun 2019") }, { month: 6, year: 2019 });
  assert.deepEqual({ ...parseMonthYear("2014") }, { month: 0, year: 2014 });
  assert.equal(parseMonthYear(""), null);

  assert.equal(degreeLevel("B.S. Computer Science"), "bachelor");
  assert.equal(degreeLevel("Bachelor's Degree"), "bachelor");
  assert.equal(degreeLevel("Master of Science"), "master");
  assert.equal(degreeLevel("MBA"), "master");
  assert.equal(degreeLevel("Ph.D."), "doctorate");
  assert.equal(degreeLevel("Associate of Arts"), "associate");
  assert.equal(degreeLevel("High School Diploma"), "highschool");

  assert.deepEqual({ ...splitLocation("Seattle, WA") }, { city: "Seattle", state: "WA", country: "" });
  assert.deepEqual({ ...splitLocation("Kent, Washington, United States") }, { city: "Kent", state: "Washington", country: "United States" });

  assert.equal(bestText(["Canada", "United States", "United States Minor Outlying Islands"], "United States of America"), "United States");
  assert.equal(bestText(["+1 (Canada)", "+1 (United States)", "+44 (United Kingdom)"], "United States"), "+1 (United States)");
});

test("auto-apply lists Oracle (and Dayforce, ADP) as their own sites and queues their jobs", async () => {
  const { EASE_TIER, PLATFORM_LABEL, SPLIT_FROM_GENERIC, platformOfUrl, rankJobs } = await import("../src/autoapply/platforms.js");
  for (const p of ["oracle", "dayforce", "adp"]) {
    assert.ok(EASE_TIER[p], p);
    assert.ok(PLATFORM_LABEL[p], p);
    assert.ok(SPLIT_FROM_GENERIC.includes(p), p);
  }
  const url = "https://edqv.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/21003622";
  assert.equal(platformOfUrl(url), "oracle");
  const ranked = rankJobs([{ id: "o1", url, title: "Software Engineer III" }], { allowed: new Set(Object.keys(EASE_TIER)) });
  assert.deepEqual(ranked.map((r) => [r.id, r.platform]), [["o1", "oracle"]]);
});

test("discovery targets the Greenhouse embed only when there is one; other pages ask every frame (iCIMS portal iframe)", async () => {
  const { pickGreenhouseFrame } = await import("../src/tab-messaging.js");
  // careers-usa-pro-cbi.icims.com: the portal page, the form in #icims_content_iframe.
  const icims = [
    { frameId: 0, parentFrameId: -1, url: "https://careers-usa-pro-cbi.icims.com/jobs/4221/data-engineer/candidate?from=login&eem=x&code=y" },
    { frameId: 7, parentFrameId: 0, url: "https://careers-usa-pro-cbi.icims.com/jobs/4221/data-engineer/candidate?from=login&in_iframe=1" },
    { frameId: 9, parentFrameId: 0, url: "about:blank" },
  ];
  assert.equal(pickGreenhouseFrame(icims), null);
  assert.equal(pickGreenhouseFrame([{ frameId: 0, url: "https://jobs.lever.co/x/y/apply" }]), null);
  const gh = [
    { frameId: 0, url: "https://www.example.com/careers/123" },
    { frameId: 4, url: "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123" },
  ];
  assert.equal(pickGreenhouseFrame(gh).frameId, 4);
});

test("answers in other words still find Oracle's options: currency codes and pay frequencies", () => {
  const { bestAlt } = oracle()._test;
  const currencies = ["Australian Dollar", "Canadian Dollar", "Euro", "Pound Sterling", "US Dollar", "Yen"];
  assert.equal(bestAlt(currencies, "USD"), "US Dollar");
  assert.equal(bestAlt(currencies, "United States Dollar"), "US Dollar");
  assert.equal(bestAlt(currencies, "GBP"), "Pound Sterling");
  const freq = ["Daily", "Weekly", "Biweekly", "Monthly", "Yearly", "monthly over 13 times a year", "monthly over 12 times a year", "Semi-Monthly"];
  assert.equal(bestAlt(freq, "Annually"), "Yearly");
  assert.equal(bestAlt(freq, "Annual"), "Yearly");
  assert.equal(bestAlt(freq, "Bi-weekly"), "Biweekly");
  assert.equal(bestAlt(freq, "Twice a month"), "Semi-Monthly");
  assert.equal(bestAlt(freq, "Monthly"), "Monthly");
});

test("the address search picks the suggestion that is the candidate's address", () => {
  const { addressMatcher } = oracle()._test;
  const pick = addressMatcher({ line1: "4410 128th Place Southeast", city: "Kent", state: "WA", postalCode: "98030" });
  const items = [
    "4410 128TH SE PLACE, KENT, WASHINGTON",
    "4410 128TH SE PLACE, KENT, WASHINGTON, 98030",
    "4410 128TH SE PL, SEATTLE METRO AREA, WASHINGTON",
    "4410 148th Pl SE, KENT, WASHINGTON",
    "4410 128TH SE PLACE, SEATTLE METRO AREA, WASHINGTON, 98030",
  ];
  assert.equal(pick(items, (x) => x), "4410 128TH SE PLACE, KENT, WASHINGTON, 98030");
  assert.equal(pick(["9 OTHER ST, KENT, WASHINGTON"], (x) => x), null);
});
