// Radio / checkbox group driver.
//
// A group is the set of <input type="radio|checkbox"> sharing a name. The first
// input claims the group; `consumes` reports its siblings so they aren't each
// treated as a separate control. Options are the per-input labels.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, containsWord, labelForControl } = AF.dom;

  function scopeOf(el) {
    return (el.closest && el.closest("form, fieldset, [role='group'], [role='radiogroup']")) || document;
  }

  // ApplyToJob (JazzHR) checkbox questions give every option its own name,
  // "resumator-checkbox-<question>-<n>", and label the question on a hidden
  // "resumator-questionnaire-q<question>" input. One question, one group.
  const ATJ_CHECKBOX = /^resumator-checkbox-(\d+)-\d+$/;

  function atjQuestion(el) {
    const m = el && el.type === "checkbox" && ATJ_CHECKBOX.exec(el.name || "");
    return m ? m[1] : null;
  }

  function atjGroupInputs(root) {
    const q = atjQuestion(root);
    if (!q) return null;
    const scope = (root.closest && root.closest("form")) || document;
    return [...scope.querySelectorAll('input[type="checkbox"]')].filter((x) => atjQuestion(x) === q);
  }

  function atjQuestionTitle(root) {
    const q = atjQuestion(root);
    const lab = q && document.getElementById("resumator-questionnaire-q" + q + "-label");
    return lab ? clean(lab.innerText).slice(0, 200) : "";
  }

  // Yes / No answers are one choice even when the page draws them as checkboxes.
  function isExclusivePair(group) {
    if (group.length !== 2) return false;
    const opts = group.map((i) => clean(optionTextFor(i)).toLowerCase()).sort();
    return opts[0] === "no" && opts[1] === "yes";
  }

  function groupInputs(root) {
    const atj = atjGroupInputs(root);
    if (atj && atj.length) return atj;
    try {
      if (AF.workable && AF.workable.applicationGroupInputs) {
        const wb = AF.workable.applicationGroupInputs(root);
        if (wb && wb.length) return wb;
      }
    } catch {}
    // Ashby multi-select checkboxes use a UNIQUE name per option (the option
    // label). Probe: uniqueNames===count===12 on race/ethnicity. Group by the
    // enclosing fieldset so we emit one multi=true control, not 12 singles.
    try {
      if (AF.ashby && AF.ashby.checkboxGroupInputs) {
        const ab = AF.ashby.checkboxGroupInputs(root);
        if (ab && ab.length) return ab;
      }
    } catch {}
    // Dayforce: Ant checkbox groups have no name; the group is the .ant-checkbox-group / .ant-radio-group.
    try {
      if (AF.dayforce && AF.dayforce.groupInputs) {
        const df = AF.dayforce.groupInputs(root);
        if (df && df.length) return df;
      }
    } catch {}
    const t = (root.type || "radio").toLowerCase();
    const name = root.name || "";
    const scope = scopeOf(root);
    if (!name) return [root];
    try {
      return [...scope.querySelectorAll('input[type="' + t + '"]')].filter((x) => (x.name || "") === name);
    } catch {
      return [root];
    }
  }

  function groupLabel(root) {
    const atjTitle = atjQuestionTitle(root);
    if (atjTitle) return atjTitle;
    try {
      if (AF.dayforce && AF.dayforce.isDayforcePage && AF.dayforce.isDayforcePage()) {
        const q = AF.dayforce.questionTitleFor(root);
        if (q) return q.slice(0, 200);
      }
    } catch {}
    const fs = root.closest && root.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg && clean(lg.innerText)) return clean(lg.innerText).slice(0, 200);
    }
    // Workable post-submit survey: question text is on the outer fieldset legend
    // inside [data-ui="question"]; the inner radiogroup fieldset has no legend.
    try {
      if (AF.workable && AF.workable.questionTitleFor) {
        const q = AF.workable.questionTitleFor(root);
        if (q) return q;
      }
      if (AF.workable && AF.workable.applicationQuestionTitleFor) {
        const q = AF.workable.applicationQuestionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    // Ashby EEO groups are a <fieldset> whose question is a sibling <label
    // class="ashby-application-form-question-title"> (no <legend>); each radio's
    // own label[for] is just its option text ("Male"), so labelForControl(root)
    // would mislabel the whole group. Prefer the field's question title.
    const entry =
      root.closest && root.closest("fieldset, .ashby-application-form-field-entry, [data-field-path]");
    if (entry && entry.querySelector) {
      const q = entry.querySelector(".ashby-application-form-question-title");
      if (q && clean(q.innerText)) return clean(q.innerText).slice(0, 200);
    }
    const grp = root.closest && root.closest("[aria-labelledby]");
    if (grp) {
      const t = AF.dom.textOfIds(grp.getAttribute("aria-labelledby"));
      if (t) return t.slice(0, 200);
    }
    // Pinpoint boolean / screening questions: title in .external-form__label--title.
    try {
      if (AF.pinpoint && AF.pinpoint.questionTitleFor) {
        const q = AF.pinpoint.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    // Lever checkbox / radio groups: question in .application-label.
    try {
      if (AF.lever && AF.lever.questionLabelFor) {
        const q = AF.lever.questionLabelFor(root);
        if (q) return q;
      }
    } catch {}
    // Breezy: question in preceding <h3> inside li.question or .section.
    try {
      if (AF.breezy && AF.breezy.questionTitleFor) {
        const q = AF.breezy.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    // Manatal: consent / field labels from .form-group or sibling <span>.
    try {
      if (AF.manatal && AF.manatal.questionTitleFor) {
        const q = AF.manatal.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    // JobDiva: SMS/consent checkbox label from wrapping text.
    try {
      if (AF.jobdiva && AF.jobdiva.questionTitleFor) {
        const q = AF.jobdiva.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    // Jobvite: radio/checkbox question text lives in the fieldset <legend>.
    try {
      if (AF.jobvite && AF.jobvite.questionTitleFor) {
        const q = AF.jobvite.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    // iCIMS: label[for] in the row's .iCIMS_InfoField, qualified by collection.
    try {
      if (AF.icims && AF.icims.questionTitleFor) {
        const q = AF.icims.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    const own = labelForControl(root);
    try {
      const inputs = groupInputs(root);
      if (inputs.length > 1 && inputs.some((i) => clean(optionTextFor(i)) === clean(own))) {
        const title = sectionTitleFor(inputs);
        if (title) return title;
      }
    } catch {}
    return own;
  }

  // A group labelled only by its options (ApplyToJob's veteran radios) takes the
  // bold heading of the control-free block just before it ("Invitation for Job
  // Applicants to Self-Identify as a U.S. Veteran").
  function sectionTitleFor(inputs) {
    let box = inputs[0].parentElement;
    while (box && !inputs.every((i) => box.contains(i))) box = box.parentElement;
    for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
      if (box.tagName === "FORM" || box.tagName === "BODY") return "";
      for (let prev = box.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (prev.querySelector("input, select, textarea, button")) return "";
        const head = prev.matches("strong, b, h1, h2, h3, h4, h5, h6, legend")
          ? prev
          : prev.querySelector("strong, b, h1, h2, h3, h4, h5, h6, legend");
        if (head && clean(head.innerText)) return clean(head.innerText).slice(0, 200);
        if (clean(prev.innerText)) return "";
      }
    }
    return "";
  }

  // Score how well an option (label/value) matches a wanted answer. Exact wins
  // decisively over any substring match. This MUST be ranked, not first-hit:
  // every race option ends with "(Not Hispanic or Latino)", so a first-hit
  // substring scan picks "Hispanic or Latino" for an answer of "Asian (Not
  // Hispanic or Latino)" (the answer literally contains that substring). With
  // scoring, the exact "Asian (Not Hispanic or Latino)" option (100) beats the
  // loose "Hispanic or Latino" substring (30).
  function scoreMatch(lt, val, w) {
    if (!w) return 0;
    if (lt === w || val === w) return 100; // exact label / value
    // YES/NO screening answers often arrive as boolean strings.
    if (w === "yes" || w === "true") {
      if (lt === "yes" || val === "yes" || val === "true" || lt === "true") return 95;
    }
    if (w === "no" || w === "false") {
      if (lt === "no" || val === "no" || val === "false" || lt === "false") return 95;
    }
    // Word-start containment only: "female" must never satisfy an answer of "male".
    if (containsWord(lt, w)) return 60; // option label contains the (shorter) answer, e.g. "asian"
    if (containsWord(val, w)) return 50;
    if (containsWord(w, lt)) return 30; // answer contains the (shorter) option label - loosest
    if (containsWord(w, val)) return 20;
    return 0;
  }

  function bestOptionFor(inputs, w) {
    let best = null;
    let bestScore = 0;
    for (const inp of inputs) {
      const lt = clean(optionTextFor(inp)).toLowerCase();
      const val = clean(inp.value).toLowerCase();
      const s = scoreMatch(lt, val, w);
      if (s > bestScore) {
        bestScore = s;
        best = inp;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function activateOption(inp) {
    try {
      if (AF.workable && AF.workable.activateWidgetOption) {
        if (AF.workable.activateWidgetOption(inp)) return true;
      }
    } catch {}
    if (!inp.checked) inp.click();
    return inp.checked;
  }

  function choose(root, want, multi) {
    const wants = (Array.isArray(want) ? want : [want]).map((w) => clean(w).toLowerCase()).filter(Boolean);
    if (!wants.length) return false;
    const inputs = groupInputs(root);
    let any = false;
    if (multi) {
      // Each wanted value selects its own best option (checkbox group).
      for (const w of wants) {
        const inp = bestOptionFor(inputs, w);
        if (inp) {
          if (!inp.checked) activateOption(inp);
          any = true;
        }
      }
    } else {
      // Single (radio): pick the one globally best-scoring option.
      let best = null;
      let bestScore = 0;
      for (const inp of inputs) {
        const lt = clean(optionTextFor(inp)).toLowerCase();
        const val = clean(inp.value).toLowerCase();
        for (const w of wants) {
          const s = scoreMatch(lt, val, w);
          if (s > bestScore) {
            bestScore = s;
            best = inp;
          }
        }
      }
      if (best) {
        if (!best.checked) activateOption(best);
        any = true;
      }
    }
    return any;
  }

  function optionTextFor(inp) {
    if (AF.dayforce && AF.dayforce.optionLabelFor) {
      const df = AF.dayforce.optionLabelFor(inp);
      if (df) return df;
    }
    if (AF.workable && AF.workable.optionLabelFor) {
      const wb = AF.workable.optionLabelFor(inp);
      if (wb) return wb;
    }
    if (AF.lever && AF.lever.optionLabelFor) {
      const lv = AF.lever.optionLabelFor(inp);
      if (lv) return lv;
    }
    if (AF.breezy && AF.breezy.optionLabelFor) {
      const bz = AF.breezy.optionLabelFor(inp);
      if (bz) return bz;
    }
    // Ashby: name= is the visible option text on multi-select checkboxes
    // (probe: name === optionLabel). Prefer it over labelForControl, which can
    // climb to the fieldset question title for every box.
    try {
      if (AF.ashby && AF.ashby.isAshbyPage && AF.ashby.isAshbyPage() && inp && inp.name) {
        const n = clean(inp.name);
        if (n && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(n)) return n;
      }
    } catch {}
    return clean(labelForControl(inp)) || clean(inp.value);
  }

  function leverGroupOptions(root, group) {
    const opts = group.map((g) => optionTextFor(g)).filter(Boolean);
    if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root) && AF.lever.pronounsExtraOptions) {
      for (const o of AF.lever.pronounsExtraOptions()) {
        if (o && !opts.includes(o)) opts.push(o);
      }
    }
    return opts;
  }

  async function writeLeverGroup(root, answer, multi) {
    const values =
      Array.isArray(answer.option_values) && answer.option_values.length
        ? answer.option_values
        : [answer.option || answer.value].filter(Boolean);
    const lower = values.map((v) => clean(v).toLowerCase());
    if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root)) {
      const customVal = values.find((v) => v && !/^(he\/him|she\/her|they\/them|xe\/xem|ze\/hir|ey\/em|hir\/hir|fae\/faer|hu\/hu|use name only|custom)$/i.test(clean(v)));
      if (lower.some((v) => v === "custom") || (customVal && !lower.includes("use name only"))) {
        const text = customVal && !/^custom$/i.test(clean(customVal)) ? customVal : answer.value || "";
        if (text && AF.lever.writePronounsCustom) return AF.lever.writePronounsCustom(text);
      }
    }
    return choose(root, multi ? values : values[0], multi);
  }

  AF.registerDriver({
    type: "radio-checkbox-group",
    priority: 50,
    match(el) {
      if (el.tagName !== "INPUT") return null;
      const t = (el.type || "").toLowerCase();
      if (t !== "radio" && t !== "checkbox") return null;
      if (AF.lever && AF.lever.shouldSkipControl && AF.lever.shouldSkipControl(el)) return null;
      if (AF.breezy && AF.breezy.shouldSkipControl && AF.breezy.shouldSkipControl(el)) return null;
      return el;
    },
    consumes(root) {
      const group = groupInputs(root);
      const extra = group.slice();
      if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root)) {
        const field = document.getElementById("customPronounsTextField");
        if (field) extra.push(field);
      }
      return extra;
    },
    extract(root) {
      const t = (root.type || "radio").toLowerCase();
      const group = groupInputs(root);
      return {
        kind: t,
        label: groupLabel(root),
        required:
          group.some((g) => g.required) ||
          !!(AF.manatal && AF.manatal.isRequiredControl && AF.manatal.isRequiredControl(root)) ||
          !!(AF.jobdiva && AF.jobdiva.isRequiredControl && AF.jobdiva.isRequiredControl(root)) ||
          !!(AF.icims && AF.icims.isRequiredControl && AF.icims.isRequiredControl(root)) ||
          !!(AF.dayforce && AF.dayforce.isDayforcePage() && AF.dayforce.isRequiredControl(root)),
        multi: t === "checkbox" && group.length > 1 && !isExclusivePair(group),
        options: leverGroupOptions(root, group),
        name: root.name || "",
      };
    },
    isFilled(root) {
      const group = groupInputs(root);
      try {
        if (AF.workable && AF.workable.surveyGroupFilled && AF.workable.isSurveyControl && AF.workable.isSurveyControl(root)) {
          return AF.workable.surveyGroupFilled(group);
        }
        if (
          AF.workable &&
          AF.workable.applicationGroupFilled &&
          AF.workable.isApplicationWidgetInput &&
          AF.workable.isApplicationWidgetInput(root)
        ) {
          return AF.workable.applicationGroupFilled(group);
        }
      } catch {}
      if (group.some((g) => g.checked)) return true;
      if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root)) {
        const field = document.getElementById("customPronounsTextField");
        if (field && clean(field.value)) return true;
      }
      return false;
    },
    async write(root, answer) {
      const t = (root.type || "radio").toLowerCase();
      const group = groupInputs(root);
      const exclusive = t === "checkbox" && isExclusivePair(group);
      const multi = t === "checkbox" && group.length > 1 && !exclusive;
      if (AF.lever && AF.lever.isLeverPage && AF.lever.isLeverPage()) {
        return writeLeverGroup(root, answer, multi);
      }
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
      // A lone checkbox ("Current Job", "Not Completed") is a yes/no question: its only option is the question
      // itself, so a "Yes"/"No" answer never matches an option text. Tick or clear it.
      if (t === "checkbox" && group.length === 1 && values.length === 1) {
        const v = clean(values[0]).toLowerCase();
        const on = /^(yes|true|on|checked|1|y)$/.test(v);
        const off = /^(no|false|off|unchecked|0|n)$/.test(v);
        if (on || off) {
          if (root.checked !== on) activateOption(root);
          return root.checked === on;
        }
      }
      if (exclusive) {
        // Clears the other box too, so an earlier pass that ticked both is repaired.
        const best = values.length ? bestOptionFor(group, clean(values[0]).toLowerCase()) : null;
        if (!best) return false;
        for (const inp of group) {
          if (inp !== best && inp.checked) {
            try {
              inp.click();
            } catch {}
          }
        }
        if (!best.checked) activateOption(best);
        return !!best.checked && group.every((i) => i === best || !i.checked);
      }
      // Ashby race/ethnicity (and similar): when the answer is a single option,
      // clear any previously checked siblings first. A prior buggy pass may have
      // checked every box; choose() alone only adds matches and never unchecks.
      try {
        if (
          multi &&
          values.length === 1 &&
          AF.ashby &&
          AF.ashby.isAshbyPage &&
          AF.ashby.isAshbyPage()
        ) {
          const w = clean(values[0]).toLowerCase();
          const best = bestOptionFor(group, w);
          for (const inp of group) {
            if (inp !== best && inp.checked) {
              try {
                inp.click();
              } catch {}
            }
          }
          if (best) {
            if (!best.checked) activateOption(best);
            return !!best.checked;
          }
          return false;
        }
      } catch {}
      return choose(root, multi ? values : values[0], multi);
    },
  });
})();
