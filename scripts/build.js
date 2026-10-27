// Assemble a static, self-contained site in public/ (no network needed at runtime).
// Run: npm run build   — then host public/ on any static web server.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const root = path.join(__dirname, "..");
const out = path.join(root, "public");
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), "<!doctype html>\n<html lang=\"en\">\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n" + fs.readFileSync(path.join(root, "src/page.html"), "utf8"));
for (const f of ["verify.js", "preprocess.js", "engine.js", "app.js"]) cp(path.join(root, "src", f), path.join(out, "src", f));
const nm = path.join(root, "node_modules");
cp(path.join(nm, "tesseract.js/dist/tesseract.min.js"), path.join(out, "vendor/tesseract.min.js"));
cp(path.join(nm, "tesseract.js/dist/worker.min.js"), path.join(out, "vendor/worker.min.js"));
cp(path.join(root, "src/ocr-worker.js"), path.join(out, "vendor/ocr-worker.js"));
for (const f of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"])
  cp(path.join(nm, "tesseract.js-core", f), path.join(out, "vendor/core", f));
// English model (LSTM, integer-quantized: small and fast). Stored uncompressed so any web server works.
fs.mkdirSync(path.join(out, "vendor/lang"), { recursive: true });
fs.writeFileSync(path.join(out, "vendor/lang/eng.traineddata.wasm"),
  zlib.gunzipSync(fs.readFileSync(path.join(nm, "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"))));
for (const f of fs.readdirSync(path.join(root, "samples"))) cp(path.join(root, "samples", f), path.join(out, "samples", f));
console.log("built", out);
