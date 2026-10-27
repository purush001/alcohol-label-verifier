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

  /**
   * Unicode-safe canonical form used before every comparison:
   * NFKC folds compatibility characters (non-breaking and other odd spaces, full-width
   * digits, the "ℓ" litre sign, ligatures); zero-width characters are removed so hidden
   * characters can't split or disguise a word; quotes and dashes are unified.
   */
  function cleanQuotes(s) {
    let t = String(s || "");
    try { t = t.normalize("NFKC"); } catch (e) { /* very old engines: skip */ }
    return t
      .replace(/[​-‍⁠﻿­]/g, "")
      .replace(/[   -   　]/g, " ")
      .replace(/[‘’‛`´]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/[‐-―−]/g, "-");
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
    let t = String(s).trim();
    if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, "");   // 1,000
    const v = parseFloat(t.replace(",", "."));
    return isFinite(v) ? v : null;
  }

  const NUM = "(?<![\\d.,])(\\d{1,2}(?:[.,]\\d{1,2})?)";

  function alcoholCanon(s) {
    return cleanQuotes(s).toUpperCase()
      .replace(/°\/O|0\/0|O\/O|PERCENT|PCT\b/g, "%")
      .replace(/\s+/g, " ");
  }

  /**
   * Find every alcohol statement: single values ("45% Alc./Vol."), ranges
   * ("12% - 14%", "12 TO 14% BY VOL") and stand-alone proof ("90 PROOF").
   * Returns [{ min, max, text }] plus every proof number seen.
   */
  function parseAlcoholStatements(s) {
    let t = alcoholCanon(s);
    const statements = [];
    const blank = (m) => { t = t.slice(0, m.index) + " ".repeat(m[0].length) + t.slice(m.index + m[0].length); };
    const rangeRe = new RegExp(NUM + "\\s*%?\\s*(?:-|TO)\\s*" + NUM + "\\s*%", "g");
    let m;
    const ranges = [];
    while ((m = rangeRe.exec(t))) ranges.push(m);
    for (const r of ranges) {
      const a = parseNumber(r[1]), b = parseNumber(r[2]);
      if (a !== null && b !== null && a < b && b <= 100) {
        statements.push({ min: a, max: b, text: r[0].trim(), range: true });
        blank(r);
      }
    }
    const valueRe = new RegExp(NUM + "\\s*%", "g");
    while ((m = valueRe.exec(t))) {
      const v = parseNumber(m[1]);
      if (v !== null && v <= 100) statements.push({ min: v, max: v, text: m[0].trim() });
    }
    if (!statements.length) {
      const alc = t.match(new RegExp("ALC(?:OHOL)?\\.?\\s*" + NUM + "\\s*(?:BY\\s*)?VOL")) || t.match(new RegExp(NUM + "\\s*(?:ALC|ABV)"));
      if (alc) { const v = parseNumber(alc[1]); statements.push({ min: v, max: v, text: alc[0].trim() }); }
    }
    const proofs = [];
    const proofRe = /(?<![\d.,])(\d{2,3}(?:[.,]\d)?)\s*-?\s*PROOF/g;
    while ((m = proofRe.exec(alcoholCanon(s)))) proofs.push({ proof: parseNumber(m[1]), text: m[0].trim() });
    return { statements, proofs };
  }

  /** Parse "45% Alc./Vol. (90 Proof)" -> { abv: 45, proof: 90, min, max } (application side) */
  function parseAlcohol(s) {
    const { statements, proofs } = parseAlcoholStatements(s || "");
    const st = statements[0] || null;
    const proof = proofs[0] ? proofs[0].proof : null;
    if (!st && proof !== null) return { abv: proof / 2, min: proof / 2, max: proof / 2, proof };
    if (!st) return { abv: null, proof: null };
    return { abv: st.min === st.max ? st.min : null, min: st.min, max: st.max, proof, range: !!st.range };
  }

  const PROOF_TOL = 0.2;   // proof units (= 0.1% ABV), allows for rounding

  function fmtAlc(st) { return st.min === st.max ? `${st.min}%` : `${st.min}–${st.max}%`; }

  function checkAlcohol(expected, labelText, beverageType) {
    const field = { label: "Alcohol content", expected: expected || "" };
    const app = parseAlcohol(expected || "");
    const { statements, proofs } = parseAlcoholStatements(labelText);
    const allText = statements.map((s) => s.text).concat(proofs.map((p) => p.text));
    const firstFound = allText[0] || "";
    if (app.min === undefined || app.min === null) {
      if (beverageType === "spirits") return { ...field, status: "fail", found: firstFound,
        note: "Application has no alcohol content. It is required for distilled spirits." };
      return { ...field, status: "skip", found: firstFound, note: "Not on application — not checked." };
    }
    // proof-only label: treat proof/2 as the statement but ask for a look
    const onLabel = statements.length ? statements
      : proofs.map((p) => ({ min: p.proof / 2, max: p.proof / 2, text: p.text, proofOnly: true }));
    if (!onLabel.length) {
      return { ...field, status: "fail", found: "", note: "No alcohol content statement found on the label." };
    }
    const eq = (a, b) => Math.abs(a - b) < 0.001;
    const match = onLabel.find((s) => eq(s.min, app.min) && eq(s.max, app.max));
    const appSt = { min: app.min, max: app.max };
    if (!match) {
      const containing = onLabel.find((s) => s.range && s.min <= app.min && app.max <= s.max);
      if (containing) return { ...field, status: "review", found: containing.text,
        note: `Label states a range (${fmtAlc(containing)}); application says ${fmtAlc(appSt)}. Confirm a range is acceptable for this product.` };
      const close = onLabel.find((s) => !s.range && app.min === app.max && Math.abs(s.min - app.min) <= 0.1 + 1e-9);
      if (close) return { ...field, status: "review", found: close.text,
        note: `Label shows ${fmtAlc(close)}, application ${fmtAlc(appSt)} (0.1 apart). Possible misread — check by eye.` };
      return { ...field, status: "fail", found: allText.join(" / "),
        note: `Label shows ${fmtAlc(onLabel[0])} but the application says ${fmtAlc(appSt)}.` };
    }
    const issues = [];
    if (!match.range) {
      for (const p of proofs) {
        if (Math.abs(p.proof - match.min * 2) > PROOF_TOL) {
          issues.push(`Proof on label (${p.proof}) is not twice the ABV (${match.min}%).`);
          break;
        }
      }
    }
    if (app.proof !== null && proofs.length && !proofs.some((p) => Math.abs(p.proof - app.proof) <= PROOF_TOL)) {
      issues.push(`Proof on label (${proofs[0].proof}) differs from application (${app.proof}).`);
    }
    if (issues.length) return { ...field, status: "fail", found: allText.join(" / "), note: issues.join(" ") };
    const others = onLabel.filter((s) => !(eq(s.min, match.min) && eq(s.max, match.max)));
    if (others.length) return { ...field, status: "review", conflict: true, found: allText.join(" / "),
      note: `The label shows more than one alcohol content (${[match, ...others].map(fmtAlc).join(", ")}). Check which one is printed as the statement.` };
    if (match.proofOnly) return { ...field, status: "review", found: match.text,
      note: "Only a proof statement was found; check the label states alcohol by volume." };
    if (match.range) return { ...field, status: "pass", found: match.text, note: `Range ${fmtAlc(match)} matches.` };
    return { ...field, status: "pass", found: match.text, note: `${match.min}% alcohol by volume matches.` };
  }

  // Kept for callers/tests that want just the label statements
  function findAlcoholOnLabel(text) {
    return parseAlcoholStatements(text).statements.map((s) => ({ abv: s.min, ...s }));
  }

  // ---------- net contents ----------

  const UNIT_ML = { ML: 1, CL: 10, DL: 100, L: 1000, LTR: 1000, LITER: 1000, LITRE: 1000,
    FLOZ: 29.5735, OZ: 29.5735, PINT: 473.176, QUART: 946.353, GAL: 3785.41 };
  const UNIT_ALIASES = [
    [/^(ML|MILLILITERS?|MILLILITRES?)$/, "ML"], [/^(CL|CENTILITERS?|CENTILITRES?)$/, "CL"],
    [/^(DL|DECILITERS?|DECILITRES?)$/, "DL"], [/^(L|LTRS?|LITERS?|LITRES?)$/, "L"],
    [/^(FLOZ|FLUIDOUNCES?|USFLOZ)$/, "FLOZ"], [/^(OZ|OUNCES?)$/, "OZ"], [/^PINTS?$/, "PINT"],
    [/^QUARTS?$/, "QUART"], [/^(GAL|GALS|GALLONS?)$/, "GAL"],
  ];

  function parseVolumes(s) {
    const t = cleanQuotes(s).toUpperCase().replace(/\s+/g, " ");
    const re = /(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)\s*(MILLILIT(?:ER|RE)S?|CENTILIT(?:ER|RE)S?|DECILIT(?:ER|RE)S?|LIT(?:ER|RE)S?|LTRS?|ML|CL|DL|L|(?:U\.?S\.?\s*)?FL(?:UID)?\.?\s*(?:OZ|OUNCES?)\.?|OZ\.?|OUNCES?|PINTS?|QUARTS?|GAL(?:LON)?S?)(?![A-Z])/g;
    const out = [];
    let m;
    while ((m = re.exec(t))) {
      const raw = m[2].replace(/[.\s]/g, "");
      const alias = UNIT_ALIASES.find(([rx]) => rx.test(raw));
      const factor = alias && UNIT_ML[alias[1]];
      const n = parseNumber(m[1]);
      if (!factor || n === null || n <= 0) continue;
      out.push({ ml: n * factor, text: m[0].trim() });
    }
    return out;
  }

  function checkNetContents(expected, labelText) {
    const field = { label: "Net contents", expected: expected || "" };
    const app = parseVolumes(expected || "")[0];
    if (!app) return { ...field, status: "fail", found: "", note: "Application value is blank or has no unit (e.g. 750 mL)." };
    const onLabel = parseVolumes(labelText);
    if (!onLabel.length) return { ...field, status: "fail", found: "", note: "No net contents statement found on the label." };
    const same = (a, b) => Math.abs(a - b) / Math.max(a, b) < 0.01;
    const match = onLabel.find((v) => same(v.ml, app.ml));
    if (match) {
      const others = onLabel.filter((v) => !same(v.ml, match.ml));
      const also = onLabel.filter((v) => v !== match && same(v.ml, match.ml));
      if (others.length) return { ...field, status: "review", conflict: true, found: onLabel.map((v) => v.text).join(" / "),
        note: `The label shows different amounts (${onLabel.map((v) => v.text).join(", ")}). Check which is the net contents.` };
      const exact = norm(match.text).replace(/\s/g, "") === norm(expected).replace(/\s/g, "");
      let note = exact ? "Exact match." : `Equivalent amount (${Math.round(app.ml)} mL).`;
      if (also.length) note += ` Also stated as ${also.map((v) => v.text).join(", ")}.`;
      return { ...field, status: "pass", found: [match, ...also].map((v) => v.text).join(" / "), note };
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
   * `bold` is an optional { ratio } from LabelType.estimateBoldness (pixel analysis), null for typed text.
   * `typo` optionally carries pixel measurements: { caseShape: { shortFrac }, legibility: { heightRatio, contrast } }.
   */
  function checkWarning(tokens, bold, typo = {}) {
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
    // How many separate warning headings are on the label?
    let headingCount = 0;
    for (let i = 0; i < tokens.length; i++) {
      const two = tokens[i].norm + (tokens[i + 1] ? tokens[i + 1].norm : "");
      if (similarity(two, "GOVERNMENTWARNING") >= 0.9 || similarity(tokens[i].norm, "GOVERNMENTWARNING") >= 0.9) { headingCount++; i++; }
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
    let capsStatus = lower === 0 ? "pass" : lower <= 1 && headLetters.length > 12 && hScore < 0.95 ? "review" : "fail";
    let capsNote = capsStatus === "pass" ? "All capitals." : capsStatus === "review" ? `Read as “${headRaw}”. One letter may be lowercase — check by eye.`
      : `Heading reads “${headRaw}”. It must be “GOVERNMENT WARNING:” in capital letters.`;
    // Second opinion from the pixels: in true capitals every letter is about the same height.
    const shape = typo && typo.caseShape;
    if (capsStatus === "pass" && shape && isFinite(shape.shortFrac)) {
      if (shape.shortFrac > 0.3) {
        capsStatus = "review";
        capsNote = "Read as capitals, but many letters are shorter than the first one (small capitals or lowercase?). Check by eye.";
      } else capsNote = "All capitals (letter heights confirmed in the image).";
    }
    result.checks.push({ name: "Heading is in capital letters", status: capsStatus, note: capsNote });

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

    if (headingCount > 1) {
      result.checks.push({ name: "Only one warning statement", status: "review",
        note: `The label has ${headingCount} government warnings. Check each one is complete and identical.` });
    }

    // Legibility (pixel measurements): tiny or faint text can be read by OCR but not by a shopper.
    const leg = typo && typo.legibility;
    if (leg && isFinite(leg.heightRatio) && isFinite(leg.contrast)) {
      const tiny = leg.heightRatio < 1 / 100, faint = leg.contrast < 70;
      result.checks.push({ name: "Warning is clearly legible", status: tiny || faint ? "review" : "pass",
        note: tiny && faint ? "Warning text is very small and faint compared with the label. Check it is readable."
          : tiny ? "Warning text is very small compared with the label. Check the type size meets 27 CFR 16.22."
          : faint ? "Warning text has low contrast with its background. Check it is readable."
          : "Text size and contrast look normal." });
    }

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

  /** Pick heading + body word boxes from OCR word list (input for the pixel checks in typography.js). */
  function warningWordBoxes(words) {
    const idx = words.findIndex((w) => /^GOVERN/i.test(w.text.replace(/[^A-Za-z]/g, "")) || similarity(normToken(w.text), "GOVERNMENT") > 0.75);
    if (idx < 0) return null;
    const heading = [words[idx].bbox];
    if (words[idx + 1] && similarity(normToken(words[idx + 1].text), "WARNING") > 0.6) heading.push(words[idx + 1].bbox);
    const body = words.slice(idx + heading.length, idx + heading.length + 40)
      .filter((w) => /^[a-z]{3,}$/.test(w.text.replace(/[^A-Za-z]/g, "")) && w.confidence > 60).map((w) => w.bbox);
    // every word of the statement, faint ones included (for size/contrast)
    const all = words.slice(idx, idx + heading.length + 45).filter((w) => w.text.replace(/[^A-Za-z]/g, "").length >= 2).map((w) => w.bbox);
    return { heading, body, all };
  }

  // ---------- label integrity ----------

  // Text that reads like instructions to a machine. This app has no AI model to hijack,
  // but such text has no business on a label and is a sign someone is probing the system.
  const INSTRUCTION_PATTERNS = [
    /\b(IGNORE|DISREGARD)\b.{0,30}\b(PREVIOUS|ABOVE|PRIOR|INSTRUCTIONS?|RULES?)\b/i,
    /\bOVERRIDE\b/i, /\bSYSTEM\s*(PROMPT|MESSAGE)\b/i, /\bPROMPT\b/i,
    /\b(IS_BOLD|IS_ALL_CAPS|GOVERNMENT_WARNING_TEXT|VERDICT|STATUS)\s*["']?\s*:/i,
    /\{\s*["'][A-Za-z_]+["']\s*:/, /\bRETURN\s*\{/i, /<\/?(script|system|instruction)/i,
  ];

  function checkIntegrity(text) {
    const field = { label: "Label integrity", expected: "No instructions, code or hidden text" };
    const flat = cleanQuotes(text).replace(/\s+/g, " ");
    const hits = [];
    for (const rx of INSTRUCTION_PATTERNS) {
      const m = flat.match(rx);
      if (m) hits.push(m[0]);
    }
    if (hits.length) {
      return { ...field, status: "review", found: hits.slice(0, 3).join(" · "),
        note: "The label contains text that looks like computer instructions or code. It does not change any result, but the artwork should be examined." };
    }
    return { ...field, status: "pass", found: "", note: "No instruction-like or code-like text found." };
  }

  // ---------- top level ----------

  /** Run one check; an unexpected error becomes "Check by eye" instead of breaking the whole result. */
  function safe(key, label, fn) {
    try {
      return { key, ...fn() };
    } catch (e) {
      return { key, label, expected: "", found: "", status: "review",
        note: "This item could not be checked automatically. Check it by eye.", error: String(e && e.message || e) };
    }
  }

  function summarize(fields, tokenCount) {
    const counts = { pass: 0, review: 0, fail: 0, skip: 0 };
    fields.forEach((f) => counts[f.status]++);
    const verdict = counts.fail ? "fail" : counts.review ? "review" : "pass";
    return { verdict, counts, fields, tokenCount };
  }

  /**
   * app: { beverageType, brandName, classType, alcoholContent, netContents, bottler, countryOfOrigin }
   * ocr: { text, bold?, caseShape?, legibility? }   (bold === null means typed text)
   */
  function verifyLabel(app, ocr) {
    const text = String((ocr && ocr.text) || "");
    const tokens = tokenize(text);
    app = app || {};
    const bt = app.beverageType || "spirits";
    const typo = { caseShape: ocr && ocr.caseShape, legibility: ocr && ocr.legibility };
    const fields = [
      safe("brandName", "Brand name", () => checkText("Brand name", app.brandName, tokens)),
      safe("classType", "Class / type", () => checkText("Class / type", app.classType, tokens)),
      safe("alcoholContent", "Alcohol content", () => checkAlcohol(app.alcoholContent, text, bt)),
      safe("netContents", "Net contents", () => checkNetContents(app.netContents, text)),
      safe("bottler", "Bottler / producer name & address", () => checkNameAddress(app.bottler, tokens)),
      safe("countryOfOrigin", "Country of origin", () => checkText("Country of origin", app.countryOfOrigin, tokens, { optional: true })),
      safe("warning", "Government health warning", () => checkWarning(tokens, ocr ? ocr.bold : undefined, typo)),
      safe("integrity", "Label integrity", () => checkIntegrity(text)),
    ];
    return summarize(fields, tokens.length);
  }

  /**
   * Combine two reads of the same label (original + cleaned-up image).
   * For each field keep the better read, with two safeguards against crafted images:
   * - a field that failed on the original and passes only after clean-up becomes "Check":
   *   clean-up boosts contrast, which can surface faint text a person would not see;
   * - label integrity keeps the worse of the two reads, so hidden text found in either counts;
   * - a conflicting second value (e.g. a faint "45%" on a 40% label) found in either read is kept.
   */
  function mergeResults(a, b) {
    if (!b) return a;
    const rank = { pass: 3, skip: 3, review: 2, fail: 1 };
    const fields = a.fields.map((fa, i) => {
      const fb = b.fields[i];
      if (fa.key === "integrity") return rank[fb.status] < rank[fa.status] ? { ...fb, fromCleanup: true } : fa;
      // A second, conflicting value seen only in the enhanced image may be faint hidden text: surface it.
      if (fb.conflict && !fa.conflict) return { ...fb, fromCleanup: true, note: fb.note + " One of them only showed up after image enhancement (faint text?)." };
      if (rank[fb.status] <= rank[fa.status]) return fa;
      if (fa.status === "fail" && fb.status === "pass") {
        return { ...fb, status: "review", fromCleanup: true,
          note: fb.note + " Only readable after image enhancement — confirm it is visible on the label." };
      }
      return { ...fb, fromCleanup: true };
    });
    return summarize(fields, Math.max(a.tokenCount, b.tokenCount));
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
    parseAlcohol, parseAlcoholStatements, findAlcoholOnLabel, parseVolumes, alignWords, cleanQuotes,
    warningWordBoxes, checkIntegrity, verifyLabel, mergeResults, parseCSV, toCSV,
  };
});
