/*
 * verify.js — label-vs-application comparison engine.
 *
 * Pure functions, no DOM, no network. Runs in the browser (window.LabelVerify)
 * and in Node (module.exports) so the same logic is unit-tested.
 *
 * Every check returns { status, ... } where status is one of:
 *   "pass"   — label matches the application
 *   "review" — probably fine, but an agent should look (OCR doubt, cosmetic difference)
 *   "fail"   — label does not match / required element missing or wrong
 *   "skip"   — not applicable (e.g. no country of origin for a domestic product)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LabelVerify = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 27 CFR 16.21 — mandatory health warning statement (statutory text).
  const WARNING_HEADING = "GOVERNMENT WARNING:";
  const WARNING_BODY =
    "(1) According to the Surgeon General, women should not drink alcoholic beverages " +
    "during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic " +
    "beverages impairs your ability to drive a car or operate machinery, and may cause " +
    "health problems.";
  const WARNING_FULL = WARNING_HEADING + " " + WARNING_BODY;

  const US_STATES = {
    AL: "ALABAMA", AK: "ALASKA", AZ: "ARIZONA", AR: "ARKANSAS", CA: "CALIFORNIA",
    CO: "COLORADO", CT: "CONNECTICUT", DE: "DELAWARE", FL: "FLORIDA", GA: "GEORGIA",
    HI: "HAWAII", ID: "IDAHO", IL: "ILLINOIS", IN: "INDIANA", IA: "IOWA", KS: "KANSAS",
    KY: "KENTUCKY", LA: "LOUISIANA", ME: "MAINE", MD: "MARYLAND", MA: "MASSACHUSETTS",
    MI: "MICHIGAN", MN: "MINNESOTA", MS: "MISSISSIPPI", MO: "MISSOURI", MT: "MONTANA",
    NE: "NEBRASKA", NV: "NEVADA", NH: "NEW HAMPSHIRE", NJ: "NEW JERSEY", NM: "NEW MEXICO",
    NY: "NEW YORK", NC: "NORTH CAROLINA", ND: "NORTH DAKOTA", OH: "OHIO", OK: "OKLAHOMA",
    OR: "OREGON", PA: "PENNSYLVANIA", RI: "RHODE ISLAND", SC: "SOUTH CAROLINA",
    SD: "SOUTH DAKOTA", TN: "TENNESSEE", TX: "TEXAS", UT: "UTAH", VT: "VERMONT",
    VA: "VIRGINIA", WA: "WASHINGTON", WV: "WEST VIRGINIA", WI: "WISCONSIN", WY: "WYOMING",
    DC: "DISTRICT OF COLUMBIA",
  };
  const STATE_ABBR = Object.fromEntries(Object.entries(US_STATES).map(([a, n]) => [n, a]));

  // ---------- text helpers ----------

  function cleanQuotes(s) {
    return String(s || "")
      .replace(/[‘’‛`´]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/[–—]/g, "-");
  }

  /** Uppercase, drop punctuation (keeps letters, digits, % and .), collapse spaces. */
  function norm(s) {
    return cleanQuotes(s)
      .toUpperCase()
      .replace(/&/g, " AND ")
      .replace(/'/g, "")
      .replace(/[^A-Z0-9%.\s]/g, " ")
      .replace(/\.(?!\d)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normToken(t) {
    return norm(t).replace(/\s+/g, "");
  }

  /** Tokenize raw text keeping raw + normalized forms aligned. */
  function tokenize(text) {
    const raw = cleanQuotes(text).split(/\s+/).filter(Boolean);
    const out = [];
    for (const r of raw) {
      const n = normToken(r);
      if (n) out.push({ raw: r, norm: n });
    }
    return out;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= b.length; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  function similarity(a, b) {
    if (!a && !b) return 1;
    const d = levenshtein(a, b);
    return 1 - d / Math.max(a.length, b.length);
  }

  /**
   * Find the window of label tokens that best matches `target`.
   * Compares with spaces removed so OCR splitting/merging words doesn't matter.
   */
  function bestWindow(target, tokens) {
    const tTokens = norm(target).split(" ").filter(Boolean);
    const tJoined = tTokens.join("");
    let best = { score: 0, start: -1, end: -1 };
    if (!tJoined || !tokens.length) return best;
    const n = tTokens.length;
    const minLen = Math.max(1, n - 2);
    const maxLen = n + 2;
    for (let i = 0; i < tokens.length; i++) {
      let joined = "";
      for (let len = 1; len <= maxLen && i + len <= tokens.length; len++) {
        joined += tokens[i + len - 1].norm;
        if (len < minLen) continue;
        if (Math.abs(joined.length - tJoined.length) > Math.max(3, tJoined.length * 0.4)) {
          if (joined.length > tJoined.length) break;
          continue;
        }
        const score = similarity(joined, tJoined);
        if (score > best.score) best = { score, start: i, end: i + len };
      }
    }
    return best;
  }

  function snippet(tokens, start, end) {
    return tokens.slice(start, end).map((t) => t.raw).join(" ");
  }

  // ---------- generic text field ----------

  /**
   * Brand name, class/type, country of origin: find the application text on the label.
   * Case and punctuation differences pass with a note (e.g. STONE'S THROW vs Stone's Throw).
   */
  function checkText(label, expected, tokens, opts = {}) {
    const field = { label, expected: expected || "" };
    if (!expected || !expected.trim()) {
      return { ...field, status: opts.optional ? "skip" : "fail", found: "",
        note: opts.optional ? "Not on application — not checked." : "Application value is blank." };
    }
    const w = bestWindow(expected, tokens);
    const found = w.start >= 0 ? snippet(tokens, w.start, w.end) : "";
    if (w.score >= 0.97) {
      const letters = (s) => cleanQuotes(s).replace(/[^A-Za-z0-9%.]/g, "");
      const a = letters(found), b = letters(expected);
      const note = a === b
        ? (found.replace(/\s+/g, " ") === cleanQuotes(expected).replace(/\s+/g, " ") ? "Exact match." : "Matches; punctuation or spacing differs slightly.")
        : a.toUpperCase() === b.toUpperCase()
          ? "Same words; capitalization differs on the label."
          : "Matches, allowing for a minor scan difference.";
      return { ...field, status: "pass", found, score: w.score, note };
    }
    if (w.score >= 0.8) {
      return { ...field, status: "review", found, score: w.score,
        note: "Close but not identical. Could be a scan misread or a real difference — compare by eye." };
    }
    return { ...field, status: "fail", found: w.score >= 0.5 ? found : "", score: w.score,
      note: "Could not find this on the label." };
  }

  // ---------- name & address (word coverage, order-free) ----------

  function expandStates(words) {
    const out = [];
    for (const w of words) {
      if (US_STATES[w]) out.push(...US_STATES[w].split(" "));
      else out.push(w);
    }
    return out;
  }

  function checkNameAddress(expected, tokens) {
    const field = { label: "Bottler / producer name & address", expected: expected || "" };
    if (!expected || !expected.trim()) {
      return { ...field, status: "skip", found: "", note: "Not on application — not checked." };
    }
    const want = expandStates(norm(expected).split(" ").filter(Boolean));
    const have = expandStates(tokens.map((t) => t.norm));
    const haveSet = new Set(have);
    const missing = [];
    let hits = 0;
    for (const w of want) {
      if (haveSet.has(w)) { hits++; continue; }
      // tolerate one OCR slip in longer words
      const near = w.length >= 5 && have.some((h) => Math.abs(h.length - w.length) <= 1 && levenshtein(h, w) <= 1);
      if (near) hits += 0.9;
      else missing.push(w);
    }
    const coverage = want.length ? hits / want.length : 0;
    // Show the label line that holds the most of these words
    const w = bestWindow(expected, tokens);
    const found = w.start >= 0 && w.score > 0.4 ? snippet(tokens, w.start, w.end) : "";
    if (coverage >= 0.95) return { ...field, status: "pass", found, score: coverage, note: "All name and address words found." };
    if (coverage >= 0.7) return { ...field, status: "review", found, score: coverage,
      note: "Missing or unclear on label: " + missing.join(", ") + "." };
    return { ...field, status: "fail", found, score: coverage,
      note: missing.length ? "Not found on label: " + missing.join(", ") + "." : "Not found on label." };
  }

  // ---------- alcohol content ----------

  function parseNumber(s) {
    const v = parseFloat(String(s).replace(",", "."));
    return isFinite(v) ? v : null;
  }

  /** Parse "45% Alc./Vol. (90 Proof)" -> { abv: 45, proof: 90 } */
  function parseAlcohol(s) {
    const t = cleanQuotes(s).toUpperCase().replace(/°\/O|0\/0|O\/O/g, "%");
    let abv = null, proof = null;
    const pct = t.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%/);
    if (pct) abv = parseNumber(pct[1]);
    if (abv === null) {
      const alc = t.match(/ALC(?:OHOL)?\.?\s*(\d{1,2}(?:[.,]\d{1,2})?)/) || t.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:ALC|ABV)/);
      if (alc) abv = parseNumber(alc[1]);
    }
    const pr = t.match(/(\d{2,3}(?:[.,]\d)?)\s*-?\s*PROOF/);
    if (pr) proof = parseNumber(pr[1]);
    if (abv === null && proof !== null) abv = proof / 2;
    return { abv, proof };
  }

  function findAlcoholOnLabel(text) {
    const t = cleanQuotes(text).toUpperCase().replace(/°\/O|0\/0|O\/O/g, "%").replace(/\s+/g, " ");
    const results = [];
    const re = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%(?:\s*(?:ALC|ALCOHOL|BY|VOL|ABV)[^0-9]{0,24})?(?:\(?\s*(\d{2,3}(?:[.,]\d)?)\s*-?\s*PROOF\s*\)?)?/g;
    let m;
    while ((m = re.exec(t))) {
      results.push({ abv: parseNumber(m[1]), proof: m[2] ? parseNumber(m[2]) : null, text: m[0].trim() });
    }
    if (!results.length) {
      const alc = t.match(/ALC(?:OHOL)?\.?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%?\s*(?:BY\s*)?VOL/);
      if (alc) results.push({ abv: parseNumber(alc[1]), proof: null, text: alc[0] });
    }
    if (!results.length) {
      const pr = t.match(/(\d{2,3}(?:[.,]\d)?)\s*-?\s*PROOF/);
      if (pr) results.push({ abv: parseNumber(pr[1]) / 2, proof: parseNumber(pr[1]), text: pr[0], proofOnly: true });
    }
    return results;
  }

  function checkAlcohol(expected, labelText, beverageType) {
    const field = { label: "Alcohol content", expected: expected || "" };
    const app = parseAlcohol(expected || "");
    const onLabel = findAlcoholOnLabel(labelText);
    if (app.abv === null) {
      if (beverageType === "spirits") return { ...field, status: "fail", found: onLabel[0]?.text || "",
        note: "Application has no alcohol content. It is required for distilled spirits." };
      return { ...field, status: "skip", found: onLabel[0]?.text || "", note: "Not on application — not checked." };
    }
    if (!onLabel.length) {
      return { ...field, status: "fail", found: "", note: "No alcohol content statement found on the label." };
    }
    const match = onLabel.find((r) => Math.abs(r.abv - app.abv) < 0.001);
    if (!match) {
      return { ...field, status: "fail", found: onLabel.map((r) => r.text).join(" / "),
        note: `Label shows ${onLabel[0].abv}% but the application says ${app.abv}%.` };
    }
    const issues = [];
    if (match.proof !== null && Math.abs(match.proof - match.abv * 2) > 0.01) {
      issues.push(`Proof on label (${match.proof}) is not twice the ABV (${match.abv}%).`);
    }
    if (app.proof !== null && match.proof !== null && Math.abs(app.proof - match.proof) > 0.01) {
      issues.push(`Proof on label (${match.proof}) differs from application (${app.proof}).`);
    }
    if (issues.length) return { ...field, status: "fail", found: match.text, note: issues.join(" ") };
    if (match.proofOnly) return { ...field, status: "review", found: match.text,
      note: "Only a proof statement was found; check the label states alcohol by volume." };
    return { ...field, status: "pass", found: match.text, note: `${app.abv}% alcohol by volume matches.` };
  }

  // ---------- net contents ----------

  const UNIT_ML = { ML: 1, CL: 10, L: 1000, LITER: 1000, LITRE: 1000, LITERS: 1000, LITRES: 1000,
    FLOZ: 29.5735, OZ: 29.5735, PINT: 473.176, PINTS: 473.176, QUART: 946.353, GAL: 3785.41, GALLON: 3785.41 };

  function parseVolumes(s) {
    const t = cleanQuotes(s).toUpperCase().replace(/\s+/g, " ");
    const re = /(\d+(?:[.,]\d+)?)\s*(ML|MILLILITERS?|MILLILITRES?|CL|LITERS?|LITRES?|L|FL\.?\s*OZ\.?|OZ\.?|PINTS?|QUART|GAL(?:LON)?S?)(?![A-Z])/g;
    const out = [];
    let m;
    while ((m = re.exec(t))) {
      let unit = m[2].replace(/[.\s]/g, "");
      if (unit.startsWith("MILLILIT")) unit = "ML";
      if (unit === "GALLONS" || unit === "GALS") unit = "GAL";
      const factor = UNIT_ML[unit];
      if (!factor) continue;
      out.push({ ml: parseNumber(m[1]) * factor, text: m[0].trim() });
    }
    return out;
  }

  function checkNetContents(expected, labelText) {
    const field = { label: "Net contents", expected: expected || "" };
    const app = parseVolumes(expected || "")[0];
    if (!app) return { ...field, status: "fail", found: "", note: "Application value is blank or has no unit (e.g. 750 mL)." };
    const onLabel = parseVolumes(labelText);
    if (!onLabel.length) return { ...field, status: "fail", found: "", note: "No net contents statement found on the label." };
    const match = onLabel.find((v) => Math.abs(v.ml - app.ml) / app.ml < 0.01);
    if (match) {
      const same = norm(match.text).replace(/\s/g, "") === norm(expected).replace(/\s/g, "");
      return { ...field, status: "pass", found: match.text,
        note: same ? "Exact match." : `Equivalent amount (${Math.round(app.ml)} mL).` };
    }
    return { ...field, status: "fail", found: onLabel.map((v) => v.text).join(" / "),
      note: `Label shows ${onLabel[0].text} (${Math.round(onLabel[0].ml)} mL); application says ${expected}.` };
  }

  // ---------- government warning ----------

  /** Word-level alignment (LCS) with fuzzy word equality for OCR noise. */
  function alignWords(expectedWords, foundWords) {
    const eq = (a, b) => a === b || (a.length >= 4 && levenshtein(a, b) <= 1);
    const n = expectedWords.length, m = foundWords.length;
    const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = eq(expectedWords[i], foundWords[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(expectedWords[i], foundWords[j])) {
        ops.push({ op: expectedWords[i] === foundWords[j] ? "same" : "near", want: expectedWords[i], got: foundWords[j] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "missing", want: expectedWords[i] }); i++; }
      else { ops.push({ op: "extra", got: foundWords[j] }); j++; }
    }
    while (i < n) ops.push({ op: "missing", want: expectedWords[i++] });
    while (j < m) ops.push({ op: "extra", got: foundWords[j++] });
    // Pair adjacent missing+extra into "changed"
    const merged = [];
    for (let k = 0; k < ops.length; k++) {
      const a = ops[k], b = ops[k + 1];
      if (b && ((a.op === "missing" && b.op === "extra") || (a.op === "extra" && b.op === "missing"))) {
        const want = a.op === "missing" ? a.want : b.want;
        const got = a.op === "extra" ? a.got : b.got;
        merged.push({ op: "changed", want, got, sim: similarity(want, got) });
        k++;
      } else merged.push(a);
    }
    return merged;
  }

  /**
   * Checks: heading present, heading in ALL CAPS, wording word-for-word, heading bold.
   * `bold` is an optional { ratio } from estimateBoldness (pixel analysis done by the app).
   */
  function checkWarning(tokens, bold) {
    const result = { label: "Government health warning", expected: WARNING_FULL, checks: [], diff: [] };
    // Locate heading (fuzzy, two tokens or merged)
    let hStart = -1, hEnd = -1, hScore = 0;
    for (let i = 0; i < tokens.length; i++) {
      const one = tokens[i].norm;
      const two = one + (tokens[i + 1] ? tokens[i + 1].norm : "");
      const s2 = similarity(two, "GOVERNMENTWARNING");
      const s1 = similarity(one, "GOVERNMENTWARNING");
      if (s2 > hScore) { hScore = s2; hStart = i; hEnd = i + 2; }
      if (s1 > hScore) { hScore = s1; hStart = i; hEnd = i + 1; }
    }
    if (hScore < 0.75) {
      // Maybe the heading is missing but the body is there
      const bodyWin = bestWindow("According to the Surgeon General", tokens);
      result.status = "fail";
      result.found = bodyWin.score > 0.8 ? snippet(tokens, bodyWin.start, Math.min(tokens.length, bodyWin.start + 40)) : "";
      result.checks.push({ name: "“GOVERNMENT WARNING:” heading present", status: "fail",
        note: result.found ? "Warning text found but the heading is missing." : "No government warning found on the label." });
      result.note = result.checks[0].note;
      return result;
    }
    const headRaw = tokens.slice(hStart, hEnd).map((t) => t.raw).join(" ");
    const headLetters = headRaw.replace(/[^A-Za-z]/g, "");
    result.checks.push({ name: "“GOVERNMENT WARNING:” heading present", status: hScore >= 0.9 ? "pass" : "review",
      note: hScore >= 0.9 ? `Found “${headRaw}”.` : `Found “${headRaw}” — partly unreadable.` });

    // ALL CAPS
    const lower = (headLetters.match(/[a-z]/g) || []).length;
    const capsStatus = lower === 0 ? "pass" : lower <= 1 && headLetters.length > 12 && hScore < 0.95 ? "review" : "fail";
    result.checks.push({ name: "Heading is in capital letters", status: capsStatus,
      note: capsStatus === "pass" ? "All capitals." : capsStatus === "review" ? `Read as “${headRaw}”. One letter may be lowercase — check by eye.`
        : `Heading reads “${headRaw}”. It must be “GOVERNMENT WARNING:” in capital letters.` });

    // Colon
    const hasColon = /:\s*$/.test(headRaw) || (tokens[hEnd] && /^:/.test(tokens[hEnd].raw));
    if (!hasColon) result.checks.push({ name: "Colon after heading", status: "review", note: "No colon read after the heading. Check by eye." });

    // Wording
    const bodyWords = norm(WARNING_BODY).split(" ");
    const seg = tokens.slice(hEnd, hEnd + bodyWords.length + 12).map((t) => t.norm);
    // Trim trailing tokens that are clearly after the warning: cut at last aligned word
    const diff = alignWords(bodyWords, seg);
    while (diff.length && diff[diff.length - 1].op === "extra") diff.pop();
    result.diff = diff;
    const missing = diff.filter((d) => d.op === "missing");
    const extra = diff.filter((d) => d.op === "extra");
    const changed = diff.filter((d) => d.op === "changed");
    const near = diff.filter((d) => d.op === "near");
    const likelyOcr = changed.filter((d) => d.sim >= 0.6);
    const realChanges = changed.filter((d) => d.sim < 0.6);
    let wordStatus, wordNote;
    if (!missing.length && !extra.length && !realChanges.length && !likelyOcr.length) {
      wordStatus = "pass";
      wordNote = near.length ? `Wording matches (${near.length} word${near.length > 1 ? "s" : ""} slightly blurred in the image).` : "Wording matches word for word.";
    } else if (!missing.length && !extra.length && !realChanges.length) {
      wordStatus = "review";
      wordNote = "Possible misreads: " + likelyOcr.map((d) => `“${d.got}” for “${d.want.toLowerCase()}”`).join(", ") + ". Check by eye.";
    } else {
      wordStatus = "fail";
      const parts = [];
      if (realChanges.length) parts.push("changed: " + realChanges.map((d) => `“${d.want.toLowerCase()}” → “${d.got.toLowerCase()}”`).join(", "));
      if (missing.length) parts.push("missing: " + missing.map((d) => `“${d.want.toLowerCase()}”`).join(", "));
      if (extra.length) parts.push("added: " + extra.map((d) => `“${d.got.toLowerCase()}”`).join(", "));
      if (likelyOcr.length) parts.push("unclear: " + likelyOcr.map((d) => `“${d.got.toLowerCase()}”`).join(", "));
      wordNote = "Wording differs from the required statement — " + parts.join("; ") + ".";
      // If most words are missing it is likely cut off / unreadable rather than reworded
      if (missing.length > bodyWords.length * 0.5) wordNote = "Most of the warning text could not be read or is missing.";
      // Every required word is present, just not in reading order: likely a tilted photo
      const got = seg.slice();
      const allPresent = bodyWords.every((bw) => {
        const k = got.findIndex((g) => g === bw || (bw.length >= 4 && levenshtein(g, bw) <= 1));
        if (k < 0) return false;
        got.splice(k, 1);
        return true;
      });
      if (allPresent && !realChanges.some((d) => !seg.includes(d.want))) {
        wordStatus = "review";
        wordNote = "All required words are present but were read out of order (tilted or curved label?). Check the wording by eye.";
      }
    }
    result.checks.push({ name: "Wording is exact", status: wordStatus, note: wordNote });

    // Bold
    if (bold === null) {
      result.checks.push({ name: "Heading is bold", status: "skip", note: "Bold type can't be checked from typed text." });
    } else if (bold && isFinite(bold.ratio)) {
      const st = bold.ratio >= 1.18 ? "pass" : "review";
      result.checks.push({ name: "Heading is bold", status: st,
        note: st === "pass" ? "Heading strokes are heavier than the warning text." : "Heading does not look heavier than the text. Confirm it is bold." });
    } else {
      result.checks.push({ name: "Heading is bold", status: "review", note: "Could not measure. Confirm the heading is bold." });
    }

    const order = { fail: 3, review: 2, pass: 1, skip: 0 };
    result.status = result.checks.reduce((acc, c) => (order[c.status] > order[acc] ? c.status : acc), "pass");
    result.found = snippet(tokens, hStart, Math.min(tokens.length, hEnd + seg.length));
    const firstBad = result.checks.find((c) => c.status === result.status && c.status !== "pass");
    result.note = firstBad ? firstBad.note : "Heading, capitals, bold and wording all check out.";
    return result;
  }

  /**
   * Estimate boldness: median horizontal stroke width relative to text height,
   * heading words vs. body words. Needs a grayscale accessor over the OCR'd image.
   * gray: Uint8Array (0..255), width: image width; boxes: [{x0,y0,x1,y1}]
   */
  function strokeRatio(gray, width, box) {
    const h = box.y1 - box.y0;
    if (h < 6 || box.x1 - box.x0 < 6) return null;
    let min = 255, max = 0;
    for (let y = box.y0; y < box.y1; y++)
      for (let x = box.x0; x < box.x1; x++) { const v = gray[y * width + x]; if (v < min) min = v; if (v > max) max = v; }
    if (max - min < 40) return null;
    const thr = (min + max) / 2;
    const runs = [];
    for (let y = box.y0 + Math.floor(h * 0.25); y < box.y1 - Math.floor(h * 0.2); y++) {
      let run = 0;
      for (let x = box.x0; x < box.x1; x++) {
        if (gray[y * width + x] < thr) run++;
        else if (run) { runs.push(run); run = 0; }
      }
      if (run) runs.push(run);
    }
    if (runs.length < 4) return null;
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)] / h;
  }

  function estimateBoldness(gray, width, headingBoxes, bodyBoxes) {
    const med = (arr) => { const a = arr.filter((v) => v !== null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
    const head = med(headingBoxes.map((b) => strokeRatio(gray, width, b)));
    const body = med(bodyBoxes.slice(0, 30).map((b) => strokeRatio(gray, width, b)));
    if (head === null || body === null) return { ratio: NaN };
    return { ratio: head / body, head, body };
  }

  /** Pick heading + body word boxes from OCR word list (needed for estimateBoldness). */
  function warningWordBoxes(words) {
    const idx = words.findIndex((w) => /^GOVERN/i.test(w.text.replace(/[^A-Za-z]/g, "")) || similarity(normToken(w.text), "GOVERNMENT") > 0.75);
    if (idx < 0) return null;
    const heading = [words[idx].bbox];
    if (words[idx + 1] && similarity(normToken(words[idx + 1].text), "WARNING") > 0.6) heading.push(words[idx + 1].bbox);
    const body = words.slice(idx + heading.length, idx + heading.length + 40)
      .filter((w) => /^[a-z]{3,}$/.test(w.text.replace(/[^A-Za-z]/g, "")) && w.confidence > 60).map((w) => w.bbox);
    return { heading, body };
  }

  // ---------- top level ----------

  /**
   * app: { beverageType, brandName, classType, alcoholContent, netContents, bottler, countryOfOrigin }
   * ocr: { text, bold? }
   */
  function verifyLabel(app, ocr) {
    const text = ocr.text || "";
    const tokens = tokenize(text);
    const bt = app.beverageType || "spirits";
    const fields = [
      { key: "brandName", ...checkText("Brand name", app.brandName, tokens) },
      { key: "classType", ...checkText("Class / type", app.classType, tokens) },
      { key: "alcoholContent", ...checkAlcohol(app.alcoholContent, text, bt) },
      { key: "netContents", ...checkNetContents(app.netContents, text) },
      { key: "bottler", ...checkNameAddress(app.bottler, tokens) },
      { key: "countryOfOrigin", ...checkText("Country of origin", app.countryOfOrigin, tokens, { optional: true }) },
      { key: "warning", ...checkWarning(tokens, ocr.bold) },
    ];
    const counts = { pass: 0, review: 0, fail: 0, skip: 0 };
    fields.forEach((f) => counts[f.status]++);
    const verdict = counts.fail ? "fail" : counts.review ? "review" : "pass";
    return { verdict, counts, fields, tokenCount: tokens.length };
  }

  /**
   * Combine two reads of the same label (original + cleaned-up image):
   * for each field keep whichever read gave the better result.
   */
  function mergeResults(a, b) {
    if (!b) return a;
    const rank = { pass: 3, skip: 3, review: 2, fail: 1 };
    const fields = a.fields.map((fa, i) => {
      const fb = b.fields[i];
      return rank[fb.status] > rank[fa.status] ? { ...fb, fromCleanup: true } : fa;
    });
    const counts = { pass: 0, review: 0, fail: 0, skip: 0 };
    fields.forEach((f) => counts[f.status]++);
    const verdict = counts.fail ? "fail" : counts.review ? "review" : "pass";
    return { verdict, counts, fields, tokenCount: Math.max(a.tokenCount, b.tokenCount) };
  }

  // ---------- CSV (batch) ----------

  function parseCSV(text) {
    const rows = [];
    let row = [], cell = "", q = false;
    const s = String(text).replace(/^﻿/, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
    const map = {
      filename: "filename", file: "filename", image: "filename", labelimage: "filename",
      beveragetype: "beverageType", type: "beverageType",
      brandname: "brandName", brand: "brandName",
      classtype: "classType", class: "classType",
      alcoholcontent: "alcoholContent", abv: "alcoholContent", alcohol: "alcoholContent",
      netcontents: "netContents", net: "netContents", volume: "netContents",
      bottler: "bottler", nameandaddress: "bottler", producer: "bottler", bottlernameaddress: "bottler",
      countryoforigin: "countryOfOrigin", country: "countryOfOrigin", origin: "countryOfOrigin",
    };
    const keys = header.map((h) => map[h] || null);
    return rows.slice(1).map((r) => {
      const o = {};
      keys.forEach((k, i) => { if (k) o[k] = (r[i] || "").trim(); });
      if (o.beverageType) {
        const b = o.beverageType.toLowerCase();
        o.beverageType = /wine/.test(b) ? "wine" : /beer|malt|ale|lager/.test(b) ? "beer" : "spirits";
      }
      return o;
    });
  }

  function toCSV(rows) {
    const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return rows.map((r) => r.map(esc).join(",")).join("\n");
  }

  return {
    WARNING_HEADING, WARNING_BODY, WARNING_FULL,
    norm, tokenize, similarity, levenshtein, bestWindow,
    checkText, checkNameAddress, checkAlcohol, checkNetContents, checkWarning,
    parseAlcohol, findAlcoholOnLabel, parseVolumes, alignWords,
    estimateBoldness, warningWordBoxes, verifyLabel, mergeResults, parseCSV, toCSV,
  };
});
