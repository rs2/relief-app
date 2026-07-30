// Elevation data: AWS Terrarium DEM tiles, decoded to metres and cached.
//
// Tiles come from the local proxy first (serve.js keeps them on disk, so ground you
// have already looked at loads instantly and works offline) and fall back to the
// public S3 bucket, which is CORS-clean, if the proxy is missing or fails.

export const DEM_MAX_Z = 15;          // terrarium has no useful detail above this
export const TILE_PX = 256;

const PROXY_URL = (z, x, y) => `/dem/${z}/${x}/${y}.png`;
const DIRECT_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const D2R = Math.PI / 180;
const EARTH_CIRC = 156543.03392804097;   // metres per pixel at z0, equator, 256px tiles

const status = (m) => { try { window.reliefStatus?.(m); } catch {} };

// ---------------------------------------------------------------------------
// Web Mercator / slippy maths
// ---------------------------------------------------------------------------

/** Fractional tile coordinates for a lon/lat. */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const la = Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R;
  return [
    (lon + 180) / 360 * n,
    (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n,
  ];
}

/** Lon/lat for (fractional) tile coordinates — the tile's NW corner at integers. */
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / D2R;
  return [lon, lat];
}

/** Ground metres per pixel at this latitude and zoom. */
export function metresPerPixel(lat, z) {
  return EARTH_CIRC * Math.cos(lat * D2R) / 2 ** z;
}

export function demZoomFor(mapZoom) {
  return Math.min(Math.max(Math.round(mapZoom), 0), DEM_MAX_Z);
}

/**
 * Per-row metres/pixel for a padded tile window — Mercator stretches with latitude,
 * and at low zoom one tile spans enough of it to visibly skew slope if ignored.
 */
export function mppRowsForTile(z, ty, size, pad = 0) {
  const rows = new Float32Array(size);
  for (let r = 0; r < size; r++) {
    const lat = tileToLonLat(0, ty + (r - pad + 0.5) / TILE_PX, z)[1];
    rows[r] = metresPerPixel(lat, z);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/** Terrarium RGB -> metres. `rgba` is RGBA bytes; returns Float32Array of pixels. */
export function decodeTerrarium(rgba, out) {
  const n = rgba.length >> 2;
  const dst = out && out.length >= n ? out : new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    dst[i] = rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768;
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Tile cache
// ---------------------------------------------------------------------------

const CACHE_MAX = 600;                 // ~600 * 256KB ≈ 150MB worst case
const cache = new Map();               // "z/x/y" -> Float32Array   (insertion-ordered LRU)
const inflight = new Map();            // "z/x/y" -> Promise
const failed = new Set();

const key = (z, x, y) => `${z}/${x}/${y}`;

function cacheGet(k) {
  const v = cache.get(k);
  if (v !== undefined) { cache.delete(k); cache.set(k, v); }   // touch = move to newest
  return v;
}

function cacheSet(k, v) {
  cache.set(k, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export function peekDemTile(z, x, y) {
  return cacheGet(key(z, x, y)) ?? null;
}

export function tileFailed(z, x, y) {
  return failed.has(key(z, x, y));
}

let scratch = null;                    // reused 256x256 decode canvas

function decodeBitmapToElev(bmp) {
  if (!scratch) {
    scratch = ('OffscreenCanvas' in globalThis)
      ? new OffscreenCanvas(TILE_PX, TILE_PX)
      : Object.assign(document.createElement('canvas'), {width: TILE_PX, height: TILE_PX});
  }
  const ctx = scratch.getContext('2d', {willReadFrequently: true});
  ctx.clearRect(0, 0, TILE_PX, TILE_PX);
  ctx.drawImage(bmp, 0, 0, TILE_PX, TILE_PX);
  return decodeTerrarium(ctx.getImageData(0, 0, TILE_PX, TILE_PX).data);
}

async function fetchBitmap(url, signal) {
  const r = await fetch(url, {signal, mode: 'cors'});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  if ('createImageBitmap' in globalThis) return createImageBitmap(blob);
  // fallback for browsers without createImageBitmap
  const img = new Image();
  const src = URL.createObjectURL(blob);
  try {
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = () => rej(new Error('decode failed'));
      img.src = src;
    });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(src), 0); }
}

/**
 * Decoded elevation for one tile, in metres, row-major 256x256.
 * Never rejects on a dead tile: after retries it resolves to a zero-filled array and
 * records the failure (see tileFailed), so shading degrades to flat rather than
 * throwing NaNs through every downstream kernel.
 */
export async function getDemTile(z, x, y, signal) {
  const k = key(z, x, y);
  const hit = cacheGet(k);
  if (hit) return hit;
  const pending = inflight.get(k);
  if (pending) return pending;

  const job = (async () => {
    const urls = [PROXY_URL(z, x, y), DIRECT_URL(z, x, y)];
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = urls[Math.min(attempt, urls.length - 1)];
      try {
        const bmp = await fetchBitmap(url, signal);
        const elev = decodeBitmapToElev(bmp);
        bmp.close?.();
        cacheSet(k, elev);
        failed.delete(k);
        return elev;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    failed.add(k);
    const flat = new Float32Array(TILE_PX * TILE_PX);
    cacheSet(k, flat);
    return flat;
  })().finally(() => inflight.delete(k));

  inflight.set(k, job);
  return job;
}

// ---------------------------------------------------------------------------
// Padded window — the input shading actually wants
// ---------------------------------------------------------------------------

/**
 * The tile plus a `pad`-pixel halo taken from its real neighbours, so a 3x3 kernel
 * has true data at the border and adjacent tiles shade identically (no seams).
 * Neighbours already in cache cost nothing; missing ones are fetched, and any that
 * fail are edge-clamped from this tile.
 */
export async function getPaddedTile(z, x, y, pad = 1, signal) {
  const own = await getDemTile(z, x, y, signal);
  const n = 2 ** z;

  // 3x3 neighbourhood, indexed (dy+1)*3 + (dx+1); own tile at index 4
  const grid = new Array(9).fill(null);
  const wants = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i = (dy + 1) * 3 + (dx + 1);
      if (i === 4) { grid[4] = own; continue; }
      const nx = x + dx, ny = y + dy;
      if (ny < 0 || ny >= n) continue;                  // off the poles: clamp
      const wx = ((nx % n) + n) % n;                    // wrap the antimeridian
      const cached = peekDemTile(z, wx, ny);
      if (cached) grid[i] = cached;
      else wants.push(getDemTile(z, wx, ny, signal).then((t) => { grid[i] = t; }, () => {}));
    }
  }
  if (wants.length) await Promise.all(wants);

  const size = TILE_PX + 2 * pad;
  const out = new Float32Array(size * size);
  const P = TILE_PX;
  for (let oy = 0; oy < size; oy++) {
    const gy = oy - pad;                                // -pad .. P-1+pad
    const dy = gy < 0 ? -1 : gy >= P ? 1 : 0;
    const ly = gy - dy * P;
    const rowBase = oy * size;
    for (let ox = 0; ox < size; ox++) {
      const gx = ox - pad;
      const dx = gx < 0 ? -1 : gx >= P ? 1 : 0;
      const src = grid[(dy + 1) * 3 + (dx + 1)];
      if (src) {
        out[rowBase + ox] = src[ly * P + (gx - dx * P)];
      } else {
        // neighbour unavailable — clamp against our own edge
        const cy = gy < 0 ? 0 : gy >= P ? P - 1 : gy;
        const cx = gx < 0 ? 0 : gx >= P ? P - 1 : gx;
        out[rowBase + ox] = own[cy * P + cx];
      }
    }
  }
  return {data: out, size, pad, z, x, y};
}

// ---------------------------------------------------------------------------
// Arbitrary region mosaic (3D view, profile sampling)
// ---------------------------------------------------------------------------

const REGION_MAX_PX = 2400;            // keep a mosaic under ~23MB of Float32

/**
 * Elevation grid covering `bounds` at zoom `z`, snapped outward to whole DEM pixels.
 * If the request would be enormous the zoom is reduced and the actual one reported.
 *
 * opts: {onProgress(done, total), signal, concurrency}
 */
export async function getRegion(bounds, z, opts = {}) {
  let {west, south, east, north} = bounds;
  if (east < west) [west, east] = [east, west];
  if (north < south) [south, north] = [north, south];
  z = Math.min(Math.max(Math.round(z), 0), DEM_MAX_Z);

  let px0, py0, px1, py1, w, h;
  for (;;) {
    const [tx0, ty0] = lonLatToTile(west, north, z);
    const [tx1, ty1] = lonLatToTile(east, south, z);
    px0 = Math.floor(tx0 * TILE_PX); py0 = Math.floor(ty0 * TILE_PX);
    px1 = Math.ceil(tx1 * TILE_PX);  py1 = Math.ceil(ty1 * TILE_PX);
    w = Math.max(2, px1 - px0); h = Math.max(2, py1 - py0);
    if ((w <= REGION_MAX_PX && h <= REGION_MAX_PX) || z === 0) break;
    z--;                                // too big — coarsen and try again
  }

  const data = new Float32Array(w * h);
  const tX0 = Math.floor(px0 / TILE_PX), tX1 = Math.floor((px1 - 1) / TILE_PX);
  const tY0 = Math.floor(py0 / TILE_PX), tY1 = Math.floor((py1 - 1) / TILE_PX);
  const n = 2 ** z;

  const jobs = [];
  for (let ty = tY0; ty <= tY1; ty++) {
    for (let tx = tX0; tx <= tX1; tx++) jobs.push([tx, ty]);
  }
  const total = jobs.length;
  let done = 0;

  const queue = jobs.slice();
  const workers = Array.from({length: Math.min(opts.concurrency ?? 6, total || 1)}, async () => {
    while (queue.length) {
      const [tx, ty] = queue.shift();
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (ty < 0 || ty >= n) { done++; continue; }
      const wx = ((tx % n) + n) % n;
      const tile = await getDemTile(z, wx, ty, opts.signal);
      // blit the overlapping part of this tile into the mosaic
      const gx0 = tx * TILE_PX, gy0 = ty * TILE_PX;
      const sx0 = Math.max(0, px0 - gx0), sx1 = Math.min(TILE_PX, px1 - gx0);
      const sy0 = Math.max(0, py0 - gy0), sy1 = Math.min(TILE_PX, py1 - gy0);
      for (let sy = sy0; sy < sy1; sy++) {
        const dstRow = (gy0 + sy - py0) * w + (gx0 + sx0 - px0);
        data.set(tile.subarray(sy * TILE_PX + sx0, sy * TILE_PX + sx1), dstRow);
      }
      done++;
      opts.onProgress?.(done, total);
    }
  });
  await Promise.all(workers);

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // grid bounds, snapped outward to the whole pixels we actually loaded
  const [gWest, gNorth] = tileToLonLat(px0 / TILE_PX, py0 / TILE_PX, z);
  const [gEast, gSouth] = tileToLonLat(px1 / TILE_PX, py1 / TILE_PX, z);

  const region = {
    data, w, h, z,
    west: gWest, north: gNorth, east: gEast, south: gSouth,
    min, max,
    /** Bilinear sample in metres; edge-clamped, so it is safe just outside the grid. */
    sample(lon, lat) {
      const [tx, ty] = lonLatToTile(lon, lat, z);
      let fx = tx * TILE_PX - px0 - 0.5;
      let fy = ty * TILE_PX - py0 - 0.5;
      fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
      fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const rx = fx - x0, ry = fy - y0;
      const a = data[y0 * w + x0], b = data[y0 * w + x1];
      const c = data[y1 * w + x0], d = data[y1 * w + x1];
      return (a * (1 - rx) + b * rx) * (1 - ry) + (c * (1 - rx) + d * rx) * ry;
    },
  };
  return region;
}

/** Elevation at a single point, bilinear inside its tile. */
export async function elevationAt(lon, lat, z = DEM_MAX_Z, signal) {
  z = Math.min(Math.max(Math.round(z), 0), DEM_MAX_Z);
  const [tx, ty] = lonLatToTile(lon, lat, z);
  const tile = await getDemTile(z, Math.floor(tx), Math.floor(ty), signal);
  let fx = (tx - Math.floor(tx)) * TILE_PX - 0.5;
  let fy = (ty - Math.floor(ty)) * TILE_PX - 0.5;
  fx = fx < 0 ? 0 : fx > TILE_PX - 1 ? TILE_PX - 1 : fx;
  fy = fy < 0 ? 0 : fy > TILE_PX - 1 ? TILE_PX - 1 : fy;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(TILE_PX - 1, x0 + 1), y1 = Math.min(TILE_PX - 1, y0 + 1);
  const rx = fx - x0, ry = fy - y0;
  const a = tile[y0 * TILE_PX + x0], b = tile[y0 * TILE_PX + x1];
  const c = tile[y1 * TILE_PX + x0], d = tile[y1 * TILE_PX + x1];
  return (a * (1 - rx) + b * rx) * (1 - ry) + (c * (1 - rx) + d * rx) * ry;
}

/** Great-circle distance in metres. Handy for anything measuring along the ground. */
export function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371008.8;
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const _cacheStats = () => ({tiles: cache.size, inflight: inflight.size, failed: failed.size});
