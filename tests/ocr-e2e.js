// End-to-end: run every sample label through the same pipeline the browser uses
// (bundled offline OCR engine -> checks -> optional clean-up pass), report verdicts
// and timing against the 5-second target. Run: npm run e2e
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createWorker } = require("tesseract.js");
const V = require("../src/verify.js");
const P = require("../src/preprocess.js");

const root = path.join(__dirname, "..");
const samples = path.join(root, "samples");

function loadGray(file) {
  // Decode with Pillow to 8-bit grayscale PGM (stand-in for the browser canvas)
  const buf = execFileSync("python3", ["-c",
    "import sys,io;from PIL import Image;im=Image.open(sys.argv[1]).convert('L');b=io.BytesIO();im.save(b,'PPM');sys.stdout.buffer.write(b.getvalue())", file], { maxBuffer: 64 * 1024 * 1024 });
  const header = buf.toString("latin1", 0, 50).match(/^P5\s+(\d+)\s+(\d+)\s+255\s/);
  const w = +header[1], h = +header[2];
  return { gray: new Uint8Array(buf.subarray(header[0].length)), w, h };
}

const expectations = {
  "old-tom-bourbon.png": "pass",
  "stones-throw-gin.png": "pass",
  "riverbend-vodka.png": "fail",
  "colle-alto-chianti.png": "fail",
  "hop-field-ipa.png": "fail",
  "old-tom-photo.jpg": "pass|review",
};

(async () => {
  const t0 = Date.now();
  const worker = await createWorker("eng", 1, {
    langPath: path.join(root, "node_modules/@tesseract.js-data/eng/4.0.0_best_int"),
    cacheMethod: "none",
  });
  await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
  console.log(`engine ready in ${Date.now() - t0} ms`);
  const rows = V.parseCSV(fs.readFileSync(path.join(samples, "batch.csv"), "utf8"));
  let allFast = true, allExpected = true;
  for (const app of rows) {
    const { gray, w, h } = loadGray(path.join(samples, app.filename));
    const s = Date.now();
    const pass1 = (await worker.recognize(Buffer.from(P.toPGM(gray, w, h)), { rotateAuto: true })).data;
    const boxes = V.warningWordBoxes(pass1.words || []);
    const bold = boxes ? V.estimateBoldness(gray, w, boxes.heading, boxes.body) : { ratio: NaN };
    let result = V.verifyLabel(app, { text: pass1.text, bold });
    let passes = 1;
    if (result.verdict !== "pass") {
      const flat = P.flatten(gray, w, h);
      const pass2 = (await worker.recognize(Buffer.from(P.toPGM(flat, w, h)), { rotateAuto: true })).data;
      result = V.mergeResults(result, V.verifyLabel(app, { text: pass2.text, bold }));
      passes = 2;
    }
    const ms = Date.now() - s;
    const want = expectations[app.filename] || "";
    const okVerdict = new RegExp(`^(${want})$`).test(result.verdict);
    if (!okVerdict) allExpected = false;
    if (ms > 5000) allFast = false;
    console.log(`\n${okVerdict ? "✓" : "✗"} ${app.filename}  ${ms} ms (${passes} pass${passes > 1 ? "es" : ""})  verdict=${result.verdict}  expected=${want}  bold-ratio=${bold.ratio?.toFixed?.(2)}`);
    for (const f of result.fields) {
      console.log(`    ${f.status.padEnd(6)} ${f.label.padEnd(36)} ${f.note}${f.fromCleanup ? "  [clean-up pass]" : ""}`);
      if (f.checks && f.status !== "pass") f.checks.filter((c) => c.status !== "pass").forEach((c) => console.log(`           · ${c.status.padEnd(6)} ${c.name}: ${c.note}`));
    }
    if (process.env.SHOW_TEXT) console.log(pass1.text);
  }
  await worker.terminate();
  console.log(`\n${allExpected ? "all verdicts as expected" : "SOME VERDICTS UNEXPECTED"}; ${allFast ? "all labels under 5 s" : "SOME LABELS OVER 5 s"}`);
  process.exit(allExpected && allFast ? 0 : 1);
})();
