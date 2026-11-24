// Greenhouse Location (City): pick the geocoder suggestion that fits the profile's city AND state, never the top row
// blindly. 2026-11-24: "Staten Island, NY" committed a New Jersey place that the geocoder listed first, although
// "New York, NY, USA" (the city that contains Staten Island) was in the list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../content/engine/greenhouse.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (head) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `missing ${head}`);
  return src.slice(i, src.indexOf("\n  }\n", i) + 4);
};
const start = src.indexOf("  // ── location matching (pure");
const end = src.indexOf("  // ── end location matching ──");
assert.ok(start > 0 && end > start, "location matching block");
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const api = new Function(
  "clean",
  `${grab("  function isUsCountryToken(")}\n${grab("  function isCountryToken(")}\n${grab("  function locationQueries(")}\n` +
    `${src.slice(start, end)}\nreturn { parseWantedLocation, scoreLocationOption, pickLocationOption, locationAttempts };`
)(clean);
const { parseWantedLocation, pickLocationOption, locationAttempts, scoreLocationOption } = api;

const pick = (value, options, min) => {
  const i = pickLocationOption(options, parseWantedLocation(value), min);
  return i < 0 ? null : options[i];
};

test("Staten Island never commits the New Jersey place the geocoder ranks first", () => {
  const options = ["Staten Island Functions, Hoboken, New Jersey, USA", "New York, NY, USA", "Staten Island, NY, USA"];
  assert.equal(pick("Staten Island, NY", options, 70), "Staten Island, NY, USA");
  // Not listed itself: the city that contains it.
  const noBorough = ["Staten Island Functions, New Jersey, USA", "New York, NY, USA", "Island Park, NY, USA"];
  assert.equal(pick("Staten Island, NY, USA", noBorough, 70), "New York, NY, USA");
  // Only other-state places: nothing is committed on this query.
  assert.equal(pick("Staten Island, NY", ["Staten Island Functions, New Jersey, USA"], 70), null);
});

test("the profile location is read into city, state and containing city", () => {
  assert.deepEqual(parseWantedLocation("Staten Island, NY, USA"), {
    city: "Staten Island", region: "NY", regionName: "New York", container: "New York",
  });
  assert.equal(parseWantedLocation("Austin, Texas").region, "TX");
  assert.equal(parseWantedLocation("Toronto, ON, Canada").region, "ON");
  assert.equal(parseWantedLocation("Remote").region, null);
  // A city name split by a comma in the profile.
  assert.deepEqual([parseWantedLocation("Delray, Beach, FL, United States of America").city,
    parseWantedLocation("Delray, Beach, FL, United States of America").region], ["Delray Beach", "FL"]);
  assert.equal(parseWantedLocation("Oświęcim, PL, PL").region, null);
});

test("a same-named city in another state is never picked", () => {
  const options = ["Portland, OR, USA", "Portland, ME, USA"];
  assert.equal(pick("Portland, ME", options, 70), "Portland, ME, USA");
  assert.equal(pick("Springfield, IL", ["Springfield, MO, USA", "Springfield, MA, USA"], 70), null);
  assert.equal(scoreLocationOption("Newark, NJ, USA", parseWantedLocation("Newark, CA, USA")), -1);
});

test("fallback queries accept the containing city or the state, never another state", () => {
  const attempts = locationAttempts("Staten Island, NY, USA").map((a) => `${a.query}@${a.min}`);
  assert.deepEqual(attempts, [
    "Staten Island, NY@70", "Staten Island, New York@70", "New York, NY@40", "Staten Island@70", "New York@40",
  ]);
  // A small town missing from the geocoder: the state on the last query.
  assert.equal(pick("Tinyville, NJ", ["New Jersey, USA", "New York, NY, USA"], 40), "New Jersey, USA");
  assert.equal(pick("Tinyville, NJ", ["New Jersey, USA"], 70), null);
});

test("a profile without a state keeps the geocoder's ranking", () => {
  assert.equal(pick("Berlin", ["Berlin, Germany", "Berlin, NH, USA"], 10), "Berlin, Germany");
  assert.deepEqual(locationAttempts("Berlin").map((a) => a.query), ["Berlin"]);
});
