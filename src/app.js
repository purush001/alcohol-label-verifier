/* app.js — page behavior: single-label review and batch review. */
(function () {
  "use strict";
  const V = window.LabelVerify, E = window.LabelEngine, A = window.LabelAudit;
  const BATCH_LIMITS = { maxImages: 1000, maxCsvBytes: 5 * 1024 * 1024, maxRows: 1000 };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const STATUS_WORD = { pass: "Matches", review: "Check", fail: "Doesn't match", skip: "Not checked",
    queued: "Waiting", working: "Reading…", error: "Error" };
  const FIELDS = ["brandName", "classType", "alcoholContent", "netContents", "bottler", "countryOfOrigin"];
  const SAMPLE_NAMES = {
    "old-tom-bourbon.png": "Bourbon (clean)",
    "old-tom-photo.jpg": "Bourbon (phone photo)",
    "stones-throw-gin.png": "Gin (case differs)",
    "riverbend-vodka.png": "Vodka (warning)",
    "colle-alto-chianti.png": "Imported wine",
    "hop-field-ipa.png": "Beer (fl oz)",
  };

  let sampleRows = [];
  let current = { src: null, name: "" };
  let previewUrl = null;

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (_) {}
      ta.remove();
      toast(ok ? "Copied" : "Copy is blocked here. Select the text and copy it by hand.");
    }
  }

  // ---------------- engine status ----------------
  function setEngine(state, text) {
    $("engine").dataset.state = state;
    $("engineText").textContent = text;
  }
  function startEngine() {
    return E.init((s) => {
      if (s === "ready") setEngine("ready", "Ready — results in about 1–3 seconds");
      else setEngine("loading", s);
    }).catch((e) => {
      setEngine("error", "Reading engine unavailable — use “type the label text” instead");
      console.error(e);
      throw e;
    });
  }

  // ---------------- tabs ----------------
  function selectTab(name) {
    for (const t of ["single", "batch", "audit"]) {
      $("tab-" + t).setAttribute("aria-selected", String(t === name));
      $("view-" + t).hidden = t !== name;
    }
  }
  $("tab-single").onclick = () => selectTab("single");
  $("tab-batch").onclick = () => selectTab("batch");

  // ---------------- single: image input ----------------
  function showImage(src, name) {
    current = { src, name };
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = typeof src === "string" ? null : URL.createObjectURL(src);
    $("preview").src = previewUrl || src;
    $("preview").hidden = false;
    $("dropEmpty").hidden = true;
    $("filemeta").hidden = false;
    $("fileName").textContent = name;
  }
  function wireDrop(zone, input, onFiles) {
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove("over")));
    zone.addEventListener("drop", (e) => { e.preventDefault(); onFiles([...e.dataTransfer.files]); });
    input.addEventListener("change", () => { onFiles([...input.files]); input.value = ""; });
  }
  wireDrop($("drop"), $("file"), (files) => {
    const f = files.find((x) => /^image\//.test(x.type) || /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(x.name));
    if (!f) { toast("That file isn't an image. Use a JPG or PNG."); return; }
    markSample(null);
    showImage(f, f.name);
  });
  $("changeFile").onclick = () => $("file").click();
  document.addEventListener("paste", (e) => {
    if ($("view-single").hidden) return;
    if (e.target && /textarea|input/i.test(e.target.tagName)) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) { markSample(null); showImage(item.getAsFile(), "Pasted image"); }
  });

  // ---------------- single: form ----------------
  function readForm() {
    const app = { beverageType: document.querySelector("input[name=beverageType]:checked").value };
    FIELDS.forEach((k) => (app[k] = $(k).value.trim()));
    return app;
  }
  function fillForm(app) {
    const bt = app.beverageType || "spirits";
    $("bt-" + bt).checked = true;
    FIELDS.forEach((k) => ($(k).value = app[k] || ""));
  }
  $("clearBtn").onclick = () => {
    fillForm({});
    $("labelText").value = "";
    $("preview").hidden = true; $("dropEmpty").hidden = false; $("filemeta").hidden = true;
    current = { src: null, name: "" };
    markSample(null);
    renderIdle();
  };

  // ---------------- samples ----------------
  function markSample(file) {
    document.querySelectorAll("#samples .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.file === file)));
  }
  function loadSample(row, run) {
    fillForm(row);
    $("labelText").value = "";
    $("textMode").open = false;
    showImage("samples/" + row.filename, row.filename + " (sample)");
    markSample(row.filename);
    if (run) runSingle();
  }
  async function loadSamples() {
    try {
      const txt = await (await fetch("samples/batch.csv")).text();
      sampleRows = V.parseCSV(txt);
    } catch (e) { sampleRows = []; }
    const box = $("samples");
    for (const r of sampleRows) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.dataset.file = r.filename;
      b.textContent = SAMPLE_NAMES[r.filename] || r.filename;
      b.onclick = () => loadSample(r, true);
      box.appendChild(b);
    }
    if (!sampleRows.length) box.hidden = true;
  }

  // ---------------- audit log ----------------
  /** Keep what's needed to show the result again later (no image, no second OCR text). */
  function storableResult(r) {
    const { ocrText2, audit, ...rest } = r;   // eslint-disable-line no-unused-vars
    return JSON.parse(JSON.stringify(rest));
  }
  /** Hash inputs, append to the tamper-evident log, attach { verificationId, seq } to the result. */
  async function record(result, { data, app, file, source, cached = false, ids = null }) {
    try {
      const h = ids || (await A.ids(data, app, E.ENGINE_VERSION));
      const entry = await A.append({
        ...h, engine: E.ENGINE_VERSION, source, file: file || "", cached,
        application: A.applicationOnly(app), verdict: result.verdict,
        fields: A.summarizeFields(result), measurements: result.measurements || null,
        result: storableResult(result),
      });
      result.audit = { verificationId: h.verificationId, seq: entry.seq, entryHash: entry.entryHash };
    } catch (e) {
      console.warn("audit log", e);
      result.audit = { error: e.message || "The audit log is not available in this browser." };
    }
    return result;
  }
  function auditHTML(r) {
    if (!r.audit) return "";
    if (r.audit.error) return `<span class="time">Not recorded in the audit log: ${esc(r.audit.error)}</span>`;
    const id = r.audit.verificationId;
    return `<span class="time idline">Verification ID <code class="inline" title="${esc(id)}">${esc(id.slice(0, 16))}…</code>
      · audit entry #${r.audit.seq}${r.cached ? " · result reused (same image and inputs)" : ""}
      <button class="linkbtn" type="button" data-copy-id="${esc(id)}">Copy ID</button></span>`;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-copy-id]");
    if (b) copy(b.dataset.copyId);
  });

  // ---------------- single: results ----------------
  function renderIdle() {
    $("verdict").dataset.v = "idle";
    $("verdict").innerHTML = "<h2>No label checked yet</h2><p>Add a label image and the application details, then press <b>Check label</b>.</p>";
    $("resultBody").innerHTML = "";
  }
  function verdictHTML(r) {
    const n = r.counts;
    const secs = (r.ms / 1000).toFixed(1);
    const how = r.fromText ? "from typed text" : `in ${secs} seconds`;
    const tail = `<span class="time">Checked ${how}</span>${auditHTML(r)}`;
    if (r.verdict === "pass") return `<h2>Everything matches</h2><p>All required items on the label agree with the application.</p>${tail}`;
    if (r.verdict === "review") return `<h2>Check ${n.review} item${n.review > 1 ? "s" : ""} by eye</h2><p>Nothing clearly wrong, but the tool is not sure about ${n.review === 1 ? "one item" : "these items"}.</p>${tail}`;
    return `<h2>${n.fail} problem${n.fail > 1 ? "s" : ""} found</h2><p>${n.fail > 1 ? "These items do" : "This item does"} not match the application or the rules.${n.review ? ` ${n.review} more to check by eye.` : ""}</p>${tail}`;
  }

  function diffHTML(diff) {
    if (!diff || !diff.some((d) => d.op !== "same" && d.op !== "near")) return "";
    const parts = diff.map((d) => {
      if (d.op === "same" || d.op === "near") return esc(d.want.toLowerCase());
      if (d.op === "missing") return `<del title="Required, not on label">${esc(d.want.toLowerCase())}</del>`;
      if (d.op === "extra") return `<ins title="On label, not in the required text">${esc(d.got.toLowerCase())}</ins>`;
      return `<del title="Required">${esc(d.want.toLowerCase())}</del> <ins title="On label">${esc(d.got.toLowerCase())}</ins>`;
    });
    return `<div class="diff"><div>GOVERNMENT WARNING: ${parts.join(" ")}</div>
      <div class="key"><span><del>struck</del> required, not on label</span><span><ins>highlighted</ins> on label instead</span></div></div>`;
  }

  function fieldHTML(f) {
    const label = f.key === "warning" ? "Required statement" : "Application";
    const exp = f.key === "warning" ? "GOVERNMENT WARNING: (1) According to the Surgeon General…" : f.expected;
    let html = `<div class="row"><span class="pill ${f.status}">${STATUS_WORD[f.status]}</span><div>
      <h3>${esc(f.label)}</h3>
      <dl class="pair"><dt>${label}</dt><dd>${esc(exp) || "—"}</dd><dt>On label</dt><dd>${esc(f.found) || "—"}</dd></dl>`;
    if (f.checks) {
      html += `<ul class="subchecks">${f.checks.map((c) => `<li><span class="pill ${c.status}">${STATUS_WORD[c.status]}</span><span><b>${esc(c.name)}.</b> ${esc(c.note)}</span></li>`).join("")}</ul>`;
      html += diffHTML(f.diff);
      html += `<p class="cite">Required wording and format: 27 CFR 16.21–16.22.</p>`;
    } else {
      html += `<p class="note">${esc(f.note)}${f.fromCleanup ? " <span class=\"cite\">(read from the cleaned-up image)</span>" : ""}</p>`;
    }
    return html + `</div></div>`;
  }

  function resultHTML(r) {
    let html = "";
    if (r.lowQuality) html += `<div class="banner">Very little text could be read from this image. It may be blurry, too dark, or not a label. Results below are unreliable — ask for a clearer image if needed.</div>`;
    // Problems first, then checks, then matches
    const order = { fail: 0, review: 1, pass: 2, skip: 3 };
    const sorted = r.fields.slice().sort((a, b) => order[a.status] - order[b.status]);
    html += `<div class="rows">${sorted.map(fieldHTML).join("")}</div>`;
    html += `<details class="more"><summary>Show all text the tool read from the label</summary><pre class="ocr">${esc(r.ocrText || "(nothing read)")}</pre></details>`;
    return html;
  }

  function renderResult(r) {
    $("verdict").dataset.v = r.verdict;
    $("verdict").innerHTML = verdictHTML(r);
    $("resultBody").innerHTML = resultHTML(r);
  }

  function renderBusy(stage) {
    $("verdict").dataset.v = "idle";
    $("verdict").innerHTML = `<h2 style="display:flex;align-items:center;gap:12px"><span class="spinner" aria-hidden="true"></span>${esc(stage)}…</h2><p>This usually takes 1–3 seconds.</p>`;
  }

  function renderError(msg) {
    $("verdict").dataset.v = "fail";
    $("verdict").innerHTML = `<h2>Could not check this label</h2><p>${esc(msg)}</p>`;
    $("resultBody").innerHTML = "";
  }

  let running = false;
  async function runSingle() {
    if (running) return;
    const app = readForm();
    const typed = $("labelText").value.trim();
    const useText = $("textMode").open && typed;
    if (!useText && !current.src) { renderError("Add a label image first (or open “type or paste the label text”)."); return; }
    const missing = ["brandName", "alcoholContent", "netContents"].filter((k) => !app[k] && !(k === "alcoholContent" && app.beverageType !== "spirits"));
    if (missing.length) {
      const names = { brandName: "brand name", alcoholContent: "alcohol content", netContents: "net contents" };
      renderError("Fill in the " + missing.map((k) => names[k]).join(", ") + " from the application.");
      $(missing[0]).focus();
      return;
    }
    running = true;
    $("checkBtn").disabled = true;
    try {
      if (useText) {
        const r = E.checkText(typed, app);
        renderResult(await record(r, { data: "text:" + typed, app, file: "(typed text)", source: "text" }));
        return;
      }
      renderBusy("Preparing image");
      const prepared = await E.readBytes(current.src);       // size and format limits, before decoding
      const r = await E.checkLabel(null, app, { onStage: renderBusy, prepared });
      renderResult(await record(r, { data: prepared.bytes, app, file: current.name, source: "image" }));
    } catch (e) {
      console.error(e);
      renderError(e instanceof E.InputError ? e.message
        : "The reading engine could not start in this browser. Open “type or paste the label text” to check from text instead.");
    } finally {
      running = false;
      $("checkBtn").disabled = false;
    }
  }
  $("appForm").addEventListener("submit", (e) => { e.preventDefault(); runSingle(); });

  // ---------------- batch ----------------
  const TEMPLATE_HEADER = "filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,bottler,country_of_origin";
  const TEMPLATE = TEMPLATE_HEADER + "\n" +
    'old-tom-bourbon.png,Distilled spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol. (90 Proof),750 mL,"Old Tom Distillery, Bardstown, Kentucky",\n' +
    'colle-alto-chianti.png,Wine,COLLE ALTO,Chianti Classico Red Wine,13.5% Alc./Vol.,750 mL,"Harbor Light Imports, Baltimore, Maryland",Italy';
  $("template").textContent = TEMPLATE;
  $("copyTemplate").onclick = () => copy(TEMPLATE);

  const batch = { images: new Map(), rows: [], items: [], filter: "all", stop: false, running: false, selected: null };
  const keyOf = (name) => String(name).split(/[\\/]/).pop().trim().toLowerCase();

  async function addBatchFiles(files) {
    let skipped = 0;
    for (const f of files) {
      if (/\.csv$/i.test(f.name) || f.type === "text/csv") {
        if (f.size > BATCH_LIMITS.maxCsvBytes) { toast("That spreadsheet is over 5 MB. Split it into smaller batches."); continue; }
        const rows = V.parseCSV(await f.text());
        if (rows.length > BATCH_LIMITS.maxRows) { toast(`That spreadsheet has ${rows.length} rows. The limit is ${BATCH_LIMITS.maxRows} per batch — split it.`); continue; }
        batch.rows = rows;
        batch.csvName = f.name;
      } else if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(f.name)) {
        if (batch.images.size >= BATCH_LIMITS.maxImages && !batch.images.has(keyOf(f.name))) { skipped++; continue; }
        batch.images.set(keyOf(f.name), { file: f, name: f.name });
      }
    }
    if (skipped) toast(`${skipped} image${skipped > 1 ? "s were" : " was"} not added: the limit is ${BATCH_LIMITS.maxImages} per batch.`);
    updateBatchStatus();
  }
  function updateBatchStatus() {
    const imgs = batch.images.size, rows = batch.rows.length;
    const matched = batch.rows.filter((r) => batch.images.has(keyOf(r.filename || ""))).length;
    let msg = `${imgs} image${imgs === 1 ? "" : "s"} added. `;
    msg += rows ? `Spreadsheet: ${rows} row${rows === 1 ? "" : "s"}${batch.csvName ? " from " + batch.csvName : ""}, ${matched} matched to an image.` : "No spreadsheet yet — add the CSV with the application data.";
    $("bstatus").textContent = msg;
    $("bstart").disabled = !(imgs && rows) || batch.running;
  }
  wireDrop($("bdrop"), $("bfiles"), addBatchFiles);
  $("bclear").onclick = () => {
    if (batch.running) batch.stop = true;
    batch.images.clear(); batch.rows = []; batch.items = []; batch.csvName = ""; batch.selected = null;
    $("bresults").hidden = true; updateBatchStatus();
  };
  $("bsample").onclick = async () => {
    $("bsample").disabled = true;
    try {
      const csv = await (await fetch("samples/batch.csv")).text();
      batch.rows = V.parseCSV(csv); batch.csvName = "sample batch.csv";
      for (const r of batch.rows) {
        const blob = await (await fetch("samples/" + r.filename)).blob();
        batch.images.set(keyOf(r.filename), { file: blob, name: r.filename });
      }
      updateBatchStatus();
      startBatch();
    } catch (e) { toast("Could not load the sample batch."); }
    finally { $("bsample").disabled = false; }
  };

  function buildItems() {
    const items = [];
    const seen = new Set();
    for (const r of batch.rows) {
      const k = keyOf(r.filename || "");
      const img = batch.images.get(k);
      seen.add(k);
      items.push(img ? { name: img.name, file: img.file, app: r, state: "queued" }
        : { name: r.filename || "(no filename)", app: r, state: "error", error: "Image not added. Check the file name in the spreadsheet." });
    }
    for (const [k, img] of batch.images) if (!seen.has(k)) items.push({ name: img.name, file: img.file, app: null, state: "error", error: "No row for this file in the spreadsheet." });
    return items;
  }

  function issuesText(it) {
    if (it.state === "error") return it.error;
    if (!it.result) return "";
    const bad = it.result.fields.filter((f) => f.status === "fail" || f.status === "review");
    if (!bad.length) return "—";
    return bad.map((f) => {
      if (f.key === "warning") {
        const c = f.checks.find((c) => c.status === f.status);
        return `Warning: ${c ? c.name.replace(/^“GOVERNMENT WARNING:” /, "").toLowerCase() : "check"}`;
      }
      return f.label;
    }).join("; ");
  }

  function renderBatch() {
    const items = batch.items;
    const done = items.filter((i) => i.state === "done" || i.state === "error").length;
    const counts = { pass: 0, review: 0, fail: 0, error: 0 };
    items.forEach((i) => { if (i.state === "done") counts[i.result.verdict]++; else if (i.state === "error") counts.error++; });
    $("bbar").style.width = items.length ? (100 * done) / items.length + "%" : "0";
    if (batch.running) {
      const avg = batch.timeSpent / Math.max(1, batch.finished);
      const left = items.length - done;
      const eta = batch.finished ? Math.ceil((left * avg) / Math.max(1, batch.concurrency) / 1000) : null;
      $("bprog").textContent = `Checked ${done} of ${items.length}` + (eta !== null ? ` · about ${eta < 90 ? eta + " seconds" : Math.ceil(eta / 60) + " minutes"} left` : "");
    } else {
      const secs = batch.elapsed ? (batch.elapsed / 1000).toFixed(1) : "0";
      const reused = items.filter((i) => i.result && i.result.cached).length;
      $("bprog").textContent = (batch.stop ? `Stopped after ${done} of ${items.length}.` : `Finished ${items.length} label${items.length === 1 ? "" : "s"} in ${secs} seconds.`)
        + (reused ? ` ${reused} result${reused > 1 ? "s" : ""} reused from the audit log (same image and data).` : "");
    }
    const filters = [["all", "All", items.length], ["fail", "Problems", counts.fail], ["review", "Check by eye", counts.review], ["pass", "Everything matches", counts.pass], ["error", "Couldn't check", counts.error]];
    $("bsummary").innerHTML = filters.filter(([k, , n]) => k === "all" || n).map(([k, label, n]) =>
      `<button class="filter" type="button" data-f="${k}" aria-pressed="${batch.filter === k}"><b>${n}</b> ${label}</button>`).join("");
    $("bsummary").querySelectorAll(".filter").forEach((b) => (b.onclick = () => { batch.filter = b.dataset.f; renderBatch(); }));
    const order = { fail: 0, review: 1, error: 2, pass: 3 };
    const rank = (i) => i.state === "done" ? order[i.result.verdict] : i.state === "error" ? 2 : 4;
    const visible = items.map((it, idx) => ({ it, idx }))
      .filter(({ it }) => batch.filter === "all" || (batch.filter === "error" ? it.state === "error" : it.state === "done" && it.result.verdict === batch.filter))
      .sort((a, b) => batch.running ? a.idx - b.idx : rank(a.it) - rank(b.it) || a.idx - b.idx);
    $("btable").innerHTML = visible.map(({ it, idx }) => {
      const st = it.state === "done" ? it.result.verdict : it.state;
      const word = it.state === "done" ? { pass: "Matches", review: "Check", fail: "Problems" }[st] : STATUS_WORD[st];
      return `<tr class="${batch.selected === idx ? "sel" : ""}"><td class="file">${esc(it.name)}</td><td>${esc(it.app?.brandName || "—")}</td>
        <td><span class="pill ${st}">${word}</span></td><td>${esc(issuesText(it))}</td>
        <td>${it.state === "done" ? `<button class="linkbtn" type="button" data-i="${idx}">View</button>` : ""}</td></tr>`;
    }).join("");
    $("btable").querySelectorAll("button[data-i]").forEach((b) => (b.onclick = () => showDetail(+b.dataset.i)));
  }

  let detailUrl = null;
  function showDetail(idx) {
    batch.selected = idx;
    const it = batch.items[idx];
    if (detailUrl) URL.revokeObjectURL(detailUrl);
    detailUrl = it.file ? URL.createObjectURL(it.file) : null;
    const pic = detailUrl ? `<img src="${detailUrl}" alt="Label ${esc(it.name)}">` : `<p class="hint">Image not loaded (result restored from the audit log).</p>`;
    $("bdetail").innerHTML = `<div class="detail" style="margin-top:8px"><div><h3 style="margin-bottom:8px;font-size:1.05rem">${esc(it.name)}</h3>${pic}</div>
      <div style="display:grid;gap:14px"><div class="verdict" data-v="${it.result.verdict}">${verdictHTML(it.result)}</div>${resultHTML(it.result)}</div></div>`;
    renderBatch();
    $("bdetail").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  async function startBatch() {
    if (batch.running) return;
    try { await startEngine(); } catch (e) { toast("The reading engine could not start in this browser."); return; }
    batch.items = buildItems();
    batch.session = { id: "batch-" + Date.now(), startedAt: new Date().toISOString(), csvName: batch.csvName || "", finished: false };
    $("bresume").hidden = true;
    batch.running = true; batch.stop = false; batch.filter = "all"; batch.selected = null;
    batch.timeSpent = 0; batch.finished = 0;
    $("bdetail").innerHTML = "";
    $("bresults").hidden = false; $("bstop").hidden = false; $("bstart").disabled = true;
    const t0 = performance.now();
    const queue = batch.items.filter((i) => i.state === "queued");
    renderBatch();
    $("bresults").scrollIntoView({ block: "start" });
    const worker = async () => {
      while (queue.length && !batch.stop) {
        const it = queue.shift();
        it.state = "working"; renderBatch();
        try {
          const prepared = await E.readBytes(it.file);
          let ids = null, previous = null;
          try { ids = await A.ids(prepared.bytes, it.app, E.ENGINE_VERSION); previous = await A.findById(ids.verificationId); } catch (_) {}
          if (previous && previous.result) {
            // Same image, same application data, same engine: reuse the recorded result (resumes interrupted batches)
            it.result = { ...previous.result, cached: true, ms: 0 };
          } else {
            it.result = await E.checkLabel(null, it.app, { parallel: false, prepared });
            batch.timeSpent += it.result.ms; batch.finished++;
          }
          await record(it.result, { data: prepared.bytes, ids, app: it.app, file: it.name, source: "batch", cached: !!it.result.cached });
          it.state = "done";
        } catch (e) { it.state = "error"; it.error = e instanceof E.InputError ? e.message : "Could not read this image."; }
        saveBatchState();
        renderBatch();
      }
    };
    // Concurrency follows the number of reading workers that have started
    const lanes = [];
    batch.concurrency = Math.max(1, E.workers);
    for (let i = 0; i < batch.concurrency; i++) lanes.push(worker());
    const grow = setInterval(() => {
      if (E.workers > batch.concurrency && queue.length) { batch.concurrency++; lanes.push(worker()); }
    }, 500);
    while (lanes.length) { const l = lanes.slice(); await Promise.all(l); lanes.splice(0, l.length); }
    clearInterval(grow);
    batch.items.forEach((i) => { if (i.state === "queued" || i.state === "working") { i.state = "error"; i.error = "Not checked (stopped)."; } });
    batch.elapsed = performance.now() - t0;
    batch.session.finished = !batch.stop;
    saveBatchState();
    batch.running = false; $("bstop").hidden = true; updateBatchStatus();
    renderBatch();
  }
  $("bstart").onclick = startBatch;
  $("bstop").onclick = () => { batch.stop = true; };
  $("bcopy").onclick = () => {
    const head = ["filename", "result", ...["brandName", "classType", "alcoholContent", "netContents", "bottler", "countryOfOrigin", "warning"].map((k) => k), "notes"];
    const rows = [head];
    for (const it of batch.items) {
      if (it.state !== "done") { rows.push([it.name, "not checked", "", "", "", "", "", "", "", it.error || ""]); continue; }
      const by = Object.fromEntries(it.result.fields.map((f) => [f.key, f]));
      const word = { pass: "matches", review: "check", fail: "problems" }[it.result.verdict];
      rows.push([it.name, word, ...["brandName", "classType", "alcoholContent", "netContents", "bottler", "countryOfOrigin", "warning"].map((k) => STATUS_WORD[by[k].status]),
        it.result.fields.filter((f) => f.status === "fail" || f.status === "review").map((f) => `${f.label}: ${f.note}`).join(" | ")]);
    }
    copy(V.toCSV(rows));
  };

  // ---------------- batch recovery ----------------
  let saveTimer = null;
  function saveBatchState() {
    if (!batch.session) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const items = batch.items.map((i) => ({ name: i.name, state: i.state, verdict: i.result ? i.result.verdict : null,
        verificationId: i.result && i.result.audit ? i.result.audit.verificationId : null, error: i.error || null }));
      const done = items.filter((i) => i.state === "done" || i.state === "error").length;
      A.saveBatch({ ...batch.session, total: items.length, done, items }).catch(() => {});
    }, 150);
  }
  async function offerResume() {
    let last = null;
    try { last = await A.lastBatch(); } catch (_) { return; }
    if (!last || last.finished || last.done >= last.total) return;
    const when = new Date(last.startedAt).toLocaleString();
    $("bresume").hidden = false;
    $("bresume").innerHTML = `<b>A batch was interrupted.</b> ${last.done} of ${last.total} labels were checked (started ${esc(when)}${last.csvName ? ", " + esc(last.csvName) : ""}).
      Add the same images and spreadsheet again and press <b>Check all labels</b>: labels already checked are taken from the audit log instead of being read again.
      <button class="linkbtn" type="button" id="bshowprev">Show the results checked so far</button>`;
    $("bshowprev").onclick = async () => {
      const items = [];
      for (const it of last.items) {
        let entry = null;
        if (it.verificationId) { try { entry = await A.findById(it.verificationId); } catch (_) {} }
        items.push(entry && entry.result ? { name: it.name, app: entry.application, file: null, state: "done", result: { ...entry.result, cached: true, audit: { verificationId: entry.verificationId, seq: entry.seq } } }
          : { name: it.name, app: null, state: "error", error: it.state === "error" ? it.error : "Not checked yet." });
      }
      batch.items = items; batch.running = false; batch.stop = true; batch.filter = "all";
      $("bresults").hidden = false; renderBatch();
    };
  }

  // ---------------- audit log view ----------------
  async function renderAudit() {
    let persistent = false, entries = [];
    try { persistent = await A.persistent(); entries = await A.list(200); }
    catch (e) { $("astatus").textContent = "The audit log is not available: " + e.message; return; }
    $("astatus").innerHTML = (persistent
      ? "Stored in this browser and kept between visits."
      : "<b>Kept for this session only</b> — this browser is blocking storage (private window?). Copy the log before closing the page.")
      + ` ${entries.length ? `Showing the latest ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.` : "No checks recorded yet."}`;
    const word = { pass: "Matches", review: "Check", fail: "Problems" };
    $("atable").innerHTML = entries.map((e) => `<tr><td class="num">${e.seq}</td><td>${esc(new Date(e.time).toLocaleString())}</td>
      <td class="file">${esc(e.file || "")}${e.cached ? " <span class=\"cite\">(reused)</span>" : ""}</td>
      <td><span class="pill ${e.verdict}">${word[e.verdict] || esc(e.verdict)}</span></td>
      <td><code class="inline" title="${esc(e.verificationId)}">${esc(String(e.verificationId).slice(0, 12))}…</code></td>
      <td><code class="inline" title="${esc(e.entryHash)}">${esc(String(e.entryHash).slice(0, 12))}…</code></td></tr>`).join("");
  }
  $("tab-audit").onclick = () => { selectTab("audit"); renderAudit(); };
  $("averify").onclick = async () => {
    $("aresult").hidden = false;
    $("aresult").className = "banner";
    $("aresult").textContent = "Checking every entry…";
    try {
      const r = await A.verifyChain();
      $("aresult").className = r.ok ? "banner ok" : "banner error";
      $("aresult").textContent = r.ok
        ? `All ${r.count} entries are intact. Latest chain hash: ${r.count ? r.head.slice(0, 16) + "…" : "—"}`
        : `The log has been altered: ${r.reason} Entries from #${r.brokenAt} on cannot be trusted.`;
    } catch (e) { $("aresult").className = "banner error"; $("aresult").textContent = "Could not check the log: " + e.message; }
  };
  $("acopy").onclick = async () => {
    try { copy(V.toCSV(await A.exportRows())); } catch (e) { toast("Could not read the audit log."); }
  };

  // ---------------- start ----------------
  (async () => {
    offerResume();
    await loadSamples();
    const first = sampleRows[0];
    if (first) loadSample(first, false);
    try {
      await startEngine();
      if (first && current.src === "samples/" + first.filename) runSingle();
    } catch (e) {
      $("textMode").open = true;
    }
  })();
})();
