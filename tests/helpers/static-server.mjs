// static-server.mjs — serves a directory the way GitHub Pages serves the app:
// plain files, the query string ignored, and the MIME types the browser
// insists on (application/wasm is what lets WebAssembly.compileStreaming
// accept a response). No dependencies, so the tests need nothing but
// Playwright.
//
//   node tests/helpers/static-server.mjs [root] [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function startStaticServer(root, port) {
  const base = resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, "http://localhost");
      let path = normalize(join(base, decodeURIComponent(pathname)));
      if (!path.startsWith(base)) throw Object.assign(new Error("outside root"), { code: "ENOENT" });
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      const body = await readFile(path);
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" || error.code === "EISDIR" ? 404 : 500);
      response.end();
    }
  });
  return new Promise((resolveListening) => server.listen(port, () => resolveListening(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root = ".", port = "8123"] = process.argv.slice(2);
  await startStaticServer(root, Number(port));
  console.log(`Serving ${resolve(root)} on http://localhost:${port}`);
}
