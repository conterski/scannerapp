// The capture screen's advice (CaptureGuidance) and its auto shutter
// (AutoShutter): pure decisions over what the live outline reads, driven
// here with made-up readings and made-up time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "../helpers/load-script.mjs";

const scope = loadScripts(["js/image-utils.js", "js/persisted-flag.js", "js/capture-guidance.js", "js/auto-shutter.js"]);
const { CaptureGuidance, AutoShutter } = scope;

const FRAME = { width: 3024, height: 4032 };
const LIT = { mean: 180, clipped: 0 };
/** A reading of a page covering the box [x0,x1] x [y0,y1] of the frame. */
function view({ x0 = 0.15, x1 = 0.85, y0 = 0.15, y1 = 0.85, stability = 1, light = LIT } = {}) {
  return { quad: { tl: { x: x0, y: y0 }, tr: { x: x1, y: y0 }, br: { x: x1, y: y1 }, bl: { x: x0, y: y1 } }, stability, light, frame: FRAME };
}
const NO_TORCH = { available: false, on: false };
const idOf = (reading, torch = NO_TORCH) => { const hint = CaptureGuidance.hintFor(reading, torch); return hint && hint.id; };

test("a well-framed, steady, well-lit page needs no advice", () => {
  assert.equal(idOf(view()), null);
  assert.equal(idOf(null), null);
});

test("each problem gets its own advice, the most damaging first", () => {
  assert.equal(idOf(view({ x0: 0.002 })), "edge");
  assert.equal(idOf(view({ x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.6 })), "small");
  assert.equal(idOf(view({ light: { mean: 200, clipped: 0.05 } })), "glare");
  assert.equal(idOf(view({ light: { mean: 40, clipped: 0 } })), "dark");
  assert.equal(idOf(view({ light: { mean: 40, clipped: 0 } }), { available: true, on: false }), "darkWithTorch");
  assert.equal(idOf(view({ light: { mean: 40, clipped: 0 } }), { available: true, on: true }), "dark");
  assert.equal(idOf(view({ stability: 0.2 })), "unsteady");
  // Cut off and glaring: the cut is what is said.
  assert.equal(idOf(view({ x0: 0.002, light: { mean: 200, clipped: 0.05 } })), "edge");
});

test("a steep angle — one side far shorter than its opposite — asks for the phone to be held flat", () => {
  const steep = view();
  steep.quad.tl.x = 0.35; steep.quad.tr.x = 0.65; // the top 0.3 wide, the bottom 0.7
  assert.equal(idOf(steep), "keystone");
});

test("only advice about a shot not worth taking holds the auto shutter back", () => {
  const blocks = (reading) => CaptureGuidance.hintFor(reading, NO_TORCH).blocksAuto;
  assert.equal(blocks(view({ x0: 0.002 })), true);
  assert.equal(blocks(view({ light: { mean: 200, clipped: 0.05 } })), true);
  assert.equal(blocks(view({ stability: 0.2 })), false);
});

test("the presenter shows a hint only once it has held, and never a flicker", () => {
  const shown = [];
  const presenter = CaptureGuidance.createPresenter((hint) => shown.push(hint && hint.id));
  const glare = CaptureGuidance.hintFor(view({ light: { mean: 200, clipped: 0.05 } }), NO_TORCH);
  presenter.update(glare, 0);
  presenter.update(null, 200); // a frame without it: the candidate starts over
  presenter.update(glare, 300);
  presenter.update(glare, 600);
  assert.deepEqual(shown, []);
  presenter.update(glare, 700);
  assert.deepEqual(shown, ["glare"]);
  presenter.update(glare, 900); // already showing: nothing more
  presenter.clear();
  assert.deepEqual(shown, ["glare", null]);
});

function shutter() {
  const events = { fired: 0, states: [] };
  const machine = AutoShutter.create({ onFire: () => { events.fired++; }, onChange: (state) => events.states.push(state) });
  return { machine, events };
}

test("the auto shutter fires once a ready page has held for its hold time, and only once", () => {
  const { machine, events } = shutter();
  const page = view();
  machine.update(page, null, 0);
  machine.update(page, null, AutoShutter.HOLD_MS - 1);
  assert.equal(events.fired, 0);
  machine.update(page, null, AutoShutter.HOLD_MS);
  assert.equal(events.fired, 1);
  for (let t = 1000; t < 5000; t += 120) machine.update(page, null, t); // the page stays put
  assert.equal(events.fired, 1);
  assert.deepEqual(events.states, ["steadying", "waiting"]);
});

test("the auto shutter re-arms when the page goes or moves, and fires for the next", () => {
  const { machine, events } = shutter();
  machine.update(view(), null, 0);
  machine.update(view(), null, 800);
  machine.update(null, null, 1000); // the page is taken away…
  machine.update(null, null, 1700); // …and stays away
  machine.update(view(), null, 1800); // the next is laid down
  machine.update(view(), null, 2600);
  assert.equal(events.fired, 2);
  machine.update(view({ x0: 0.02, x1: 0.72 }), null, 2800); // moved by 0.13 of the width
  machine.update(view({ x0: 0.02, x1: 0.72 }), null, 3600);
  assert.equal(events.fired, 3);
});

test("a moment without the outline is not the page gone: it is not taken again", () => {
  const { machine, events } = shutter();
  machine.update(view(), null, 0);
  machine.update(view(), null, 800);
  machine.update(null, null, 1000); // a focus sweep, a shadow: the outline drops out…
  machine.update(null, null, 1300);
  for (let t = 1400; t < 4000; t += 120) machine.update(view(), null, t); // …and the same page is back
  assert.equal(events.fired, 1);
});

test("standing down drops a hold, but not the memory of the last shot", () => {
  const { machine, events } = shutter();
  machine.update(view(), null, 0); // holding
  machine.standDown();
  assert.deepEqual(events.states, ["steadying", "searching"]);
  machine.update(view(), null, 100);
  machine.update(view(), null, 900); // shot
  machine.standDown(); // the gallery opened, or the switch was touched
  for (let t = 1000; t < 4000; t += 120) machine.update(view(), null, t);
  assert.equal(events.fired, 1);
});

test("the auto shutter holds back for an unsteady outline or a blocking hint, and restarts its count", () => {
  const { machine, events } = shutter();
  const edge = CaptureGuidance.hintFor(view({ x0: 0.002 }), NO_TORCH);
  machine.update(view(), null, 0);
  machine.update(view({ stability: 0.5 }), null, 500); // a wobble: the hold starts over
  machine.update(view(), null, 600);
  machine.update(view(), null, 1300);
  assert.equal(events.fired, 0);
  machine.update(view(), null, 1400);
  assert.equal(events.fired, 1);
  const { machine: second, events: secondEvents } = shutter();
  second.update(view(), edge, 0);
  second.update(view(), edge, 2000);
  assert.equal(secondEvents.fired, 0);
});

test("a tap on the real shutter counts: the auto shutter will not take the same page again", () => {
  const { machine, events } = shutter();
  machine.noteShot(view());
  for (let t = 0; t < 3000; t += 120) machine.update(view(), null, t);
  assert.equal(events.fired, 0);
});
