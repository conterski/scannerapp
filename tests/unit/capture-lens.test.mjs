// The lens and zoom the capture screen is on (CaptureLens): which camera
// each step means, which of a phone's cameras is which lens, and the view a
// zoom keeps — pure decisions, driven with the camera names iOS gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "../helpers/load-script.mjs";

const scope = loadScripts(["js/persisted-flag.js", "js/capture-lens.js"], {
  localStorage: { getItem: () => null, setItem: () => {} },
});
const { CaptureLens } = scope;

const camera = (label, deviceId = label) => ({ kind: "videoinput", label, deviceId });
// What an iPhone with three rear lenses lists once the camera is allowed.
const TRIPLE_LENS_PHONE = [
  camera("Front Camera"), camera("Back Triple Camera"), camera("Back Dual Wide Camera"),
  camera("Back Ultra Wide Camera"), camera("Back Camera"), camera("Back Telephoto Camera"),
];
const ONE_LENS_PHONE = [camera("Front Camera"), camera("Back Camera")];

test("0.5× is the ultra-wide lens and every other step the main one", () => {
  assert.deepEqual([...CaptureLens.STEPS], [0.5, 1, 2, 3]);
  assert.equal(CaptureLens.lensFor(0.5), "ultra-wide");
  for (const step of [1, 2, 3]) assert.equal(CaptureLens.lensFor(step), "main");
});

test("each lens is its own full view, and 2× and 3× crop the main lens in", () => {
  assert.deepEqual([0.5, 1, 2, 3].map((step) => CaptureLens.zoomFor(step, false)), [1, 1, 2, 3]);
  assert.deepEqual({ ...CaptureLens.viewFor(1) }, { x: 0, y: 0, width: 1, height: 1 });
  const twice = CaptureLens.viewFor(2);
  assert.deepEqual({ ...twice }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.ok(Math.abs(CaptureLens.viewFor(3).width - 1 / 3) < 1e-9);
});

test("macro is the ultra-wide cropped to its middle half, which looks like the main lens's 1×", () => {
  assert.equal(CaptureLens.MACRO_CROP, 2);
  // Whatever step is set, macro's crop is the same one.
  for (const step of [0.5, 1, 2, 3]) assert.equal(CaptureLens.zoomFor(step, true), 2);
  assert.deepEqual({ ...CaptureLens.viewFor(CaptureLens.MACRO_CROP) }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
});

test("macro puts the camera on the ultra-wide whatever the step, and off it again on the step's own lens", () => {
  CaptureLens.setStep(2);
  assert.equal(CaptureLens.currentLens(), "main");
  assert.equal(CaptureLens.zoom(), 2);
  CaptureLens.setMacro(true);
  assert.equal(CaptureLens.currentLens(), "ultra-wide");
  assert.equal(CaptureLens.zoom(), 2); // the crop macro makes: the middle half
  CaptureLens.setMacro(false);
  assert.equal(CaptureLens.currentLens(), "main");
  CaptureLens.setStep(0.5);
  assert.equal(CaptureLens.currentLens(), "ultra-wide");
  assert.equal(CaptureLens.zoom(), 1); // 0.5× is the whole ultra-wide view
  CaptureLens.setStep(1);
});

test("the step starts at 1× and only a real step is kept", () => {
  assert.equal(CaptureLens.step(), 1);
  CaptureLens.setStep(2);
  assert.equal(CaptureLens.step(), 2);
  CaptureLens.setStep(7);
  assert.equal(CaptureLens.step(), 2);
  CaptureLens.setStep(1);
});

test("each lens is found by name among a phone's cameras", () => {
  assert.equal(CaptureLens.pickDevice(TRIPLE_LENS_PHONE, "ultra-wide"), "Back Ultra Wide Camera");
  // The fused cameras and the telephoto are not the main lens, whatever their order.
  assert.equal(CaptureLens.pickDevice(TRIPLE_LENS_PHONE, "main"), "Back Camera");
  assert.equal(CaptureLens.pickDevice([...TRIPLE_LENS_PHONE].reverse(), "main"), "Back Camera");
});

test("a lens the phone does not show is null, and a one-lens phone has no ultra-wide", () => {
  assert.equal(CaptureLens.pickDevice(ONE_LENS_PHONE, "ultra-wide"), null);
  assert.equal(CaptureLens.pickDevice(ONE_LENS_PHONE, "main"), "Back Camera");
  assert.equal(CaptureLens.pickDevice([camera("Back Triple Camera"), camera("Back Dual Camera")], "main"), null);
  assert.equal(CaptureLens.pickDevice([], "ultra-wide"), null);
  // Android's own names are not guessed at: the browser's pick stands.
  assert.equal(CaptureLens.pickDevice([camera("camera2 0, facing back"), camera("camera2 2, facing back")], "main"), null);
});

test("a front camera is never a lens, whatever it is called", () => {
  assert.equal(CaptureLens.pickDevice([camera("Front Ultra Wide Camera")], "ultra-wide"), null);
});

test("the zoomed view keeps exactly the part of the letterboxed frame it shows", () => {
  // A 3:4 frame on a 390×844 screen is shown 390 wide and 520 tall.
  const clip = CaptureLens.clipFor({ width: 390, height: 844 }, { width: 3024, height: 4032 }, 2);
  assert.ok(Math.abs(clip.left - 97.5) < 1e-9 && Math.abs(clip.right - 97.5) < 1e-9);
  assert.ok(Math.abs(clip.top - 292) < 1e-9 && Math.abs(clip.bottom - 292) < 1e-9);
  // Magnified 2× about the centre, the clipped box is the whole letterboxed frame again.
  assert.ok(Math.abs((390 - clip.left - clip.right) * 2 - 390) < 1e-9);
  assert.ok(Math.abs((844 - clip.top - clip.bottom) * 2 - 520) < 1e-9);
});
