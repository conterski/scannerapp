# ScannerApp

Turn photos of documents into clean scans, entirely in the browser — nothing is uploaded anywhere.

**Features**

- **High detail capture** (on by default) — the in-page camera keeps more of
  what the sensor delivers: 2850px frames instead of 2050px (~4.6 MP against
  ~2.4 MP), scaled down from the native frame with an area resample, a 60fps
  stream so no frame is exposed for longer than 1/60s and a handheld shot
  doesn't smear, and each tap keeping the sharpest of seven frames, with the
  lens aimed at the document where the camera allows it. The capture screen shows
  the frame the camera actually delivers (size and frame rate), since a phone
  may answer the request with less. Photos run roughly
  twice the size of the setting off; turn it off to keep files smaller. It
  applies to new photos only, since resolution is fixed the moment a shot is
  taken.
- **Tabs** — small numbered tabs above the pages, each its own set of scans
  with its own export; **+** opens the next. Keep batches of receipts apart
  without exporting and clearing in between. An emptied tab disappears when
  you leave it; the tab you were on is remembered.
- Add photos from the library, or use the in-page camera for rapid capture: one tap per shot with no Retake/Use Photo confirmation, a running counter, a tappable strip that opens a review gallery (delete shots there), and a single **Done** that hands the whole set to the app
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

Static site, no build step. OpenCV.js (vendored, ~11 MB, lazy-loaded in a Web Worker) does document detection — the paper's outermost boundary is segmented (OTSU / Canny candidates) and a quadrilateral is fitted to its convex hull — plus the perspective warp; [jsPDF](https://github.com/parallax/jsPDF) assembles the PDF. Everything runs client-side.

**Run locally**

Serve the folder with any static server, e.g.:

```
npx http-server -p 8123 .
```

**iPhone use**

Open the deployed URL in Safari. For an app-like experience use Share → **Add to Home Screen**. The in-page camera needs HTTPS and camera permission; if either is missing the Camera button falls back to the system camera picker. "Save to Photos" requires HTTPS (the Web Share API needs a secure context).
