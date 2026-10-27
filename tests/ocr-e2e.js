// End-to-end: run every sample label — and every red-team label — through the same
// pipeline the browser uses (offline OCR -> pixel measurements -> checks -> clean-up pass),
// report verdicts and timing against the 5-second target. Run: npm run e2e
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createWorker } = require("tesseract.js");
const V = require("../src/verify.js");
const P = require("../src/preprocess.js");
const T = require("../src/typography.js");

const root = path.join(__dirname, "..");
const samples = path.join(root, "samples");

function loadGray(file) {
  // Decode with Pillow to 8-bit grayscale PGM (stand-in for the browser canvas)
  const buf = execFileSync("python3", ["-c",
    "import sys,io;from PIL import Image;im=Image.open(sys.argv[1]).convert('L');b=io.BytesIO();im.save(b,'PPM');sys.stdout.buffer.write(b.getvalue())", file],
    { maxBuffer: 64 * 1024 * 1024 });
  const header = buf.toString("latin1", 0, 50).match(/^P5\s+(\d+)\s+(\d+)\s+255\s/);
  const w = +header[1], h = +header[2];
  return { gray: new Uint8Array(buf.subarray(header[0].length)), w, h };
}

function measure(img, words) {
  const boxes = V.warningWordBoxes(words || []);
  if (!boxes) return { bold: { ratio: NaN } };
  return {
    bold: T.estimateBoldness(img.gray, img.w, boxes.heading, boxes.body),
    caseShape: T.caseShape(img.gray, img.w, boxes.heading),
    legibility: T.legibility(img.gray, img.w, img.h, boxes.all),
  };
}

const MAIN = {
  "old-tom-bourbon.png": "pass",
  "stones-throw-gin.png": "pass",
  "riverbend-vodka.png": "fail",
  "colle-alto-chianti.png": "fail",
  "hop-field-ipa.png": "fail",
  "old-tom-photo.jpg": "pass|review",
};

async function runSet(worker, dir, csvName, expectedFor) {
  const rows = V.parseCSV(fs.readFileSync(path.join(dir, csvName), "utf8"));
  const raw = fs.readFileSync(path.join(dir, csvName), "utf8");
  let ok = true, fast = true;
  for (const app of rows) {
    const want = expectedFor(app, raw);
    const loaded = loadGray(path.join(dir, app.filename));
    const s = Date.now();
    const img = { ...loaded, gray: P.deskew(loaded.gray, loaded.w, loaded.h).gray };
    const pass1 = (await worker.recognize(Buffer.from(P.toPGM(img.gray, img.w, img.h)))).data;
    const typo = measure(img, pass1.words);
    const dpi = P.readImageDpi(fs.readFileSync(path.join(dir, app.filename)));
    if (dpi && dpi >= 150 && typo.legibility && isFinite(typo.legibility.textHeightPx)) {
      typo.physical = { dpi, textHeightMm: (typo.legibility.textHeightPx / dpi) * 25.4 };   // Node reads at original size
    }
    let result = V.verifyLabel(app, { text: pass1.text, ...typo });
    // second, independent read of the cleaned image: always run, so the two reads cross-check
    const flat = P.flatten(img.gray, img.w, img.h);
    const pass2 = (await worker.recognize(Buffer.from(P.toPGM(flat, img.w, img.h)))).data;
    result = V.mergeResults(result, V.verifyLabel(app, { text: pass2.text, ...typo }));
    const passes = 2;
    const ms = Date.now() - s;
    const good = new RegExp(`^(${want})$`).test(result.verdict);
    ok = ok && good; fast = fast && ms < 5000;
    const m = `bold=${isFinite(typo.bold.ratio) ? typo.bold.ratio.toFixed(2) : "–"} short=${typo.caseShape ? (+typo.caseShape.shortFrac).toFixed(2) : "–"} ` +
      `h=${typo.legibility ? typo.legibility.textHeightPx : "–"}px contrast=${typo.legibility ? typo.legibility.contrast : "–"}`;
    console.log(`\n${good ? "✓" : "✗"} ${app.filename}  ${ms} ms (${passes} pass${passes > 1 ? "es" : ""})  verdict=${result.verdict}  expected=${want}  [${m}]`);
    for (const f of result.fields) {
      if (f.status === "pass" || f.status === "skip") continue;
      console.log(`    ${f.status.padEnd(6)} ${f.label.padEnd(36)} ${f.note}${f.fromCleanup ? "  [clean-up pass]" : ""}`);
      if (f.checks) f.checks.filter((c) => c.status !== "pass" && c.status !== "skip").forEach((c) => console.log(`           · ${c.status.padEnd(6)} ${c.name}: ${c.note}`));
    }
    if (process.env.SHOW_TEXT) console.log(pass1.text);
  }
  return { ok, fast };
}

(async () => {
  const t0 = Date.now();
  const worker = await createWorker("eng", 1, {
    langPath: path.join(root, "node_modules/@tesseract.js-data/eng/4.0.0_best_int"),
    cacheMethod: "none",
  });
  await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
  console.log(`engine ready in ${Date.now() - t0} ms\n=== sample labels ===`);
  const a = await runSet(worker, samples, "batch.csv", (app) => MAIN[app.filename] || "");
  console.log("\n=== red-team labels ===");
  const rtRows = {};
  for (const line of fs.readFileSync(path.join(samples, "redteam/redteam.csv"), "utf8").split(/\r?\n/).slice(1)) {
    const name = line.split(",")[0];
    const m = line.match(/,(pass|review\|fail|review|fail),/);
    if (name && m) rtRows[name] = m[1];
  }
  const b = await runSet(worker, path.join(samples, "redteam"), "redteam.csv", (app) => rtRows[app.filename] || "");
  await worker.terminate();
  const ok = a.ok && b.ok, fast = a.fast && b.fast;
  console.log(`\n${ok ? "all verdicts as expected" : "SOME VERDICTS UNEXPECTED"}; ${fast ? "all labels under 5 s" : "SOME LABELS OVER 5 s"}`);
  process.exit(ok && fast ? 0 : 1);
})();
