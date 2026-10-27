// UI smoke test: load the page in jsdom with the OCR engine stubbed (it returns the
// label's known text), then drive the single-label and batch flows. Run: node tests/ui-smoke.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const V = require("../src/verify.js");

const KNOWN_TEXT = {
  "old-tom-bourbon.png": `OLD TOM DISTILLERY\nKentucky Straight Bourbon Whiskey\n45% Alc./Vol. (90 Proof)\n750 mL\nDistilled and Bottled by Old Tom Distillery, Bardstown, Kentucky\n${V.WARNING_FULL}`,
};
const page = fs.readFileSync(path.join(root, "src/page.html"), "utf8").replace(/<script src=[^>]+><\/script>/g, "");
const dom = new JSDOM(`<!doctype html><html><head></head><body>${page}</body></html>`, { runScripts: "outside-only", url: "http://localhost/" });
const w = dom.window;
w.matchMedia = () => ({ matches: false });
w.HTMLElement.prototype.scrollIntoView = () => {};
w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
w.fetch = async (u) => {
  const p = path.join(root, String(u));
  const buf = fs.readFileSync(p);
  return { ok: true, text: async () => buf.toString("utf8"), blob: async () => ({ name: path.basename(p), size: buf.length, type: "image/png" }) };
};
for (const f of ["verify.js", "preprocess.js"]) w.eval(fs.readFileSync(path.join(root, "src", f), "utf8"));
// Stub engine
w.LabelEngine = {
  workers: 2,
  init: async (cb) => { cb && cb("ready"); },
  checkLabel: async (src, app) => {
    const name = typeof src === "string" ? path.basename(src) : src.name;
    const text = KNOWN_TEXT[name] || KNOWN_TEXT["old-tom-bourbon.png"].replace("45%", app.brandName === "COLLE ALTO" ? "14.5%" : "45%");
    const r = w.LabelVerify.verifyLabel(app, { text, bold: { ratio: 1.6 } });
    r.ms = 900; r.ocrText = text; return r;
  },
  checkText: (text, app) => { const r = w.LabelVerify.verifyLabel(app, { text, bold: { ratio: NaN } }); r.ms = 1; r.fromText = true; r.ocrText = text; return r; },
};
const errors = [];
w.addEventListener("error", (e) => errors.push(e.message));
w.console.error = (...a) => errors.push(a.join(" "));
w.eval(fs.readFileSync(path.join(root, "src/app.js"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(300);
  const $ = (id) => w.document.getElementById(id);
  const verdict = () => $("verdict").textContent.replace(/\s+/g, " ").trim();
  console.log("chips:", [...w.document.querySelectorAll("#samples .chip")].map((c) => c.textContent).join(" | "));
  console.log("initial verdict:", verdict());
  console.log("rows:", $("resultBody").querySelectorAll(".row").length);
  // Change brand to wrong value -> should fail
  $("brandName").value = "OLD TIM DISTILLERY";
  $("appForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(100);
  console.log("after brand edit:", verdict());
  // Text mode with title-case warning
  $("textMode").open = true;
  $("brandName").value = "OLD TOM DISTILLERY";
  $("labelText").value = KNOWN_TEXT["old-tom-bourbon.png"].replace("GOVERNMENT WARNING", "Government Warning");
  $("appForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(100);
  console.log("text mode:", verdict());
  // Batch sample
  $("tab-batch").click();
  $("bsample").click();
  await sleep(800);
  console.log("batch progress:", $("bprog").textContent);
  console.log("batch summary:", $("bsummary").textContent.replace(/\s+/g, " ").trim());
  console.log("batch rows:", $("btable").querySelectorAll("tr").length);
  const view = $("btable").querySelector("button[data-i]");
  view && view.click();
  await sleep(50);
  console.log("detail verdict:", $("bdetail").querySelector(".verdict")?.textContent.replace(/\s+/g, " ").trim());
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no errors");
  process.exit(errors.length ? 1 : 0);
})();
