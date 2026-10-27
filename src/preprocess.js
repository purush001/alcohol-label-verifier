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


  /**
   * Read width/height from the file header without decoding the image, so a
   * "decompression bomb" (small file, enormous dimensions) is refused before it
   * can exhaust memory. Supports PNG, JPEG, GIF, WebP, BMP. Returns null if unknown.
   */
  function readImageSize(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const u16be = (i) => (b[i] << 8) | b[i + 1];
    const u16le = (i) => b[i] | (b[i + 1] << 8);
    const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const u32le = (i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "png", w: u32be(16), h: u32be(20) };
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: "gif", w: u16le(6), h: u16le(8) };
    if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { type: "bmp", w: u32le(18), h: Math.abs(u32le(22) | 0) };
    if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {   // RIFF....WEBP
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === "VP8X") return { type: "webp", w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (chunk === "VP8 ") return { type: "webp", w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
      if (chunk === "VP8L") { const v = u32le(21); return { type: "webp", w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = u16be(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return { type: "jpeg", w: u16be(i + 7), h: u16be(i + 5) };
        i += 2 + len;
      }
    }
    return null;
  }

  /**
   * Print resolution stored in the file (PNG pHYs chunk, JPEG JFIF header), in dots per inch.
   * Returns null when the file doesn't say. Used to turn pixel heights into millimetres.
   */
  function readImageDpi(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const u16be = (i) => (b[i] << 8) | b[i + 1];
    if (b.length > 33 && b[0] === 0x89 && b[1] === 0x50) {
      let i = 8;
      while (i + 12 <= b.length && i < 1 << 20) {
        const len = u32be(i), type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
        if (type === "pHYs" && len >= 9 && b[i + 16] === 1) return Math.round(u32be(i + 8) * 0.0254);
        if (type === "IDAT" || type === "IEND") break;
        i += 12 + len;
      }
      return null;
    }
    if (b.length >= 18 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] === 0xe0 &&
        b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {       // "JFIF"
      const units = b[13], x = u16be(14);
      if (units === 1) return x;
      if (units === 2) return Math.round(x * 2.54);
    }
    return null;
  }

  /** Rotate a grayscale image about its centre (bilinear), filling uncovered corners with `fill`. */
  function rotateGray(g, w, h, degrees, fill = 255) {
    const a = (degrees * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const dy = y - cy;
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        const sx = cos * dx - sin * dy + cx, sy = sin * dx + cos * dy + cy;   // inverse map
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { out[y * w + x] = fill; continue; }
        const fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
        const top = g[i] * (1 - fx) + g[i + 1] * fx, bot = g[i + w] * (1 - fx) + g[i + w + 1] * fx;
        out[y * w + x] = top * (1 - fy) + bot * fy;
      }
    }
    return out;
  }

  /**
   * Estimate text tilt in degrees: rotate a small ink mask through ±10° and keep the angle
   * where text lines make the sharpest row profile.
   */
  function detectSkew(g, w, h, maxAngle = 10) {
    const sc = Math.min(1, 420 / Math.max(w, h));
    const sw = Math.max(8, Math.round(w * sc)), sh = Math.max(8, Math.round(h * sc));
    const small = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++)
      small[y * sw + x] = g[Math.min(h - 1, Math.floor(y / sc)) * w + Math.min(w - 1, Math.floor(x / sc))];
    const bg = boxBlur(small, sw, sh, 7);
    const ink = new Uint8Array(sw * sh);
    for (let i = 0; i < ink.length; i++) ink[i] = small[i] < bg[i] - 12 ? 1 : 0;
    const cx = (sw - 1) / 2, cy = (sh - 1) / 2;
    const pts = [];
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (ink[y * sw + x]) pts.push(x - cx, y - cy);
    if (pts.length < 50) return 0;
    const rows = new Float64Array(sh * 2);
    const score = (deg) => {
      const a = (-deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
      rows.fill(0);
      for (let i = 0; i < pts.length; i += 2) {
        const ry = Math.round(sin * pts[i] + cos * pts[i + 1] + sh);   // y of the point after rotating by deg
        if (ry >= 0 && ry < rows.length) rows[ry]++;
      }
      let sum = 0;
      for (let i = 1; i < rows.length; i++) { const d = rows[i] - rows[i - 1]; sum += d * d; }
      return sum;
    };
    let best = 0, bestScore = -1;
    for (let d = -maxAngle; d <= maxAngle; d += 1) { const s = score(d); if (s > bestScore) { bestScore = s; best = d; } }
    const coarse = best;
    for (let d = coarse - 1; d <= coarse + 1.0001; d += 0.2) { const s = score(d); if (s > bestScore) { bestScore = s; best = d; } }
    return Math.round(best * 10) / 10;
  }

  /** Straighten a tilted label. Returns { gray, angle } (angle 0 = left as is). */
  function deskew(g, w, h) {
    const angle = detectSkew(g, w, h);
    if (Math.abs(angle) < 0.3) return { gray: g, angle: 0 };
    const edge = [];
    for (let x = 0; x < w; x += 7) edge.push(g[x], g[(h - 1) * w + x]);
    edge.sort((a, b) => a - b);
    return { gray: rotateGray(g, w, h, angle, edge[edge.length >> 1]), angle };
  }

  return { toGray, flatten, grayToRGBA, toPGM, boxBlur, readImageSize, readImageDpi, rotateGray, detectSkew, deskew };
});
