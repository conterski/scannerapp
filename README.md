# ScannerApp

Turn photos of documents into clean scans, entirely in the browser — nothing is uploaded anywhere.

**Features**

- **A 4:3 camera frame, shown whole** — the in-page camera asks for the
  sensor's own 4:3 shape rather than a 16:9 crop of it, and the viewfinder
  shows the whole frame (letterboxed), so what you frame is exactly what is
  kept. A page is about 1.41:1, so filling a 4:3 frame gives it about 58%
  more pixels than filling a 16:9 one; a phone that offers 4:3 only at a
  small size is switched to its larger 16:9 frame instead.
- **High detail capture** (on by default) — the in-page camera keeps more of
  what the sensor delivers: 2850px frames instead of 2050px (~6.1 MP against
  ~3.2 MP), scaled down from the native frame with an area resample, a 60fps
  request so a frame is exposed for as short a time as the phone allows and a
  handheld shot doesn't smear, and each tap keeping the sharpest of seven
  frames, with the lens aimed at the document where the camera allows it. The
  capture screen shows the frame the camera actually delivers (size and frame
  rate), since a phone may answer the request with less. Photos run roughly
  twice the size of the setting off; turn it off to keep files smaller. It
  applies to new photos only, since resolution is fixed the moment a shot is
  taken.
- **Advice over the viewfinder** — one line when something stands between the
  frame and a good scan: the page running off the edge, too small, glare,
  too dark (pointing at the light when the phone has one), a steep angle, or
  a moving phone. It appears only once it has held for a moment, so it never
  flickers.
- **AUTO** (on the camera screen, off by default) — takes the shot by itself
  once the page has held steady in the outline for under a second with
  nothing wrong, then waits for the next page: lay pages down or turn them,
  and keep your hands off the phone. It never takes the same page twice, and
  the shutter still works as usual. A ring round the shutter shows it
  getting ready.
- **True proportions** — the scan takes the page's real shape from the
  perspective of its corners, rather than averaging opposite sides (which
  kept some of the squash of a page shot at an angle); a page within 2% of
  A4, Letter or Legal comes out exactly that shape, and its PDF page is that
  paper size.
- **Works offline** — once the deployed app has been opened, it opens, scans
  and exports with no network at all, and asks the browser to keep the
  scans even when space runs short.
- **Settings** — the ⚙ button in the header holds the toggles below (High
  detail capture, Compact scans, page numbers, and the message box); ☑ selects
  pages and the bins clear the tab or every tab.
- **Page numbers** (off by default) — a small translucent number in the bottom
  right of each exported scan. It is added as the document is exported, not
  baked into the saved scan, so reordering or deleting a page always renumbers
  the rest and nothing is re-rendered.
- **Tabs** — small numbered tabs above the pages, each its own set of scans
  with its own export; **+** opens the next. Keep batches of receipts apart
  without exporting and clearing in between. An emptied tab disappears when
  you leave it; the tab you were on is remembered.
- Add photos from the library, or use the in-page camera for rapid capture: one tap per shot with no Retake/Use Photo confirmation, a running counter, a tappable strip that opens a review gallery (delete shots there), and a single **Done** that hands the whole set to the app
- **⟳ on the camera screen** — if you shoot with the phone held sideways while
  rotation lock is on, the phone hands the page a portrait frame with the
  document on its side and cannot say so. Tap ⟳ until the arrow points the way
  you are holding it and shots are saved upright from then on; the setting is
  remembered, and any page can still be turned in the editor.
- Automatic document detection: the background is cropped away and the page is perspective-corrected (deskewed)
- **No filters, anywhere** — a photo is resampled and JPEG-encoded, never
  filtered, and scanning applies geometric transforms only, never a colour
  change.
- **Choose where new photos go** — after picking from the library or finishing a
  capture session, a dialog asks whether they belong at the end (the default),
  at the beginning, or after a particular page. Re-shooting page 4 no longer
  means adding it at the end and walking it back.
- Manual adjustment: drag the four corners (with magnifier loupe), rotate in 90° steps
- Reorder pages by dragging the ≡ grip or with the ◀ ▶ buttons
- Long lists: ↑ / ↓ buttons jump to either end, and opening a page for editing
  puts you back at the same scroll position when you close it
- Export:
  - **Download PDF** — all pages in order, one PDF
  - **Save to Photos** — on iPhone this opens the share sheet with the images in page order; tap **Save Images** to put them in the Photos app
  - **A message after the scans** — a text box above the pages, starting
    as a payment request dated today. While it has text, **Image** or
    **PDF** takes two taps: the first shares the scans — pick the WhatsApp
    chat, send, come back — and the second sends the message, so it lands
    under them. One share per tap is the platform's rule: a share sheet
    needs its own gesture, and text sent together with files is dropped or
    captioned by the receiving app. Each tab keeps its own text; an emptied
    tab starts fresh. The **Message after the scans** setting hides the box
    and makes the export a single tap again.

**Tech**

Static site, no build step. OpenCV.js does document detection — a ~3 MB WebAssembly build of just the functions the app calls (`scripts/build-opencv.sh`), with SIMD where the browser has it, lazy-loaded in two Web Workers — the paper's outermost boundary is segmented (OTSU / Canny candidates) and a quadrilateral is fitted to its convex hull — plus the perspective warp; [jsPDF](https://github.com/parallax/jsPDF) assembles the PDF. Everything runs client-side.

**Run locally**

Serve the folder with any static server, e.g.:

```
npx http-server -p 8123 .
```

The offline copy is only installed on a deployed site, so a local copy always
serves the files as they are.

**Development**

The app needs no build; the checks do:

```
npm install
npm run lint        # ESLint, globals read from the code itself
npm test            # unit tests of the pure modules (node --test)
npm run test:e2e    # Playwright: the detector on synthetic scenes against its
                    # baseline, the camera on a simulated one, export, offline
npm run bench       # engine start, detection and batch timings
```

`tests/fixtures/synthetic-scenes.js` draws document photos with exactly known
corners, so the detector is graded without any real photo in git;
`UPDATE_BASELINE=1 npx playwright test detector` re-records its baseline after a
deliberate change. With the real scenes in `testdata/`, `npm run grade:testdata`
runs the overlay's `compareEngines()` headless (`-- --store` and `-- --compare`
for its before-and-after). `scripts/build-opencv.sh` rebuilds the OpenCV the
worker loads — only the functions in `scripts/opencv_js.config.py`, so a new
`cv.*` call goes there first.

**iPhone use**

Open the deployed URL in Safari. For an app-like experience use Share → **Add to Home Screen** — which also keeps the scans from Safari's seven-day clearing of website data. The in-page camera needs HTTPS and camera permission; if either is missing the Camera button falls back to the system camera picker. "Save to Photos" requires HTTPS (the Web Share API needs a secure context).
