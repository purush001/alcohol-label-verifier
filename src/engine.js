/*
 * engine.js — browser side of the pipeline: image -> canvas -> local OCR -> checks.
 * The OCR engine (Tesseract, WebAssembly) and its English model ship with the app,
 * so nothing is sent over the network and no outside ML endpoint is needed.
 */
(function (root) {
  "use strict";
  const V = root.LabelVerify, P = root.LabelPre;
  const asset = (p) => new URL(p, document.baseURI).href;

  const MAX_SIDE = 2000;   // larger photos are scaled down (speed)
  const MIN_SIDE = 1100;   // small images are scaled up (accuracy)

  let schedulerPromise = null;
  let workerCount = 0;

  function workersWanted() {
    const cores = navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(4, cores - 1));
  }

  /** Start OCR workers once; reused for every label. onStatus(text) reports progress. */
  function init(onStatus) {
    if (schedulerPromise) return schedulerPromise;
    schedulerPromise = (async () => {
      if (!root.Tesseract) throw new Error("The reading engine did not load.");
      const scheduler = root.Tesseract.createScheduler();
      const n = workersWanted();
      const opts = {
        workerPath: asset("vendor/ocr-worker.js"),
        corePath: asset("vendor/core/"),
        langPath: asset("vendor/lang"),
        workerBlobURL: false,
        cacheMethod: "none",
        gzip: false,
      };
      onStatus && onStatus("Loading the reading engine…");
      // First worker alone so the app is usable as soon as possible
      const first = await root.Tesseract.createWorker("eng", 1, opts);
      await first.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
      scheduler.addWorker(first);
      workerCount = 1;
      onStatus && onStatus("ready");
      // Remaining workers in the background (for batches and the two-pass read)
      (async () => {
        for (let i = 1; i < n; i++) {
          try {
            const w = await root.Tesseract.createWorker("eng", 1, opts);
            await w.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
            scheduler.addWorker(w);
            workerCount++;
          } catch (e) { break; }
        }
      })();
      return scheduler;
    })();
    schedulerPromise.catch(() => { schedulerPromise = null; });
    return schedulerPromise;
  }

  /** Load a File/Blob/URL into a grayscale canvas at a good OCR size. */
  async function loadImage(src) {
    const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
    let bmp;
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (e) {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("This file is not an image the browser can open. Use JPG or PNG."));
        img.src = URL.createObjectURL(blob);
      });
    }
    const iw = bmp.width, ih = bmp.height;
    const long = Math.max(iw, ih);
    const scale = long > MAX_SIDE ? MAX_SIDE / long : long < MIN_SIDE ? MIN_SIDE / long : 1;
    const w = Math.round(iw * scale), h = Math.round(ih * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    const gray = P.toGray(ctx.getImageData(0, 0, w, h).data, w, h);
    ctx.putImageData(new ImageData(P.grayToRGBA(gray), w, h), 0, 0);
    return { canvas, gray, w, h, original: { w: iw, h: ih } };
  }

  function cleanedCanvas(img) {
    const flat = P.flatten(img.gray, img.w, img.h);
    const c = document.createElement("canvas");
    c.width = img.w; c.height = img.h;
    c.getContext("2d").putImageData(new ImageData(P.grayToRGBA(flat), img.w, img.h), 0, 0);
    return c;
  }

  /**
   * Read one label and check it against the application.
   * Two reads: the image as given, and a cleaned-up copy (glare and shadows flattened).
   * With spare workers both run at once; otherwise the second runs only if needed.
   */
  async function checkLabel(src, app, { onStage, parallel: allowParallel = true } = {}) {
    const t0 = performance.now();
    const scheduler = await init();
    onStage && onStage("Preparing image");
    const img = await loadImage(src);
    onStage && onStage("Reading label");
    const read = (canvas) => scheduler.addJob("recognize", canvas, { rotateAuto: true });
    const parallel = allowParallel && workerCount > 1;
    const job1 = read(img.canvas);
    const job2 = parallel ? read(cleanedCanvas(img)) : null;
    const r1 = (await job1).data;
    const boxes = V.warningWordBoxes(r1.words || []);
    const bold = boxes ? V.estimateBoldness(img.gray, img.w, boxes.heading, boxes.body) : { ratio: NaN };
    let result = V.verifyLabel(app, { text: r1.text, bold });
    let text2 = "";
    if (job2 || result.verdict !== "pass") {
      onStage && onStage("Double-checking");
      const r2 = (await (job2 || read(cleanedCanvas(img)))).data;
      text2 = r2.text;
      result = V.mergeResults(result, V.verifyLabel(app, { text: r2.text, bold }));
    }
    result.ms = performance.now() - t0;
    result.ocrText = r1.text;
    result.ocrText2 = text2;
    result.confidence = r1.confidence;
    result.lowQuality = r1.confidence < 55 && result.tokenCount < 25;
    return result;
  }

  /** Check from typed/pasted label text (no image). */
  function checkText(text, app) {
    const t0 = performance.now();
    const r = V.verifyLabel(app, { text, bold: null });
    r.ms = performance.now() - t0;
    r.ocrText = text;
    r.fromText = true;
    return r;
  }

  root.LabelEngine = { init, checkLabel, checkText, loadImage, get workers() { return workerCount; } };
})(self);
