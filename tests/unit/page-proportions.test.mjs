// PageProportions: the page's true width over height from its corners'
// perspective, and the paper size it snaps to. Poses come from the synthetic
// scenes' own camera model, so the test and the generator agree on what a
// photographed sheet looks like.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "../helpers/load-script.mjs";

const page = loadScripts([
  "js/image-utils.js", "dev/quad-tools.js", "tests/fixtures/synthetic-scenes.js", "js/page-proportions.js",
]);
const { PageProportions, SyntheticScenes } = page;
const FRAME = { width: 1500, height: 2000 };
const A4 = 1 / Math.SQRT2;

// Poses a phone takes: flat, tipped towards the page (one pair of sides
// parallel — the case the focal length cannot be read from), turned, and
// tipped both ways; through a lens of the assumed focal length and others.
const POSES = [
  { roll: 4 },
  { pitch: 30 },
  { pitch: -35, roll: 3 },
  { yaw: 30 },
  { pitch: 25, yaw: 15, roll: -6 },
  { pitch: -20, yaw: -25, roll: 10 },
  { pitch: 30, yaw: 20, focal: 1.1 },
  { pitch: 35, yaw: -20, roll: 5, focal: 0.7 },
];

const relativeError = (value, truth) => Math.abs(value / truth - 1);
const averagedAspect = ({ tl, tr, br, bl }) => {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(tl, tr) + d(bl, br)) / (d(tl, bl) + d(tr, br));
};

for (const paper of ["a4", "letter", "receipt"]) {
  test(`aspectOf recovers a ${paper} sheet's proportions in every pose, within 1.5%`, () => {
    const truth = SyntheticScenes.PAPER_ASPECTS[paper];
    for (const pose of POSES) {
      const corners = SyntheticScenes.projectSheet({ paper, fill: 0.4, ...pose }, FRAME);
      const aspect = PageProportions.aspectOf(corners, FRAME);
      assert.ok(relativeError(aspect, truth) < 0.015,
        `${JSON.stringify(pose)}: ${aspect.toFixed(4)} against ${truth.toFixed(4)}`);
    }
  });
}

test("aspectOf beats averaging opposite sides wherever there is perspective", () => {
  for (const pose of POSES.slice(1)) {
    const corners = SyntheticScenes.projectSheet({ paper: "a4", fill: 0.4, ...pose }, FRAME);
    assert.ok(relativeError(PageProportions.aspectOf(corners, FRAME), A4) < relativeError(averagedAspect(corners), A4),
      JSON.stringify(pose));
  }
});

test("aspectOf follows the labels round: a quarter turn swaps width and height", () => {
  const { tl, tr, br, bl } = SyntheticScenes.projectSheet({ paper: "a4", fill: 0.4, pitch: 25, yaw: 15 }, FRAME);
  const upright = PageProportions.aspectOf({ tl, tr, br, bl }, FRAME);
  const turned = PageProportions.aspectOf({ tl: bl, tr: tl, br: tr, bl: br }, FRAME);
  const upsideDown = PageProportions.aspectOf({ tl: br, tr: bl, br: tl, bl: tr }, FRAME);
  assert.ok(relativeError(turned, 1 / upright) < 1e-9);
  assert.ok(relativeError(upsideDown, upright) < 1e-9);
});

test("aspectOf of a rectangle seen square-on is its side ratio", () => {
  const corners = { tl: { x: 100, y: 200 }, tr: { x: 700, y: 200 }, br: { x: 700, y: 1100 }, bl: { x: 100, y: 1100 } };
  assert.ok(relativeError(PageProportions.aspectOf(corners, FRAME), 600 / 900) < 1e-12);
});

test("aspectOf gives up on a quad that is no page seen from the front", () => {
  const bowTie = { tl: { x: 100, y: 100 }, tr: { x: 900, y: 900 }, br: { x: 900, y: 100 }, bl: { x: 100, y: 900 } };
  assert.equal(PageProportions.aspectOf(bowTie, FRAME), null);
});

test("snapToPaper takes a page within 2% to the paper, and leaves others alone", () => {
  assert.equal(PageProportions.snapToPaper(0.70), A4);
  assert.equal(PageProportions.snapToPaper(1.40), Math.SQRT2); // A4 on its side
  assert.equal(PageProportions.snapToPaper(0.78), 8.5 / 11);
  assert.equal(PageProportions.snapToPaper(0.74), 0.74); // between A4 and Letter: neither
  assert.equal(PageProportions.snapToPaper(0.38), 0.38); // a receipt
});

test("paperFor names a scan's paper and its size in points, either way up", () => {
  assert.deepEqual({ ...PageProportions.paperFor(2015, 2850).points }, { width: 595.28, height: 841.89 });
  assert.equal(PageProportions.paperFor(2850, 2015).name, "A4");
  assert.equal(PageProportions.paperFor(2850, 2015).points.width, 841.89);
  assert.equal(PageProportions.paperFor(1700, 2200).name, "Letter");
  assert.equal(PageProportions.paperFor(1000, 1000), null);
});
