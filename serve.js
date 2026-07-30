#!/usr/bin/env node
// Static server + caching tile proxy for relief-app.  Node stdlib only — no npm.
//
//   node serve.js [port]
//
// The tile sources are all CORS-clean, so the browser could fetch them directly.
// We proxy anyway for two reasons: tiles land in ./tilecache and survive a reload
// (the app gets fast and works offline over ground you have already looked at),
// and we can send a polite User-Agent, which OSM's tile policy asks for.

import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, rename, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join, extname, normalize, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE = join(ROOT, 'tilecache');
const PORT = Number(process.argv[2] || process.env.PORT || 8099);
const UA = 'relief-app/1.0 (personal cycling terrain viewer)';

const DEM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// note the y/x swap on the ArcGIS endpoint — it is not a typo
const BASEMAPS = {
  osm:   {url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,       ext: 'png', mime: 'image/png'},
  light: {url: (z, x, y) => `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`, ext: 'png', mime: 'image/png'},
  dark:  {url: (z, x, y) => `https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,  ext: 'png', mime: 'image/png'},
  topo:  {url: (z, x, y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png`,          ext: 'png', mime: 'image/png'},
  sat:   {url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/` +
                            `World_Imagery/MapServer/tile/${z}/${y}/${x}`,              ext: 'jpg', mime: 'image/jpeg'},
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

let hits = 0, misses = 0, failures = 0;

// z/x/y must be integers in range, or a crafted path could escape the cache dir
function validTile(z, x, y, maxZ = 19) {
  if (![z, x, y].every(Number.isInteger)) return false;
  if (z < 0 || z > maxZ) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
}

async function cachedFetch(url, cacheFile, mime, res) {
  try {
    const buf = await readFile(cacheFile);
    hits++;
    res.writeHead(200, {'Content-Type': mime, 'Content-Length': buf.length,
                        'Cache-Control': 'max-age=604800', 'X-Cache': 'HIT'});
    return res.end(buf);
  } catch { /* not cached yet */ }

  try {
    const r = await fetch(url, {headers: {'User-Agent': UA}});
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    misses++;
    res.writeHead(200, {'Content-Type': mime, 'Content-Length': buf.length,
                        'Cache-Control': 'max-age=604800', 'X-Cache': 'MISS'});
    res.end(buf);
    // write after responding, via temp+rename so a concurrent read never sees a partial file
    const tmp = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await mkdir(dirname(cacheFile), {recursive: true});
    await writeFile(tmp, buf).then(() => rename(tmp, cacheFile)).catch(() => {});
  } catch (e) {
    failures++;
    // 502 with a body the client can log; dem.js falls back to the direct CDN URL
    if (!res.headersSent) res.writeHead(502, {'Content-Type': 'text/plain'});
    res.end(`tile fetch failed: ${e.message}`);
  }
}

async function serveStatic(pathname, res) {
  // normalize then confine to ROOT
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const st = await stat(file);
    if (st.isDirectory()) return serveStatic(join(pathname, 'index.html'), res);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      // the app's own source should never be stale during development
      'Cache-Control': /\.(png|jpg|ico)$/i.test(file) ? 'max-age=86400' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, {'Content-Type': 'text/plain'}).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const {pathname, searchParams} = new URL(req.url, `http://${req.headers.host}`);

  // /dem/{z}/{x}/{y}.png
  let m = pathname.match(/^\/dem\/(\d+)\/(\d+)\/(\d+)(?:\.png)?$/);
  if (m) {
    const [z, x, y] = m.slice(1).map(Number);
    if (!validTile(z, x, y, 15)) return res.writeHead(400).end('bad tile');
    return cachedFetch(DEM_URL(z, x, y), join(CACHE, 'dem', String(z), `${x}_${y}.png`),
                       'image/png', res);
  }

  // /tile/{src}/{z}/{x}/{y}
  m = pathname.match(/^\/tile\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?$/);
  if (m) {
    const src = BASEMAPS[m[1]];
    const [z, x, y] = m.slice(2).map(Number);
    if (!src) return res.writeHead(404).end('unknown basemap');
    if (!validTile(z, x, y)) return res.writeHead(400).end('bad tile');
    return cachedFetch(src.url(z, x, y),
                       join(CACHE, m[1], String(z), `${x}_${y}.${src.ext}`), src.mime, res);
  }

  // /geocode?q=... — Nominatim wants a real User-Agent, which a browser cannot set
  if (pathname === '/geocode') {
    const q = (searchParams.get('q') || '').trim();
    if (!q) return res.writeHead(400).end('[]');
    try {
      const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' +
                encodeURIComponent(q);
      const r = await fetch(u, {headers: {'User-Agent': UA, 'Accept-Language': 'en'}});
      const body = await r.text();
      res.writeHead(r.ok ? 200 : 502, {'Content-Type': 'application/json'}).end(body);
    } catch (e) {
      res.writeHead(502, {'Content-Type': 'application/json'}).end('[]');
    }
    return;
  }

  if (pathname === '/stats') {
    return res.writeHead(200, {'Content-Type': 'application/json'})
              .end(JSON.stringify({cacheHits: hits, cacheMisses: misses, failures}));
  }

  serveStatic(pathname === '/' ? '/index.html' : pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`relief-app  →  http://localhost:${PORT}`);
  console.log(`tile cache  →  ${CACHE}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is busy — try:  node serve.js ${PORT + 1}`);
    process.exit(1);
  }
  throw e;
});
