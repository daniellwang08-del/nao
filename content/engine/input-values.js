// The value a typed <input> accepts.
//
// Answers arrive as people write them ("08/01/2011", "9:30 AM", "5 years"), but Chrome only takes ISO text in
// date-like inputs (date: yyyy-MM-dd, month: yyyy-MM, datetime-local: yyyy-MM-ddTHH:mm, time: HH:mm) and plain
// numbers in number/range inputs. Anything else is refused ("The specified value ... does not conform to the
// required format") and the field stays empty. Shared by the isolated engine (dom.js) and the MAIN-world bridge
// (page-bridge.js), so it defines one global and nothing else.
(() => {
  if (globalThis.__NAO_inputValueFor) return;
  const pad = (n) => String(n).padStart(2, "0");

  function valid(y, m, d) {
    if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? { y, m, d } : null;
  }

  // {y, m, d} from "2011-08-01", "2011/8/1", "08/01/2011" (month first unless it cannot be), "8/1/11", "08/2011",
  // "2011-08" (day 1), "Aug 1, 2011", "August 2011". Null when there is no date.
  function parseDate(s) {
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
    if (m) {
      let y = +m[3];
      if (m[3].length === 2) y += y > 50 ? 1900 : 2000;
      return +m[1] > 12 ? valid(y, +m[2], +m[1]) : valid(y, +m[1], +m[2]);
    }
    m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
    if (m) return valid(+m[2], +m[1], 1);
    m = s.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (m) return valid(+m[1], +m[2], 1);
    if (/[a-z]/i.test(s)) {
      const t = new Date(s.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
      if (!isNaN(t.getTime())) return valid(t.getFullYear(), t.getMonth() + 1, t.getDate());
    }
    return null;
  }

  // "HH:mm" from "09:30", "9:30 AM", "9 pm", "21:05:00".
  function parseTime(s) {
    const m = s.match(/(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?m?\.?\b/i) || s.match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    let h = +m[1];
    const min = m[2] != null ? +m[2] : 0;
    if (m[3]) {
      const pm = m[3].toLowerCase() === "p";
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : null;
  }

  function inputValueFor(el, value) {
    const v = value == null ? "" : String(value);
    const type = el && el.tagName === "INPUT" ? String(el.type || "").toLowerCase() : "";
    const s = v.trim();
    if (!s) return v;
    switch (type) {
      case "date": {
        const p = parseDate(s);
        return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : "";
      }
      case "month": {
        const p = parseDate(s);
        return p ? `${p.y}-${pad(p.m)}` : "";
      }
      case "datetime-local": {
        const p = parseDate(s);
        if (!p) return "";
        const rest = s.replace(/^[^T\s]+[T\s]?/, "");
        return `${p.y}-${pad(p.m)}-${pad(p.d)}T${parseTime(rest) || "00:00"}`;
      }
      case "time":
        return parseTime(s) || "";
      case "week":
        return /^\d{4}-W\d{2}$/.test(s) ? s : "";
      case "number":
      case "range": {
        const m = s.replace(/[,\s$€£]/g, "").match(/-?\d+(\.\d+)?/);
        return m ? m[0] : "";
      }
      default:
        return v;
    }
  }

  globalThis.__NAO_inputValueFor = inputValueFor;
})();
