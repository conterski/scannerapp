// grade-testdata.mjs — the detector overlay's console workflow, headless, on
// the real scenes in testdata/ (kept out of git, so this runs where they are).
// It drives the overlay's own functions, so the numbers are the ones the
// console prints; the browser profile lives in testdata/.profile, so the
// overlay's stored baseline survives between runs the way it does in a
// desktop browser.
//
//   npm run grade:testdata                 compareEngines(): cuts, side error, IoU
//   npm run grade:testdata -- --store      storeBaseline(): before a change
//   npm run grade:testdata -- --compare    compareToBaseline(): after it
//   ... -- --engine legacy                 any of the above for another engine
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { startStaticServer } from "../tests/helpers/static-server.mjs";

const PORT = 8124;
const ROOT = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const engine = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : "refined";
const action = args.includes("--store") ? "storeBaseline" : args.includes("--compare") ? "compareToBaseline" : "compareEngines";

if (!existsSync(`${ROOT}testdata/ground-truth.json`)) {
  console.error("No testdata/ground-truth.json here — this needs the real scenes, which are not in git.");
  process.exit(1);
}

const server = await startStaticServer(ROOT, PORT);
const context = await chromium.launchPersistentContext(`${ROOT}testdata/.profile`, { headless: true });
try {
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/detector-overlay.html`);
  const result = await page.evaluate(([name, engineName]) => window[name](engineName), [action, engine]);
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
} finally {
  await context.close();
  server.close();
}
