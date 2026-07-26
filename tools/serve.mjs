/* A static file server with no dependencies, so `npm test` is one command
 * instead of "start a server in another terminal, then run the checks". */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav'
};

/** @returns {Promise<{url: string, close: () => Promise<void>}>} */
export function startServer(rootDir, port = 0) {
  const root = resolve(rootDir);

  const server = createServer(async (req, res) => {
    let path;
    try {
      path = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path.endsWith('/') || path.endsWith(sep)) path += 'index.html';
    const file = resolve(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

  return new Promise((ok, err) => {
    server.on('error', err);
    server.listen(port, '127.0.0.1', () => ok({
      url: 'http://127.0.0.1:' + server.address().port,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}
