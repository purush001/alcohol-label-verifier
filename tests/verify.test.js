// Unit tests for the comparison engine. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../src/verify.js");

const GOOD_LABEL = `OLD TOM DISTILLERY
Kentucky Straight Bourbon Whiskey
45% Alc./Vol. (90 Proof)
750 mL
Bottled by Old Tom Distillery, Bardstown, KY
${V.WARNING_FULL}`;

const APP = {
  beverageType: "spirits",
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
  bottler: "Old Tom Distillery, Bardstown, Kentucky",
  countryOfOrigin: "",
};

const status = (r, key) => r.fields.find((f) => f.key === key).status;

test("compliant label passes every field", () => {
  const r = V.verifyLabel(APP, { text: GOOD_LABEL, bold: { ratio: 1.5 } });
  for (const f of r.fields) assert.ok(["pass", "skip"].includes(f.status), `${f.label}: ${f.status} ${f.note}`);
  assert.equal(r.verdict, "pass");
});

test("brand case/punctuation difference passes with a note (STONE'S THROW vs Stone's Throw)", () => {
  const f = V.checkText("Brand name", "Stone's Throw", V.tokenize("STONE’S THROW\nLondon Dry Gin"));
  assert.equal(f.status, "pass");
  assert.match(f.note, /capitalization/i);
});

test("one-letter OCR slip in brand goes to review, a different brand fails", () => {
  assert.equal(V.checkText("Brand", "OLD TOM DISTILLERY", V.tokenize("OLD TOM DISTILIERY")).status, "review");
  assert.equal(V.checkText("Brand", "OLD TOM DISTILLERY", V.tokenize("RIVER BEND SPIRITS CO")).status, "fail");
});

test("ABV mismatch fails and says what the label shows", () => {
  const f = V.checkAlcohol("13.5% Alc./Vol.", "Alc. 14.5% by Vol.", "wine");
  assert.equal(f.status, "fail");
  assert.match(f.note, /14\.5/);
});

test("proof must be twice ABV", () => {
  assert.equal(V.checkAlcohol("45%", "45% Alc./Vol. (92 Proof)", "spirits").status, "fail");
  assert.equal(V.checkAlcohol("45% (90 Proof)", "45 % ALC/VOL 90 PROOF", "spirits").status, "pass");
  assert.equal(V.checkAlcohol("ALC. 5.2% BY VOL.", "ALC. 5.2% BY VOL", "beer").status, "pass");
});

test("net contents accepts equivalent units", () => {
  assert.equal(V.checkNetContents("355 mL", "12 FL. OZ.").status, "pass");
  assert.equal(V.checkNetContents("1.75 L", "1750 ML").status, "pass");
  assert.equal(V.checkNetContents("750 mL", "700 ml").status, "fail");
});

test("warning in title case is rejected", () => {
  const txt = V.WARNING_FULL.replace("GOVERNMENT WARNING:", "Government Warning:");
  const f = V.checkWarning(V.tokenize(txt), { ratio: 1.5 });
  assert.equal(f.status, "fail");
  assert.equal(f.checks.find((c) => /capital/.test(c.name)).status, "fail");
});

test("reworded warning is rejected with the changed words named", () => {
  const txt = V.WARNING_FULL.replace("health problems", "health issues");
  const f = V.checkWarning(V.tokenize(txt), { ratio: 1.5 });
  assert.equal(f.status, "fail");
  assert.match(f.note, /problems/);
});

test("missing warning fails", () => {
  const f = V.checkWarning(V.tokenize("OLD TOM DISTILLERY 750 mL"), null);
  assert.equal(f.status, "fail");
});

test("non-bold heading goes to review, not auto-reject", () => {
  const f = V.checkWarning(V.tokenize(V.WARNING_FULL), { ratio: 1.0 });
  assert.equal(f.status, "review");
});

test("name & address tolerates state abbreviations", () => {
  const f = V.checkNameAddress("Old Tom Distillery, Bardstown, Kentucky", V.tokenize("Bottled by Old Tom Distillery Bardstown KY"));
  assert.equal(f.status, "pass");
});

test("CSV parsing maps common header names", () => {
  const rows = V.parseCSV('filename,Brand Name,ABV,Net Contents,Type\n"a.png","Stone\'s Throw, Ltd",40%,750 mL,Distilled Spirits\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].brandName, "Stone's Throw, Ltd");
  assert.equal(rows[0].alcoholContent, "40%");
  assert.equal(rows[0].beverageType, "spirits");
});
