/*
 * audit.js — tamper-evident audit log of every check, kept in this browser (IndexedDB).
 *
 * Each check gets a Verification ID = SHA-256(image hash | application-data hash | engine version),
 * so the same label checked with the same inputs and engine always gets the same ID.
 *
 * Log entries are append-only and hash-chained: every entry stores the hash of the previous
 * entry and its own SHA-256 over its full contents. Changing, deleting or reordering any entry
 * breaks the chain, which verifyChain() reports. (A hash chain proves the log wasn't edited;
 * proving *who* wrote it needs a server-held signing key — see SECURITY.md.)
 *
 * If IndexedDB is unavailable (private window, blocked storage) the log falls back to memory
 * for this session and says so.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LabelAudit = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  const DB_NAME = "label-verifier-audit";
  const GENESIS = "0".repeat(64);
  const enc = new TextEncoder();

  function subtle() {
    const c = (root && root.crypto) || (typeof crypto !== "undefined" ? crypto : null);
    if (!c || !c.subtle) throw new Error("Secure hashing is not available (the page must be served over HTTPS).");
    return c.subtle;
  }

  async function sha256Hex(data) {
    const bytes = typeof data === "string" ? enc.encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const buf = await subtle().digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** JSON with sorted keys, so the same data always hashes the same. */
  function canonical(value) {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    return "{" + Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }

  const APP_KEYS = ["beverageType", "brandName", "classType", "alcoholContent", "netContents", "bottler", "countryOfOrigin"];
  function applicationOnly(app) {
    const o = {};
    for (const k of APP_KEYS) o[k] = String((app && app[k]) || "").normalize("NFKC").trim();
    return o;
  }

  async function ids(imageBytesOrText, app, engineVersion) {
    const imageSha256 = await sha256Hex(imageBytesOrText);
    const inputSha256 = await sha256Hex(canonical(applicationOnly(app)));
    const verificationId = await sha256Hex(`${imageSha256}|${inputSha256}|${engineVersion}`);
    return { imageSha256, inputSha256, verificationId };
  }

  // ---------------- storage (IndexedDB, or memory) ----------------

  function memoryStore() {
    const log = [], batches = new Map();
    return {
      persistent: false,
      async last() { return log[log.length - 1] || null; },
      async add(e) { log.push(e); },
      async all() { return log.slice(); },
      async byId(id) { for (let i = log.length - 1; i >= 0; i--) if (log[i].verificationId === id) return log[i]; return null; },
      async putBatch(b) { batches.set(b.id, b); },
      async lastBatch() { let best = null; for (const b of batches.values()) if (!best || b.startedAt > best.startedAt) best = b; return best; },
    };
  }

  function idbStore() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        const log = db.createObjectStore("log", { keyPath: "seq" });
        log.createIndex("verificationId", "verificationId", { unique: false });
        db.createObjectStore("batches", { keyPath: "id" });
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const run = (store, mode, fn) => new Promise((res, rej) => {
          const tx = db.transaction(store, mode);
          let out;
          tx.oncomplete = () => res(out);
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error);
          out = fn(tx.objectStore(store), (v) => { out = v; });
        });
        const reqVal = (r, set) => { r.onsuccess = () => set(r.result); };
        resolve({
          persistent: true,
          last: () => run("log", "readonly", (s, set) => {
            const c = s.openCursor(null, "prev");
            c.onsuccess = () => set(c.result ? c.result.value : null);
          }),
          add: (e) => run("log", "readwrite", (s) => { s.add(e); }),   // add() refuses to overwrite: append-only
          all: () => run("log", "readonly", (s, set) => reqVal(s.getAll(), set)),
          byId: (id) => run("log", "readonly", (s, set) => {
            const c = s.index("verificationId").openCursor(IDBKeyRange.only(id), "prev");
            c.onsuccess = () => set(c.result ? c.result.value : null);
          }),
          putBatch: (b) => run("batches", "readwrite", (s) => { s.put(b); }),
          lastBatch: () => run("batches", "readonly", (s, set) => {
            const r = s.getAll();
            r.onsuccess = () => set(r.result.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] || null);
          }),
        });
      };
    });
  }

  let storePromise = null;
  function store() {
    if (!storePromise) {
      storePromise = (typeof indexedDB !== "undefined" ? idbStore() : Promise.reject(new Error("no indexedDB")))
        .catch(() => memoryStore());
    }
    return storePromise;
  }

  // Appends are serialized so concurrent batch lanes can't fork the chain.
  let queue = Promise.resolve();

  function entryBody(e) {
    const { entryHash, ...rest } = e;   // eslint-disable-line no-unused-vars
    return rest;
  }

  /** Record one check. Returns the stored entry (with seq and hashes). */
  function append(record) {
    const job = queue.then(async () => {
      const s = await store();
      const last = await s.last();
      const entry = {
        seq: last ? last.seq + 1 : 1,
        time: new Date().toISOString(),
        ...record,
        prevHash: last ? last.entryHash : GENESIS,
      };
      entry.entryHash = await sha256Hex(canonical(entryBody(entry)));
      await s.add(entry);
      return entry;
    });
    queue = job.catch(() => {});
    return job;
  }

  /** Re-hash every entry and check the links. */
  async function verifyChain() {
    const entries = (await (await store()).all()).sort((a, b) => a.seq - b.seq);
    let prev = GENESIS;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.seq !== i + 1) return { ok: false, count: entries.length, brokenAt: e.seq, reason: `Entry ${i + 1} is missing.` };
      if (e.prevHash !== prev) return { ok: false, count: entries.length, brokenAt: e.seq, reason: `Entry ${e.seq} does not link to entry ${e.seq - 1}.` };
      const h = await sha256Hex(canonical(entryBody(e)));
      if (h !== e.entryHash) return { ok: false, count: entries.length, brokenAt: e.seq, reason: `Entry ${e.seq} was changed after it was written.` };
      prev = e.entryHash;
    }
    return { ok: true, count: entries.length, head: prev };
  }

  async function list(limit = 200) {
    const all = await (await store()).all();
    return all.sort((a, b) => b.seq - a.seq).slice(0, limit);
  }

  async function findById(id) { return (await store()).byId(id); }
  async function persistent() { return (await store()).persistent; }
  async function saveBatch(b) { return (await store()).putBatch(b); }
  async function lastBatch() { return (await store()).lastBatch(); }

  /** Rows for CSV export (header first). */
  async function exportRows() {
    const all = (await (await store()).all()).sort((a, b) => a.seq - b.seq);
    const keys = ["brandName", "classType", "alcoholContent", "netContents", "bottler", "countryOfOrigin", "warning", "integrity"];
    const rows = [["seq", "time", "verification_id", "image_sha256", "input_sha256", "engine", "source", "file", "cached",
      "verdict", ...keys.map((k) => k + "_status"), ...APP_KEYS.map((k) => "app_" + k), "prev_hash", "entry_hash"]];
    for (const e of all) {
      const by = Object.fromEntries((e.fields || []).map((f) => [f.key, f.status]));
      rows.push([e.seq, e.time, e.verificationId, e.imageSha256, e.inputSha256, e.engine, e.source, e.file, e.cached ? "yes" : "no",
        e.verdict, ...keys.map((k) => by[k] || ""), ...APP_KEYS.map((k) => (e.application || {})[k] || ""), e.prevHash, e.entryHash]);
    }
    return rows;
  }

  /**
   * Compare a previously exported CSV (as rows of cells, header first) with the log.
   * Every cell of every row must equal what the log holds for that entry now.
   * Returns { checked, changed: [{ seq, columns }], unknown: [seq], ok }.
   */
  async function compareExport(rows) {
    if (!rows || rows.length < 2) return { ok: false, checked: 0, changed: [], unknown: [], reason: "The file has no audit rows." };
    const current = await exportRows();
    const head = current[0];
    const fileHead = rows[0].map((h) => h.trim());
    if (fileHead.join(",") !== head.join(",")) return { ok: false, checked: 0, changed: [], unknown: [], reason: "This is not an audit log export from this app (the columns are different)." };
    const bySeq = new Map(current.slice(1).map((r) => [String(r[0]), r]));
    const changed = [], unknown = [];
    for (const r of rows.slice(1)) {
      const mine = bySeq.get(String(r[0]).trim());
      if (!mine) { unknown.push(r[0]); continue; }
      const cols = head.filter((_, i) => String(mine[i] ?? "") !== String(r[i] ?? ""));
      if (cols.length) changed.push({ seq: r[0], columns: cols });
    }
    return { ok: !changed.length && !unknown.length, checked: rows.length - 1, changed, unknown };
  }

  /** Compact per-field record that goes into the log (the full result is kept for reuse). */
  function summarizeFields(result) {
    return result.fields.map((f) => ({ key: f.key, status: f.status, found: f.found || "", note: f.note || "",
      checks: f.checks ? f.checks.map((c) => ({ name: c.name, status: c.status })) : undefined }));
  }

  return { sha256Hex, canonical, ids, append, verifyChain, list, findById, persistent, saveBatch, lastBatch, exportRows, compareExport,
    summarizeFields, applicationOnly, GENESIS, _resetForTests() { storePromise = null; queue = Promise.resolve(); } };
});
