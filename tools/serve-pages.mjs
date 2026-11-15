// Serves dist/ the way GitHub Pages does for a project site: under /<repo>/, with Pages' MIME
// types, a 404 for anything else, and no SPA fallback. Used by the end-to-end test.
//   node tools/serve-pages.mjs [port] [base]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = +(process.argv[2] ?? 4180);
const base = process.argv[3] ?? '/grave-shift/';
const root = new URL('../dist/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Pages redirects /<repo> to /<repo>/.
  if (url.pathname === base.slice(0, -1)) { res.writeHead(301, { location: base + url.search }); return res.end(); }
  if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end('404'); }
  let file = normalize(join(root, decodeURIComponent(url.pathname.slice(base.length))));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=600' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('404');
  }
}).listen(port, () => console.log(`serving dist/ at http://localhost:${port}${base}`));
