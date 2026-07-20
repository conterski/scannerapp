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

## When a photo fails

Keep the original photo and note which edge failed and what the edge wrongly
followed (table line / shadow / other paper / background). Real failure photos
are the test set for fixing the detector — see `testdata/` workflow.
