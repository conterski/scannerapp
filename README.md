# ScannerApp

Turn photos of documents into clean scans, entirely in the browser — nothing is uploaded anywhere.

**Features**

- Add photos from the library or shoot with the camera (iPhone-friendly)
- Automatic document detection: the background is cropped away and the page is perspective-corrected (deskewed)
- **No filters** — pixel colors are never altered, only geometric transforms
- Manual adjustment: drag the four corners (with magnifier loupe), rotate in 90° steps, fine-straighten with a ±15° slider
- Reorder pages by dragging the ≡ grip or with the ◀ ▶ buttons
- Export:
  - **Download PDF** — all pages in order, one PDF
  - **Save to Photos** — on iPhone this opens the share sheet with the images in page order; tap **Save Images** to put them in the Photos app

**Tech**

Static site, no build step. OpenCV.js (vendored, ~11 MB, lazy-loaded in a Web Worker) does document detection ([jscanify](https://github.com/ColonelParrot/jscanify)) and the perspective warp; [jsPDF](https://github.com/parallax/jsPDF) assembles the PDF. Everything runs client-side.

**Run locally**

Serve the folder with any static server, e.g.:

```
npx http-server -p 8123 .
```

**iPhone use**

Open the deployed URL in Safari. For an app-like experience use Share → **Add to Home Screen**. "Save to Photos" requires HTTPS (the Web Share API needs a secure context).
