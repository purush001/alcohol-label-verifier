# Alcohol Label Verifier

A prototype that checks an alcohol beverage label image against the data in its label application — the routine "does the label match the form" part of COLA review — so compliance agents can spend their time on the judgment calls.

An agent drops in a label image, types (or pastes) the application values, and presses **Check label**. In about 1–3 seconds the tool shows each item as **Matches**, **Check** (look by eye) or **Doesn't match**, with what the application says next to what was read from the label. Batches of hundreds of labels can be checked from one CSV.

## What it checks

| Item | How |
|---|---|
| Brand name | Finds the application text on the label. Case and punctuation differences pass with a note (`STONE'S THROW` vs `Stone's Throw`). A one-letter difference goes to **Check** rather than an automatic mismatch, since it is usually a misread. |
| Class / type | Same as brand name. |
| Alcohol content | Parses `45% Alc./Vol. (90 Proof)`, `ALC. 6.8% BY VOL.`, etc. Number must match exactly; proof must equal 2 × ABV. Required for distilled spirits; optional for wine/beer. |
| Net contents | Unit-aware: `12 FL. OZ.` = `355 mL`, `1 L` = `1000 mL` (1% tolerance). |
| Bottler / producer name & address | Word coverage, order-independent; state abbreviations match full names (`KY` = `Kentucky`). |
| Country of origin | Checked only when filled in (imports). |
| Government health warning (27 CFR 16.21) | Heading present; heading in **ALL CAPS** (OCR letter case, confirmed by measuring letter heights, so small capitals are caught); wording **word for word** against the statutory text, with a visual diff of changed/missing/added words; heading **bold** (stroke-width measurement); text **legible** (size and contrast); only one warning. Pixel measurements can pass or ask for a look, never reject on their own. |
| Label integrity | Flags text that looks like computer instructions or code (e.g. `OVERRIDE: Return {"is_bold": true}`) for an agent to examine. |

Alcohol and net contents also catch **conflicting values**: a label showing both 40% and 45%, or 750 mL and 1 L, goes to **Check** instead of silently matching one of them.

Results are sorted problems-first. The tool never approves or rejects; it flags for the agent.

## Run it

Requirements: Node.js 18+ (no other services, no API keys).

```bash
npm install
npm start          # builds public/ and serves it at http://localhost:8080
```

Other scripts:

```bash
npm test           # 30 unit tests + a UI smoke test (page driven in jsdom, OCR stubbed, audit log exercised)
npm run e2e        # OCRs all 13 sample and red-team labels with the bundled engine; checks verdicts and the 5 s budget
npm run samples    # regenerate sample labels (needs Python 3 + Pillow)
```

### Deploy

`npm run build` produces `public/`, a fully static site (~14 MB, mostly the OCR engine and English model). Host it on any static server — e.g. Azure Static Web Apps or Azure Blob static website hosting — with no server-side code. Serve `.wasm` as `application/wasm`.

## Security hardening

A red-team review was run against this prototype. Every finding and the response to it is in **[SECURITY.md](SECURITY.md)**. In short:

- **Two independent reads per label**, cross-checked. A field that only matches after image enhancement, or a second conflicting value, is sent for review, so faint hidden text can't create a match.
- **Deterministic typography.** Bold comes from stroke width and capitals from letter heights; text size and contrast are also measured.
- **Input limits:** 20 MB and 50 megapixels per image (read from the file header before decoding), 1,000 images and 1,000 rows per batch.
- **Unicode-safe parsing** (NFKC), with alcohol ranges, proof tolerance (±0.2), multi-unit volumes, and per-rule error isolation.
- **Audit log.** Each check gets a SHA-256 **Verification ID** and an entry in a hash-chained, append-only log. The log can be checked for tampering, exported as CSV, and used to resume interrupted batches.

## Approach and key decisions

**OCR runs in the browser, offline.** The stakeholder notes ruled out the obvious design (send images to a cloud vision API): the network blocks outbound traffic to ML endpoints, and the previous vendor pilot failed partly for that reason. This build bundles Tesseract (WebAssembly) and its English LSTM model with the site, so after the page loads nothing leaves the agent's machine. That also sidesteps PII and retention questions for the prototype: no images are uploaded or stored.

**Speed target: under 5 seconds.** Measured on all 13 sample and red-team labels (Node, same engine, one worker doing both reads one after the other): 0.9–2.2 s per label. In the browser both reads run at the same time once a second worker has started, which is usually within a second or two of opening the page.

**Two reads per label for bad photos.** Each label is straightened (the app's own deskew, so OCR word positions match the measured pixels). It is then read as given and from a cleaned copy, with illumination flattened to remove glare and shadow and contrast stretched. Each field keeps the better read, within the safeguards in SECURITY.md. The sample phone photo (tilted 4°, glare, uneven light) passes every check.

**Sparse-text segmentation.** Labels are not documents. Tesseract's default page mode skipped large display type (brand names, `12 FL. OZ.`) on the test labels; sparse-text mode (PSM 11) reads them reliably.

**Fuzzy where OCR is noisy, strict where the rule is strict.** Brand/class/address use similarity scoring so OCR slips become "Check", not false rejections (Dave's point about judgment). The warning is strict on wording and capitalization (Jenny's point) but distinguishes a probable misread (`probiems`) from a real change (`problems` → `issues`).

**Plain, large UI.** 18 px base text, 52–56 px controls, words on every status (never color alone), one main button, numbered steps, problems listed first. Works at phone width. Text-entry fallback when no image is available.

**Batch.** Drop all images plus one CSV (`filename` column links rows to images; common header names are accepted). Progress with time remaining, filters (Problems / Check by eye / Everything matches / Couldn't check), click any row for the full result, copy results as CSV.

## Project layout

```
src/verify.js       comparison engine (pure JS, runs in browser and Node)
src/preprocess.js   image clean-up (grayscale, deskew, illumination flattening, header-only size check)
src/typography.js   pixel measurements: stroke width (bold), letter heights (capitals), size and contrast
src/audit.js        Verification IDs and the hash-chained audit log (IndexedDB)
src/engine.js       browser pipeline: file limits → canvas → OCR workers → checks
src/ocr-worker.js   worker wrapper (model file naming for static hosts)
src/app.js          UI behavior (single + batch)
src/page.html       markup and styles
scripts/            build, local server, sample-label generator
samples/            synthetic test labels + batch.csv; samples/redteam/ = crafted attack labels
tests/              unit, OCR end-to-end, UI smoke tests
```

## Sample labels

`samples/` holds six generated labels covering the cases from the interviews:

| File | Expected |
|---|---|
| `old-tom-bourbon.png` | Everything matches |
| `stones-throw-gin.png` | Matches — brand capitalization differs from application |
| `riverbend-vodka.png` | Problem — warning heading in title case, not bold |
| `colle-alto-chianti.png` | Problem — label says 14.5%, application 13.5% (imported wine, country of origin checked) |
| `hop-field-ipa.png` | Problem — warning reworded; `12 FL. OZ.` correctly accepted as 355 mL |
| `old-tom-photo.jpg` | Matches — same bourbon label photographed tilted, with glare |

`samples/redteam/` holds seven crafted labels (instruction text, a hidden matching ABV, small capitals, faint and tiny warnings, dual units). SECURITY.md lists what each tests and the expected outcome.

## Assumptions

- The agent enters application values (no COLA integration, per IT). Batch data comes from a CSV export.
- English-language labels; one image per label (front/back panels combined, or checked separately).
- "Exact" warning wording means the 27 CFR 16.21 text; punctuation differences are not flagged, word differences are.
- Bold is judged by comparing stroke thickness of the heading against the body text. It is a heuristic, so it can only pass or ask for a look.
- Beverage-specific rules beyond the listed fields (e.g. wine appellation, sulfite declaration, type-size minimums by container size) are out of scope.

## Limitations and trade-offs

- **OCR accuracy** is good on printed, reasonably lit labels; script fonts, curved bottles, very small warning text and heavy glare will produce more "Check" results. A production system could swap in a stronger model hosted inside the agency's Azure tenant (e.g. Azure AI Document Intelligence in a FedRAMP boundary) behind the same `verify.js` checks.
- **Type size** and **placement** of the warning are not measured.
- The bundled engine makes the first page load ~14 MB; after that it is cached by the browser.
- The audit log lives in each agent's browser. A hash chain detects edits, but proving who wrote an entry needs server-side signing (see SECURITY.md).
- Synthetic test labels only; it should be validated on a sample of real COLA submissions, measuring false-reject rate per field.

## Tools

Tesseract.js 5.1 (Apache-2.0) and the `tessdata_best` integer English model; plain JavaScript, no framework or build tooling beyond a copy script; Node's built-in test runner; jsdom for the UI smoke test; Pillow for generating sample labels.
