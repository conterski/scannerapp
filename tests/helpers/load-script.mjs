// load-script.mjs — runs the app's classic scripts in a fresh global scope,
// the way a page or a worker would, so their pure parts can be tested in
// Node without a browser. `window` and `self` both point at that scope:
// the app's modules export onto `window`, the worker's declare globals.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../../", import.meta.url);

/** @param paths    repository-relative scripts, loaded in order
 *  @param globals  anything else the scripts expect to find in scope
 *  @returns the scope; `scope.evaluate(expression)` reads a top-level
 *           const, which — unlike a function — is not a property of it */
export function loadScripts(paths, globals = {}) {
  const scope = vm.createContext({ console, ...globals });
  scope.window = scope;
  scope.self = scope;
  for (const path of paths) {
    vm.runInContext(readFileSync(new URL(path, ROOT), "utf8"), scope, { filename: path });
  }
  scope.evaluate = (expression) => vm.runInContext(expression, scope);
  return scope;
}
