/*
 * ocr-worker.js — thin wrapper around the Tesseract web worker.
 * The English model is published as "eng.traineddata.wasm" because some static hosts only
 * serve standard web file types; this redirects the engine's request to that name.
 */
const realFetch = self.fetch.bind(self);
self.fetch = (url, opts) => realFetch(String(url).replace(/\/eng\.traineddata$/, "/eng.traineddata.wasm"), opts);
importScripts("worker.min.js");
