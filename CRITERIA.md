# Auto-Crop Acceptance Criteria

Check each scanned page against these rules. A page must meet **all PASS rules**
to count as correct.

## PASS rules

| # | Rule | How to check | Tolerance |
|---|------|--------------|-----------|
| 1 | **Nothing cut** | Every printed line, handwriting, stamp, logo, and signature visible in the photo also appears in the scan | Zero tolerance for content. Losing a sliver of *blank* paper margin is OK up to ~2% of the page size |
| 2 | **Tight crop** | Background (desk/floor) visible around the document edges | A thin border is by design (~0.5%); more than ~3% of the page width on any side is a fail |
| 3 | **Crops at the paper edge** | Each edge of the scan runs along the paper's physical edge — never along a printed table line, a form border box, a shadow line, or a desk edge | The edge line must sit on the paper/background boundary |
| 4 | **Occlusion handled** | If another object (paper, hand, cable) overlaps the document: the crop still follows the *document's* edges, extrapolated behind the occluder. A fragment of the occluder visible inside the scan is **correct** | Cropping along the occluder's edge (diagonal cut through the document) is a fail |
| 5 | **Deskewed** | Paper edges appear as the straight borders of the output; text rows look level | Residual tilt ≤ ~1°; fix by dragging the corners onto the paper edges |
| 6 | **Natural proportions** | The page doesn't look stretched or squashed compared to the real paper | Aspect ratio visually plausible |
| 7 | **No filters** | Colors, brightness, and shadows in the scan match the photo exactly (a gray photo gives a gray scan — that's correct) | Pixel colors must be untouched |

Rule 7 grades the **default** pipeline. With the optional **Natural flash**
setting on, brightness, contrast and edge sharpness are all expected to change,
and so is colour: the grade smooths the chroma channels and lifts saturation
5%, so it is a colour adjustment and not only a tonal one. What it does not do
is push paper to pure white or ink to pure black — it keeps the sheet's own
cast and some of its grain on purpose, so the scan still reads as a photograph.
Grade an enhanced scan against rules 1-6, and check rule 7 with the setting
off.

Rule 7 compares the scan against **the photo**, so **High detail capture** does
not affect it: its grain removal happens in the camera, before a photo exists,
and the scan still matches that photo exactly. Worth stating anyway — with High
detail on, which is the default, the app is filtering pixels at capture time.
A photo added from the library is never touched.

## Grading

- **PASS** — all 7 rules hold.
- **ACCEPTABLE** — rules 1, 3, 4, 7 hold; minor excess background or minor tilt
  (fixable with one drag or the slider).
- **FAIL** — any document content cut off, crop follows a wrong line (table,
  shadow, occluder, desk), or the wrong object is cropped.

## Known limitations (expected — do not count as regressions)

1. **Two stacked documents**: a small paper lying on top of a larger one may be
   cropped together with it. Fix manually with the corner handles.
2. **White paper on white background with a printed border box**: the crop may
   rest on the printed border, losing blank outer margin (content inside the
   box is never lost). Happens when there is no visible brightness step at the
   paper edge.
3. **Fully hidden edge**: if an occluder covers an entire edge of the document
   (no part of that edge visible), the edge position is a guess.
4. **Contiguous same-colour neighbour**: when another white paper touches the
   document edge with no visible seam (a folded page or hand-held slip against
   the top edge), the crop may run loose into the neighbour. Nothing is cut —
   the neighbour fragment sits inside the scan (acceptable per rule 4). The
   crop is tightened where any detection mask isolates the document from the
   neighbour, but a truly seamless join cannot be split safely.

## When a photo fails

Keep the original photo and note which edge failed and what the edge wrongly
followed (table line / shadow / other paper / background). Real failure photos
are the test set for fixing the detector — see `testdata/` workflow.

## Test set and ground truth

`testdata/` (kept out of git — the photos are real receipts) holds the scene
photos and `ground-truth.json`: for every scene the paper corners as % of the
image width/height (`tl, tr, br, bl`), `provisional` (true = the detector's own
crop checked by eye, false = marked by hand on a 10 % grid overlay), and
`scene`, every label that applies to what the photo shows:

| Label | What the photo shows |
|-------|----------------------|
| `plain` | one sheet on a desk, nothing on or under it |
| `pad` | the sheet on its own pad or carbon copies — paper of the same size beyond a seam |
| `stack` | a loose stack of sheets, edges staggered |
| `page` | the sheet on a larger printed page or sheet |
| `fold` | a leaf or corner folded over the sheet |
| `hand` | a hand or finger in the frame, on or beside the sheet |

Labels to add as the set grows, one column each: **paper** (white / thermal /
carbon-coloured / glossy), **background** (wood / white desk / dark / patterned),
**print** (form / dense text / blank / border box), **lighting** (even / shadow
across / lamp fall-off / flash / dark), **perspective** (flat / tilted / keystone).
Each photo wants four annotations: the paper corners, the scene labels, which
sides are occluded, and whether the crop shown by the app was PASS /
ACCEPTABLE / FAIL by the rules above.

Workflow (`detector-overlay.html`, console): `compareEngines()` grades every
scene against the truth — ZERO_CUT_RATE first, then side / corner error, excess
margin, IoU and the confidence calibration; `robustness()` runs the variant
suite; `priorCompare()` and `outlineJitter()` cover the camera path. To correct
a provisional entry: fix the crop in the app's editor, then `exportTruth(name)`
prints the entry to paste over it with `provisional: false`.

Scene hypotheses (pad / page / fold / hand / stack) were measured on
2026-09-15 as a label derived from the score's evidence — the share of a side's
samples read as skin, as a seam or as a printed line, the nested-edge share and
whether a side was refitted. No threshold on any of them separates the hand
labels: skin fires on wooden desks (0.5–0.8 on pads with no hand), a refit is
accepted on plain receipts as on folds, and the receipt-on-page scenes read as
plain because the crop sits on the page's edge. 12 of 36 right; the label was
not shipped. A hypothesis needs evidence the score does not yet read — a second
seam band below a side for a stack, a rule crossing the crop's edge for a page.
