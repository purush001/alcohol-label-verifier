/*
 * preprocess.js — image clean-up for hard photos (glare, uneven lighting, low contrast).
 * Pure functions over grayscale Uint8Arrays so they run in the browser and in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LabelPre = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** RGBA (canvas ImageData.data) -> grayscale */
  function toGray(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    return g;
  }

  /** Box blur via integral image (fast for any radius). */
  function boxBlur(g, w, h, r) {
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0;
      for (let x = 1; x <= w; x++) {
        row += g[(y - 1) * w + (x - 1)];
        integ[y * W + x] = integ[(y - 1) * W + x] + row;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const s = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  /**
   * Flatten illumination: estimate the paper brightness around every pixel
   * (blurred local maximum) and divide it out. Removes glare and shading while
   * keeping ink dark, then stretches contrast.
   */
  function flatten(g, w, h) {
    const r = Math.max(8, Math.round(Math.min(w, h) / 40));
    // local "paper" estimate: dilate (max) with small radius, then blur
    const dil = new Uint8Array(w * h);
    const rr = Math.max(2, Math.round(r / 3));
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0; const a = Math.max(0, x - rr), b = Math.min(w - 1, x + rr);
      for (let k = a; k <= b; k++) { const v = g[y * w + k]; if (v > m) m = v; }
      tmp[y * w + x] = m;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0; const a = Math.max(0, y - rr), b = Math.min(h - 1, y + rr);
      for (let k = a; k <= b; k++) { const v = tmp[k * w + x]; if (v > m) m = v; }
      dil[y * w + x] = m;
    }
    const bg = boxBlur(dil, w, h, r);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) {
      const v = (g[i] / Math.max(1, bg[i])) * 255;
      out[i] = v > 255 ? 255 : v;
    }
    // contrast stretch between 1st and 99th percentile
    const hist = new Uint32Array(256);
    for (let i = 0; i < out.length; i++) hist[out[i]]++;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > out.length * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > out.length * 0.01) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < out.length; i++) {
      const v = ((out[i] - lo) * 255) / span;
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return out;
  }

  /** Grayscale -> RGBA for putting back on a canvas */
  function grayToRGBA(g) {
    const o = new Uint8ClampedArray(g.length * 4);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) { o[j] = o[j + 1] = o[j + 2] = g[i]; o[j + 3] = 255; }
    return o;
  }

  /** Grayscale -> binary PGM (P5) so Node tests can hand it to the OCR engine */
  function toPGM(g, w, h) {
    const head = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
    const out = new Uint8Array(head.length + g.length);
    out.set(head); out.set(g, head.length);
    return out;
  }

  return { toGray, flatten, grayToRGBA, toPGM, boxBlur };
});
