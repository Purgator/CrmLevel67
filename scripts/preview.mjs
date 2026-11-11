// `npm run preview`: a fake Dynamics 365 page with the popup docked beside it,
// so the whole extension can be exercised in any browser without an org and
// without installing anything. Extension APIs and Xrm are mocked (test/mock/).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 6767;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let file;
    if (url.pathname === '/' || url.pathname === '/main.aspx') file = 'test/mock/d365.html';
    else if (url.pathname.startsWith('/mock/')) file = `test${url.pathname}`;
    else file = `src${url.pathname}`;
    const full = path.join(root, path.normalize(file));
    if (!full.startsWith(root)) throw new Error('outside root');
    let body = await readFile(full);
    if (url.pathname === '/popup/popup.html') {
      body = body.toString().replace('<script type="module"', '<script src="/mock/chrome.js"></script>\n  <script type="module"');
    }
    res.writeHead(200, { 'Content-Type': `${TYPES[path.extname(full)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Level 67 preview: http://localhost:${port}/`));
