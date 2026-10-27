/*
 * engine.js — browser side of the pipeline: file -> safety checks -> canvas -> local OCR -> checks.
 * The OCR engine (Tesseract, WebAssembly) and its English model ship with the app,
 * so nothing is sent over the network and no outside ML endpoint is needed.
 */
(function (root) {
  "use strict";
  const V = root.LabelVerify, P = root.LabelPre, T = root.LabelType;
  const asset = (p) => new URL(p, document.baseURI).href;

  const ENGINE_VERSION = "label-verifier 0.3.0 / tesseract.js 5.1.1 / eng 4.0.0_best_int";
  const LIMITS = {
    maxFileBytes: 20 * 1024 * 1024,   // 20 MB per image
    maxPixels: 50e6,                  // 50 megapixels (refused from the header, before decoding)
    maxSide: 2000,                    // larger photos are scaled down (speed)
    minSide: 1100,                    // small images are scaled up (accuracy)
  };

  let schedulerPromise = null;
  let workerCount = 0;

  function workersWanted() {
    const cores = navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(4, cores - 1));
  }

  class InputError extends Error {}

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
      const params = { tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" };
      onStatus && onStatus("Loading the reading engine…");
      const first = await root.Tesseract.createWorker("eng", 1, opts);
      await first.setParameters(params);
      scheduler.addWorker(first);
      workerCount = 1;
      onStatus && onStatus("ready");
      (async () => {
        for (let i = 1; i < n; i++) {
          try {
            const w = await root.Tesseract.createWorker("eng", 1, opts);
            await w.setParameters(params);
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

  /** Read the file into memory once, refusing oversized files and images before decoding. */
  async function readBytes(src) {
    const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
    if (blob.size > LIMITS.maxFileBytes) {
      throw new InputError(`This image is ${(blob.size / 1048576).toFixed(0)} MB. The limit is 20 MB — save it as a smaller JPG.`);
    }
    if (blob.size === 0) throw new InputError("This file is empty.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dims = P.readImageSize(bytes);
    if (!dims) throw new InputError("This file is not a JPG, PNG, WebP, GIF or BMP image.");
    if (!dims.w || !dims.h || dims.w * dims.h > LIMITS.maxPixels) {
      throw new InputError(`This image is ${dims.w} × ${dims.h} pixels, which is too large to check safely. Resize it below 50 megapixels.`);
    }
    return { blob, bytes, dims };
  }

  /** Decode into a grayscale canvas at a good OCR size. */
  async function loadImage(blob) {
    let bmp;
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (e) {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); res(img); };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new InputError("This image could not be opened. Use JPG or PNG.")); };
        img.src = url;
      });
    }
    const iw = bmp.width, ih = bmp.height;
    const long = Math.max(iw, ih);
    const scale = long > LIMITS.maxSide ? LIMITS.maxSide / long : long < LIMITS.minSide ? LIMITS.minSide / long : 1;
    const w = Math.round(iw * scale), h = Math.round(ih * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    // Straighten tilted photos ourselves (rather than inside the OCR engine) so the word
    // positions the OCR reports line up with the pixels the typography checks measure.
    const { gray, angle } = P.deskew(P.toGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h);
    ctx.putImageData(new ImageData(P.grayToRGBA(gray), w, h), 0, 0);
    return { canvas, gray, w, h, angle, original: { w: iw, h: ih } };
  }

  function cleanedCanvas(img) {
    const flat = P.flatten(img.gray, img.w, img.h);
    const c = document.createElement("canvas");
    c.width = img.w; c.height = img.h;
    c.getContext("2d").putImageData(new ImageData(P.grayToRGBA(flat), img.w, img.h), 0, 0);
    return c;
  }

  /** Pixel measurements of the warning: boldness, letter shapes (capitals), size and contrast. */
  function measureTypography(img, words) {
    const boxes = V.warningWordBoxes(words || []);
    if (!boxes) return { bold: { ratio: NaN } };
    return {
      bold: T.estimateBoldness(img.gray, img.w, boxes.heading, boxes.body),
      caseShape: T.caseShape(img.gray, img.w, boxes.heading),
      legibility: T.legibility(img.gray, img.w, img.h, boxes.all),
    };
  }

  /**
   * Read one label and check it against the application.
   * Two independent reads every time: the image as given, and a cleaned-up copy (glare and
   * shadows flattened). They cross-check each other (see LabelVerify.mergeResults).
   * With spare workers both run at once.
   * Pass `prepared` (from readBytes) to avoid reading the file twice.
   */
  async function checkLabel(src, app, { onStage, parallel: allowParallel = true, prepared } = {}) {
    const t0 = performance.now();
    const scheduler = await init();
    onStage && onStage("Preparing image");
    const file = prepared || (await readBytes(src));
    const img = await loadImage(file.blob);
    onStage && onStage("Reading label");
    const read = (canvas) => scheduler.addJob("recognize", canvas);
    const parallel = allowParallel && workerCount > 1;
    const job1 = read(img.canvas);
    const job2 = parallel ? read(cleanedCanvas(img)) : null;
    const r1 = (await job1).data;
    const typo = measureTypography(img, r1.words);
    let result = V.verifyLabel(app, { text: r1.text, ...typo });
    onStage && onStage("Double-checking");
    const r2 = (await (job2 || read(cleanedCanvas(img)))).data;
    const text2 = r2.text;
    result = V.mergeResults(result, V.verifyLabel(app, { text: r2.text, ...typo }));
    result.ms = performance.now() - t0;
    result.ocrText = r1.text;
    result.ocrText2 = text2;
    result.confidence = r1.confidence;
    result.lowQuality = r1.confidence < 55 && result.tokenCount < 25;
    result.measurements = {
      deskewDegrees: img.angle,
      boldRatio: isFinite(typo.bold.ratio) ? +typo.bold.ratio.toFixed(2) : null,
      shortLetterShare: typo.caseShape && isFinite(typo.caseShape.shortFrac) ? +typo.caseShape.shortFrac.toFixed(2) : null,
      warningTextHeightPx: typo.legibility && isFinite(typo.legibility.textHeightPx) ? typo.legibility.textHeightPx : null,
      warningContrast: typo.legibility && isFinite(typo.legibility.contrast) ? typo.legibility.contrast : null,
    };
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

  root.LabelEngine = { init, readBytes, checkLabel, checkText, loadImage, InputError, LIMITS, ENGINE_VERSION,
    get workers() { return workerCount; } };
})(self);
