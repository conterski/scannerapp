// ESLint for a build-free site: every file is a classic script sharing one
// global scope with its siblings. The globals each group may use are read
// from the code itself — the modules the page scripts publish on `window`,
// the declarations the worker scripts share — so a new module or worker
// function needs no edit here, and a misspelt one is still an error.
import js from "@eslint/js";
import globals from "globals";
import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const scriptsIn = (dir) => readdirSync(new URL(dir, import.meta.url)).filter((name) => name.endsWith(".js")).map((name) => dir + name);
const readonly = (names) => Object.fromEntries([...names].map((name) => [name, "readonly"]));
const writable = (names) => Object.fromEntries([...names].map((name) => [name, "writable"]));

const PAGE_SCRIPTS = [...scriptsIn("js/"), ...scriptsIn("dev/"), ...scriptsIn("tests/fixtures/")]
  .filter((path) => path !== "js/scan-worker.js");
const WORKER_SCRIPTS = ["js/scan-worker.js", ...scriptsIn("js/worker/")];

/** What the page scripts publish: `window.Name = …`. */
const pageModules = new Set(PAGE_SCRIPTS.flatMap((path) => [...read(path).matchAll(/^\s*window\.(\w+)\s*=/gm)].map((m) => m[1])));

/** What the worker scripts declare at top level, for each other: the
 *  `let`s writable, everything else not. */
const declaredIn = (pattern) => new Set(WORKER_SCRIPTS.flatMap((path) => [...read(path).matchAll(pattern)].map((m) => m[1])));
const workerDeclarations = declaredIn(/^(?:async\s+)?(?:function\*?|const)\s+([A-Za-z_$][\w$]*)/gm);
const workerVariables = declaredIn(/^(?:let|var)\s+([A-Za-z_$][\w$]*)/gm);
// Destructured top-level consts: `const SIDE_TOP = 0, SIDE_RIGHT = 1, …`.
for (const path of WORKER_SCRIPTS) {
  for (const [, list] of read(path).matchAll(/^const\s+([A-Z_][A-Z0-9_]*\s*=[^;]*?,\s*[A-Z_][^;]*);/gm)) {
    for (const [, name] of list.matchAll(/(?:^|,\s*)([A-Z_][A-Z0-9_]*)\s*=/g)) workerDeclarations.add(name);
  }
}

export default [
  { ignores: ["vendor/**", "node_modules/**", "test-results/**", "playwright-report/**", ".opencv-build/**"] },
  js.configs.recommended,
  {
    rules: {
      // A caught error is named even when unused: the name says what failed.
      "no-unused-vars": ["error", { caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
  {
    files: PAGE_SCRIPTS,
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...readonly(pageModules) },
    },
  },
  {
    files: WORKER_SCRIPTS,
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.worker, cv: "writable", ...readonly(workerDeclarations), ...writable(workerVariables) },
    },
    rules: {
      // Top-level declarations are the worker's shared API: used from the
      // other worker scripts, which a per-file rule cannot see.
      "no-unused-vars": ["error", { vars: "local", caughtErrors: "none", ignoreRestSiblings: true }],
      // Each script declares what the others see as a global: that is the
      // point, not a redeclaration — within a file the rule still holds.
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      // Specs hand functions to page.evaluate, which run with the page's globals.
      globals: { ...globals.node, ...globals.browser, ...readonly(pageModules) },
    },
  },
];
