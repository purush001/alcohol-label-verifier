/*
 * typography.js — deterministic pixel measurements of the warning heading.
 * Nothing here trusts the text reader's opinion of the font; it looks at the ink itself.
 *
 *   estimateBoldness  stroke-width ratio, heading vs. warning text (simplified stroke-width transform)
 *   caseShape         are the heading letters all the same height (true capitals)?
 *   legibility        warning text size relative to the image, and ink/paper contrast
 *
 * gray: Uint8Array (0..255) row-major, width: image width, boxes: [{x0,y0,x1,y1}]
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LabelType = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const median = (arr) => {
    const a = arr.filter((v) => v !== null && isFinite(v)).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };

  /** Crop a box to an ink mask (1 = ink). Returns null for boxes too small or too flat to judge. */
  function inkMask(gray, width, box) {
    const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
    const x1 = Math.floor(box.x1), y1 = Math.floor(box.y1);
    const w = x1 - x0, h = y1 - y0;
    if (w < 6 || h < 6 || w * h > 400000) return null;
    let min = 255, max = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const v = gray[y * width + x]; if (v < min) min = v; if (v > max) max = v;
    }
    if (max - min < 40) return null;
    const thr = (min + max) / 2;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = gray[(y0 + y) * width + x0 + x] < thr ? 1 : 0;
    return { mask, w, h };
  }

  /**
   * Stroke width of a word relative to its height. For every ink pixel take the shorter of
   * its horizontal and vertical ink run (a cheap stroke-width transform), then the median.
   */
  function strokeRatio(gray, width, box) {
    const m = inkMask(gray, width, box);
    if (!m) return null;
    const { mask, w, h } = m;
    const hr = new Uint16Array(w * h), vr = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!mask[y * w + x]) { x++; continue; }
        let e = x; while (e < w && mask[y * w + e]) e++;
        for (let k = x; k < e; k++) hr[y * w + k] = e - x;
        x = e;
      }
    }
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!mask[y * w + x]) { y++; continue; }
        let e = y; while (e < h && mask[e * w + x]) e++;
        for (let k = y; k < e; k++) vr[k * w + x] = e - y;
        y = e;
      }
    }
    const widths = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) widths.push(Math.min(hr[i], vr[i]));
    if (widths.length < 20) return null;
    widths.sort((a, b) => a - b);
    // mean of the middle half: steadier than a plain median on small integer widths
    const q1 = Math.floor(widths.length / 4), q3 = Math.ceil((widths.length * 3) / 4);
    let sum = 0; for (let i = q1; i < q3; i++) sum += widths[i];
    return sum / (q3 - q1) / h;
  }

  /** ~1.0 = heading and text have the same weight; > 1.18 = heading is bold. */
  function estimateBoldness(gray, width, headingBoxes, bodyBoxes) {
    const head = median(headingBoxes.map((b) => strokeRatio(gray, width, b)));
    const body = median(bodyBoxes.slice(0, 30).map((b) => strokeRatio(gray, width, b)));
    if (head === null || body === null) return { ratio: NaN };
    return { ratio: head / body, head, body };
  }

  /**
   * Letter heights inside the heading words. In "GOVERNMENT WARNING" every letter is
   * cap height; in "Government Warning" or small capitals most letters are shorter.
   * Returns { shortFrac } = share of letters noticeably shorter than the tallest ones.
   */
  function caseShape(gray, width, headingBoxes) {
    const heights = [];
    for (const box of headingBoxes) {
      const m = inkMask(gray, width, box);
      if (!m) continue;
      const { mask, w, h } = m;
      const seen = new Uint8Array(w * h);
      const stack = [];
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || seen[i]) continue;
        let top = h, bottom = -1, area = 0;
        stack.push(i); seen[i] = 1;
        while (stack.length) {
          const p = stack.pop();
          const y = (p / w) | 0, x = p - y * w;
          area++; if (y < top) top = y; if (y > bottom) bottom = y;
          if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
          if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
          if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
          if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
        }
        const ch = bottom - top + 1;
        if (ch >= h * 0.35 && area >= 6) heights.push(ch);   // skip colons, dots, specks
      }
    }
    if (heights.length < 4) return { shortFrac: NaN, letters: heights.length };
    heights.sort((a, b) => a - b);
    const tall = heights[Math.floor(heights.length * 0.9)];
    const short = heights.filter((v) => v < tall * 0.82).length;
    return { shortFrac: short / heights.length, letters: heights.length };
  }

  /** Warning text height relative to the image, and ink-vs-paper contrast (0..255). */
  function legibility(gray, width, height, boxes) {
    const hs = [], cs = [];
    for (const b of boxes.slice(0, 30)) {
      const x0 = Math.max(0, b.x0 | 0), y0 = Math.max(0, b.y0 | 0), x1 = Math.min(width, b.x1 | 0), y1 = Math.min(height, b.y1 | 0);
      if (x1 - x0 < 3 || y1 - y0 < 3) continue;
      hs.push(y1 - y0);
      const vals = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(gray[y * width + x]);
      vals.sort((a, c) => a - c);
      cs.push(vals[Math.floor(vals.length * 0.9)] - vals[Math.floor(vals.length * 0.1)]);
    }
    const mh = median(hs), mc = median(cs);
    if (mh === null || mc === null) return { heightRatio: NaN, contrast: NaN };
    return { heightRatio: mh / Math.max(width, height), contrast: mc, textHeightPx: mh };
  }

  return { strokeRatio, estimateBoldness, caseShape, legibility };
});
