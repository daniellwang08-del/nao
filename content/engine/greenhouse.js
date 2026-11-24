// Greenhouse (boards.greenhouse.io / job-boards embed) helpers.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, delay, waitUntil, isVisible, setNativeValue, fireInput, labelForControl } = AF.dom;

  function isGreenhouseHost() {
    try {
      return /(?:^|\.)greenhouse\.io$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  function hasApplicationRoot() {
    try {
      return !!document.querySelector(
        'form#application-form, form.application--form, .application--container, .application--form'
      );
    } catch {
      return false;
    }
  }

  function isApplicationFrame() {
    return isGreenhouseHost() && hasApplicationRoot();
  }

  function isEmbedParent() {
    try {
      if (window.top !== window) return false;
      return !!document.querySelector(
        'iframe[src*="greenhouse.io"][src*="embed/job_app"], iframe[src*="greenhouse.io/embed/job_app"]'
      );
    } catch {
      return false;
    }
  }

  function embedIframe() {
    try {
      if (window.top !== window) return null;
      return (
        document.querySelector('iframe[src*="greenhouse.io/embed/job_app"]') ||
        document.querySelector('iframe[src*="greenhouse.io"][src*="job_app"]')
      );
    } catch {
      return null;
    }
  }

  AF.greenhouse = {
    isGreenhouseHost,
    hasApplicationRoot,
    isApplicationFrame,
    isEmbedParent,
    embedIframe,
  };

  // ── Location (City) typeahead ───────────────────────────────────────────────
  //
  // Greenhouse's Location field is a react-aria combobox (role="combobox",
  // aria-autocomplete="list") backed by an async, debounced geocoder
  // (api-geocode-earth-proxy.greenhouse.io). It renders a role="listbox" of
  // role="option" rows as you type, and ONLY commits when an option is picked -
  // which populates the field's hidden latitude/longitude inputs. Per Greenhouse's
  // public Job Board API, if `location` is submitted without latitude/longitude it
  // is IGNORED entirely, and the form rejects the submit with a "Location required"
  // error even though the visible box shows the typed text.
  //
  // The generic react-select driver cannot fill this: (1) it sets the value with a
  // single bulk setNativeValue + one input event, which usually does not trip the
  // debounced geocoder, so the listbox never opens and Enter commits nothing; and
  // (2) it verifies success by looking for a .select__single-value chip node that a
  // react-aria combobox never renders, so even a real pick is reported "skipped".
  // We therefore own this field here - progressive typing to trip the geocoder,
  // wait for the listbox, commit via Enter / ArrowDown+Enter / click the top row,
  // and verify the hidden lat/lng actually committed (mirrors lever-location).

  function isUsCountryToken(s) {
    return /^(united states( of america)?|u\.?s\.?a?\.?)$/i.test(clean(s || ""));
  }

  // A TRAILING country token the Greenhouse Location combobox does NOT want. The
  // autofill prompt makes the model output "City, State, Country" (e.g.
  // "Newark, CA, USA"), but the geocoder (api-geocode-earth-proxy) matches on
  // "City, Region" - appending the country empties/degrades the suggestion list,
  // so the dropdown never opens. Only ever tested against the LAST comma part.
  function isCountryToken(s) {
    const t = clean(s || "");
    if (!t) return false;
    return (
      isUsCountryToken(t) ||
      /^(us|usa)$/i.test(t) ||
      /^(canada|can)$/i.test(t) ||
      /^(united kingdom|u\.?k\.?|great britain|england|scotland|wales)$/i.test(t) ||
      /^(australia|aus|new zealand|india|ireland|germany|france|spain|italy|portugal|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|mexico|brazil|argentina|japan|china|singapore|philippines|indonesia|malaysia|vietnam|south africa|nigeria|kenya|egypt|uae|united arab emirates|israel|turkey|greece)$/i.test(
        t
      )
    );
  }

  // Ordered geocoder queries, SHORTEST-useful first. We type "City, State" up
  // front (what the dropdown matches best) and NEVER lead with the full
  // country-appended string: typing "Newark, CA, USA" makes the geocoder return
  // nothing, so the old code wasted the whole 3s dropdown timeout before falling
  // back. City-only is kept as a last resort.
  function locationQueries(value) {
    const text = clean(value);
    if (!text) return [];
    let parts = text.split(",").map((x) => clean(x)).filter(Boolean);
    // Drop a trailing country token so we submit "City, State" (per the prompt
    // the model's 3rd part is the country).
    if (parts.length >= 3 && isCountryToken(parts[parts.length - 1])) {
      parts = parts.slice(0, -1);
    }
    const out = [];
    if (parts.length >= 2) {
      // "City, State" - the geocoder's best match; commit on the first attempt.
      out.push(`${parts[0]}, ${parts[1]}`);
      // Uppercase a 2-letter state code ("ca" -> "CA") as an equivalent variant.
      if (/^[A-Za-z]{2}$/.test(parts[1]) && !isCountryToken(parts[1])) {
        out.push(`${parts[0]}, ${parts[1].toUpperCase()}`);
      }
      out.push(parts[0]);
    } else if (parts.length === 1) {
      out.push(parts[0]);
    }
    return [...new Set(out)].filter(Boolean);
  }

  // ── location matching (pure; unit-tested in test/greenhouseLocation.test.mjs) ──
  //
  // The geocoder's top suggestion is not always in the candidate's state: "Staten Island, NY" listed a
  // New Jersey venue first, and pressing Enter committed it (2026-11-24). Every suggestion is now scored
  // against the profile's city AND state; one in another state is never picked. When the city itself is not
  // listed, the larger city that contains it ("Staten Island" -> "New York") or the state is used instead.

  const US_STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii",
    ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
    ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
    MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
    TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
  };
  const CA_PROVINCES = {
    AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
    NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
    QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
  };
  const REGION_NAMES = Object.assign({}, US_STATES, CA_PROVINCES);
  const REGION_CODE = {};
  for (const [code, name] of Object.entries(REGION_NAMES)) {
    REGION_CODE[code.toLowerCase()] = code;
    REGION_CODE[name.toLowerCase()] = code;
  }
  REGION_CODE["washington dc"] = "DC";
  REGION_CODE["d.c."] = "DC";
  REGION_CODE["québec"] = "QC";

  // Boroughs and neighbourhoods geocoders often do not list as places of their own, with the city that
  // contains them (key: "place|REGION").
  const CONTAINING_CITY = {
    "staten island|NY": "New York", "brooklyn|NY": "New York", "queens|NY": "New York", "bronx|NY": "New York",
    "the bronx|NY": "New York", "manhattan|NY": "New York", "long island city|NY": "New York",
    "flushing|NY": "New York", "astoria|NY": "New York", "jamaica|NY": "New York", "harlem|NY": "New York",
    "forest hills|NY": "New York", "bayside|NY": "New York", "williamsburg|NY": "New York",
    "jackson heights|NY": "New York", "ridgewood|NY": "New York", "far rockaway|NY": "New York",
    "hollywood|CA": "Los Angeles", "north hollywood|CA": "Los Angeles", "van nuys|CA": "Los Angeles",
    "sherman oaks|CA": "Los Angeles", "encino|CA": "Los Angeles", "woodland hills|CA": "Los Angeles",
    "studio city|CA": "Los Angeles", "northridge|CA": "Los Angeles", "reseda|CA": "Los Angeles",
    "canoga park|CA": "Los Angeles", "tarzana|CA": "Los Angeles", "chatsworth|CA": "Los Angeles",
    "san pedro|CA": "Los Angeles", "venice|CA": "Los Angeles", "westwood|CA": "Los Angeles",
    "playa vista|CA": "Los Angeles", "wilmington|CA": "Los Angeles", "la jolla|CA": "San Diego",
    "dorchester|MA": "Boston", "roxbury|MA": "Boston", "jamaica plain|MA": "Boston", "south boston|MA": "Boston",
    "charlestown|MA": "Boston", "brighton|MA": "Boston", "allston|MA": "Boston", "hyde park|MA": "Boston",
    "germantown|PA": "Philadelphia", "manayunk|PA": "Philadelphia", "hyde park|IL": "Chicago",
    "lincoln park|IL": "Chicago", "wicker park|IL": "Chicago", "ballard|WA": "Seattle",
    "capitol hill|WA": "Seattle", "georgetown|DC": "Washington",
  };

  function placeKey(s) {
    return clean(String(s || "").replace(/[.]/g, "")).toLowerCase();
  }

  function regionCodeOf(s) {
    return REGION_CODE[placeKey(s)] || null;
  }

  // "Staten Island, NY, USA" -> { city: "Staten Island", region: "NY", regionName: "New York", container: "New York" }
  function parseWantedLocation(value) {
    let parts = clean(value).split(",").map((x) => clean(x)).filter(Boolean);
    if (parts.length >= 2 && isCountryToken(parts[parts.length - 1])) parts = parts.slice(0, -1);
    // The state is the last part that names one; everything before it is the city (a profile may split a city
    // name with a comma: "Delray, Beach, FL").
    let at = -1;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (regionCodeOf(parts[i])) {
        at = i;
        break;
      }
    }
    const city = at > 0 ? parts.slice(0, at).join(" ") : parts[0] || "";
    const region = at > 0 ? regionCodeOf(parts[at]) : null;
    return {
      city,
      region,
      regionName: region ? REGION_NAMES[region] : "",
      container: region ? CONTAINING_CITY[`${placeKey(city)}|${region}`] || "" : "",
    };
  }

  // The region a suggestion is in: the first part after its name that is a state or province.
  function optionRegion(text) {
    const parts = clean(text).split(",").map((x) => clean(x)).filter(Boolean);
    for (const p of parts.slice(1)) {
      const code = regionCodeOf(p);
      if (code) return code;
    }
    // A state-level suggestion is the region itself ("New Jersey, USA").
    if (parts.length && parts.slice(1).every((p) => isCountryToken(p))) return regionCodeOf(parts[0]);
    return null;
  }

  // How well a suggestion fits the profile location; -1 = never pick it.
  //  100 the city in the right state · 80 a name containing the city there · 70 the city that contains it
  //  45 the state itself · 40 another place in the same state · legacy ranking when the profile has no state.
  function scoreLocationOption(text, wanted) {
    const parts = clean(text).split(",").map((x) => clean(x)).filter(Boolean);
    if (!parts.length) return -1;
    const name = placeKey(parts[0]);
    const city = placeKey(wanted.city);
    if (wanted.region) {
      const region = optionRegion(text);
      if (!region) return name && name === city ? 30 : -1;
      if (region !== wanted.region) return -1;
      if (name === city) return 100;
      if (city && name && (name.includes(city) || city.includes(name)) && regionCodeOf(parts[0]) !== region) return 80;
      if (wanted.container && name === placeKey(wanted.container)) return 70;
      if (regionCodeOf(parts[0]) === region) return 45;
      return 40;
    }
    if (name === city) return 60;
    if (city && name && (name.includes(city) || city.includes(name))) return 50;
    return 10;
  }

  // The index of the suggestion to pick, or -1. ``minScore`` is 70 for the city's own queries (exact, containing
  // or containing-city match only) and 40 for the fallback queries (the containing city, the state).
  function pickLocationOption(texts, wanted, minScore) {
    let best = -1;
    let bestScore = -1;
    texts.forEach((t, i) => {
      const s = scoreLocationOption(t, wanted);
      if (s > bestScore) {
        best = i;
        bestScore = s;
      }
    });
    return bestScore >= minScore ? best : -1;
  }

  // Ordered (query, minScore) attempts for a profile location.
  function locationAttempts(value) {
    const wanted = parseWantedLocation(value);
    if (!wanted.city) return [];
    if (!wanted.region) return locationQueries(value).map((q) => ({ query: q, min: 10 }));
    const out = [
      { query: `${wanted.city}, ${wanted.region}`, min: 70 },
      { query: `${wanted.city}, ${wanted.regionName}`, min: 70 },
    ];
    if (wanted.container) out.push({ query: `${wanted.container}, ${wanted.region}`, min: 40 });
    out.push({ query: wanted.city, min: 70 });
    out.push({ query: wanted.regionName, min: 40 });
    const seen = new Set();
    return out.filter((a) => a.query && !seen.has(a.query.toLowerCase()) && seen.add(a.query.toLowerCase()));
  }
  // ── end location matching ──

  // Shared with the other geocoded location typeaheads in this bundle (Lever).
  AF.locationMatch = { parseWantedLocation, scoreLocationOption, pickLocationOption, locationAttempts };

  function locationFieldBlock(el) {
    return (
      (el.closest &&
        (el.closest('[class*="field"]') ||
          el.closest('[class*="question"]') ||
          el.closest("fieldset") ||
          el.closest("label"))) ||
      el.parentElement ||
      el
    );
  }

  // Hidden latitude/longitude inputs that ONLY get set when a suggestion commits.
  // They live in the same field block as the visible combobox.
  function locationHiddenFields(el) {
    const out = [];
    const scopes = [locationFieldBlock(el), el.parentElement, document.getElementById("application-form")].filter(
      Boolean
    );
    for (const scope of scopes) {
      try {
        scope.querySelectorAll('input[type="hidden"]').forEach((h) => {
          const key = ((h.name || "") + " " + (h.id || "")).toLowerCase();
          if (/(^|[^a-z])(lat|latitude|lng|lon|long|longitude)([^a-z]|$)/.test(key)) out.push(h);
        });
      } catch {}
      if (out.length) break;
    }
    return [...new Set(out)];
  }

  function locationIsCommitted(el) {
    const hidden = locationHiddenFields(el);
    if (hidden.length) return hidden.some((h) => clean(h.value));
    // No hidden fields locatable in this build: fall back to "the box shows a
    // multi-part geocoded value" (a picked result is "City, Region, Country",
    // never a bare fragment the user typed).
    const v = clean(el.value);
    return !!v && v.split(",").filter(Boolean).length >= 2;
  }

  // The listbox belonging to THIS combobox (aria-controls / aria-owns), plus
  // legacy fallbacks (Google Places .pac-container, jQuery-UI .ui-autocomplete).
  function locationOptionNodes(input) {
    const nodes = [];
    const push = (list) => {
      if (!list) return;
      list.forEach((n) => {
        try {
          if (clean(n.textContent) && isVisible(n)) nodes.push(n);
        } catch {}
      });
    };
    try {
      const id = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
      const lb = id && document.getElementById(id);
      if (lb) push(lb.querySelectorAll('[role="option"], li[role="option"]'));
    } catch {}
    if (!nodes.length) {
      const active = document.querySelector('[role="listbox"]');
      if (active) push(active.querySelectorAll('[role="option"], li[role="option"]'));
    }
    push(document.querySelectorAll(".pac-container .pac-item"));
    push(document.querySelectorAll("ul.ui-autocomplete li.ui-menu-item, ul.ui-autocomplete li"));
    return [...new Set(nodes)];
  }

  function pressKey(el, key, keyCode) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, key, code: key, keyCode, which: keyCode };
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, opts));
    }
  }

  // Open/activate the react-aria combobox BEFORE typing. These widgets ignore
  // programmatic `input` events while the popup is closed, so we must first put
  // the field into its open state with the full pointer+mouse+click sequence
  // (libraries disagree on which event opens the menu) plus an ArrowDown fallback,
  // exactly like the react-select driver's openCombo. Without this, the geocoder
  // never fires and the suggestion listbox never mounts.
  function openLocationCombo(input) {
    try {
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {}
    }
    try {
      input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    try {
      input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    try {
      input.click();
    } catch {}
    pressKey(input, "ArrowDown", 40);
  }

  // Type character-by-character so the debounced geocoder fires like real typing;
  // a single bulk setNativeValue frequently never opens the suggestion listbox.
  // The combobox must already be open (see openLocationCombo) before we type.
  async function typeLocationQuery(input, text) {
    openLocationCombo(input);
    await delay(120);
    setNativeValue(input, "");
    fireInput(input);
    await delay(60);
    let built = "";
    for (const ch of String(text)) {
      built += ch;
      // Fire a key event pair around each character so react-aria's keyboard
      // handlers register the interaction and keep the popup open.
      pressKey(input, ch, ch.charCodeAt(0));
      setNativeValue(input, built);
      fireInput(input);
      await delay(30);
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickOption(pick) {
    try {
      pick.scrollIntoView && pick.scrollIntoView({ block: "nearest" });
    } catch {}
    try {
      pick.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    try {
      pick.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    pick.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      pick.click();
    } catch {}
  }

  // The committed value fits the profile location (right city / containing city / state, never another state).
  function committedFits(input, wanted, minScore) {
    if (!locationIsCommitted(input)) return false;
    const v = clean(input.value);
    // No readable value (some builds clear the box after commit): trust the scored pick.
    return !v || scoreLocationOption(v, wanted) >= Math.min(minScore, 40);
  }

  async function writeLocationInput(input, value) {
    const attempts = locationAttempts(value);
    if (!input || !attempts.length) return false;
    const wanted = parseWantedLocation(value);
    // Already committed to a place that fits (a rerun, or the board's own autofill): keep it. A commit in another
    // state (the old top-row pick) is replaced.
    if (locationIsCommitted(input) && clean(input.value) && scoreLocationOption(input.value, wanted) >= 70) {
      return true;
    }

    for (const { query, min } of attempts) {
      await typeLocationQuery(input, query);

      const opened = await waitUntil(() => (locationOptionNodes(input).length ? true : null), 3000, 80);
      if (!opened) continue;
      // Let the debounced geocoder settle on this query's full result list.
      await delay(250);
      const opts = locationOptionNodes(input);
      const index = pickLocationOption(opts.map((o) => clean(o.textContent)), wanted, min);
      if (index < 0) continue; // nothing here fits the profile's city or state: never commit a wrong place

      // Click the chosen row (react-aria commits on mousedown+click and fills the hidden lat/lng).
      clickOption(opts[index]);
      if (await waitUntil(() => (committedFits(input, wanted, min) ? true : null), 1400, 60)) {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return true;
      }

      // Keyboard fallback: highlight the chosen row, then Enter.
      await typeLocationQuery(input, query);
      if (await waitUntil(() => (locationOptionNodes(input).length ? true : null), 3000, 80)) {
        await delay(250);
        const again = locationOptionNodes(input);
        const i2 = pickLocationOption(again.map((o) => clean(o.textContent)), wanted, min);
        if (i2 >= 0) {
          for (let k = 0; k <= i2; k++) {
            pressKey(input, "ArrowDown", 40);
            await delay(40);
          }
          pressKey(input, "Enter", 13);
          if (await waitUntil(() => (committedFits(input, wanted, min) ? true : null), 1400, 60)) {
            input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
            return true;
          }
        }
      }
    }

    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // Only succeed when a fitting pick committed - a typed-but-uncommitted value is dropped by Greenhouse on
    // submit, and a place in another state is wrong.
    return committedFits(input, wanted, 40);
  }

  function locationLabelBlob(el) {
    return [
      labelForControl(el),
      el.id || "",
      el.name || "",
      (el.getAttribute && el.getAttribute("aria-label")) || "",
      (el.getAttribute && el.getAttribute("placeholder")) || "",
    ]
      .join(" ")
      .toLowerCase();
  }

  // The Location (City) combobox specifically - not EEOC / screening comboboxes
  // (whose labels are Gender/Veteran/... and which carry no lat/lng hidden inputs).
  function isLocationField(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const t = (el.type || "text").toLowerCase();
    if (["hidden", "file", "checkbox", "radio", "submit", "button", "tel", "email"].includes(t)) return false;
    const blob = locationLabelBlob(el);
    if (/\blocation\b|\bcity\b/.test(blob)) return true;
    // Attribute-agnostic fallback: a text/combobox input backed by hidden lat/lng.
    return locationHiddenFields(el).length > 0;
  }

  // Priority 12 (below react-select's 20) so we claim the Greenhouse location box
  // before the generic combobox driver. Host-gated to greenhouse.io application
  // frames so the shared "greenhouse" bundle never hijacks Lever/Ashby/etc.
  AF.registerDriver({
    type: "greenhouse-location",
    priority: 12,
    match(el) {
      if (!isApplicationFrame()) return null;
      return isLocationField(el) ? el : null;
    },
    cidEl(root) {
      return root;
    },
    extract(root) {
      return {
        kind: "text",
        label: labelForControl(root) || "Location (City)",
        required:
          !!root.required ||
          (root.getAttribute && root.getAttribute("aria-required") === "true"),
        constraints: AF.dom.constraintsOf(root),
      };
    },
    isFilled(root) {
      // Visible text is not enough - Greenhouse only accepts a committed geocode
      // pick (hidden latitude/longitude populated).
      return locationIsCommitted(root);
    },
    async write(root, answer) {
      return writeLocationInput(root, answer.value || answer.option || "");
    },
  });

  // ── required free-text safety net ───────────────────────────────────────────
  //
  // Some Greenhouse questions are REQUIRED free-text (e.g. an open-ended
  // availability / "describe your upcoming commitments" textarea). When the
  // profile has no fact for them the model returns needs_user or omits the
  // control entirely, so the field is left empty - and Greenhouse then blocks the
  // submit with "This field is required". After the model's passes, this
  // deterministically fills any still-empty VISIBLE REQUIRED free-text field with
  // "N/A" (the same convention the server prompt uses for required conditional
  // follow-ups). Restricted to <input type="text"> / <textarea>: email/tel/
  // number/url carry patterns "N/A" would fail, and select/radio/checkbox have
  // their own handling. The Location combobox and any react-select combobox input
  // are explicitly excluded. We never auto-submit; the user reviews before send.

  function ghApplicationRoot() {
    try {
      return (
        document.querySelector(
          "form#application-form, form.application--form, .application--container, .application--form"
        ) || document
      );
    } catch {
      return document;
    }
  }

  function isFreeTextFillable(el) {
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    const t = (el.type || "text").toLowerCase();
    return t === "text" || t === "";
  }

  function isRequiredField(el) {
    try {
      if (el.required || (el.getAttribute && el.getAttribute("aria-required") === "true")) return true;
      // Greenhouse marks a required question with a trailing "*" in its label.
      const lbl = labelForControl(el) || "";
      if (/\*\s*$/.test(lbl) || /\brequired\b/i.test(lbl)) return true;
    } catch {}
    return false;
  }

  function shouldSkipRequiredFill(el) {
    try {
      if (el.readOnly || el.disabled) return true;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
      // The Location combobox commits via geocode, never a free-text "N/A".
      if (isLocationField(el)) return true;
      // react-select / combobox inner inputs are filled by their own driver.
      const role = (el.getAttribute && el.getAttribute("role")) || "";
      if (role === "combobox") return true;
      if (el.getAttribute && el.getAttribute("aria-autocomplete") === "list") return true;
      if (el.getAttribute && el.getAttribute("aria-haspopup") === "listbox") return true;
      if (el.closest && el.closest('[class*="select__control"], [class*="-control"], [role="combobox"]')) return true;
    } catch {}
    return false;
  }

  function fillRequiredPlaceholders(placeholder) {
    if (!isApplicationFrame()) return 0;
    const val = placeholder || "N/A";
    const root = ghApplicationRoot();
    let count = 0;
    let controls = [];
    try {
      controls = [...root.querySelectorAll("input, textarea")];
    } catch {
      controls = [];
    }
    for (const el of controls) {
      try {
        if (!isFreeTextFillable(el)) continue;
        if (shouldSkipRequiredFill(el)) continue;
        if (!isVisible(el)) continue;
        if (!isRequiredField(el)) continue;
        if (clean(el.value)) continue; // already answered
        setNativeValue(el, val);
        fireInput(el);
        try {
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {}
        count++;
      } catch {}
    }
    return count;
  }

  AF.greenhouse.fillRequiredPlaceholders = fillRequiredPlaceholders;
})();
