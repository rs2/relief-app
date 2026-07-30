// 2D exaggerated-relief map (CONTRACT.md §4).
//
// The headline mode: a Leaflet map whose hill relief is re-shaded live from a slider. Every
// visible tile keeps its decoded elevation in memory, so a slider move re-shades from RAM and
// never touches the network — that responsiveness is the whole feature.
//
// Compositing note (important, and the one non-obvious design call in here):
// the contract asks for "hypsometric tint -> multiply by hillshade -> gradient bands ->
// contours". A true multiply against the *basemap* cannot happen inside our own canvas, so the
// tile is emitted as an (RGB, A) pair chosen so that the browser's own alpha compositing
// reproduces the multiply exactly:
//
//   want:  final = [dst*(1-ah) + H*ah] * mul, then screened toward white by hi
//   have:  final = dst*(1-A) + C*A
//   so:    k = mul*(1-hi),  A = 1 - k*(1-ah),  C = (H*ah*k + 255*hi) / A
//
// Consequences worth knowing: flat ground with only the hillshade on comes out fully
// transparent (the basemap is left completely alone — honest, and free), deep shadow comes out
// opaque black (dst*0), and it works over a dark or satellite basemap where a naive grey veil
// or a CSS multiply would turn to mud.

import * as dem from './dem.js';
import * as shade from './shade.js';

const TILE = dem.TILE_PX || 256;
const MAXZ = dem.DEM_MAX_Z || 15;
const PAD = 2;                 // always 2 — contours need it, and a layer toggle must not refetch
const D2R = Math.PI / 180;
const HL = 0.45;               // how far a fully lit slope is screened toward white
const BUDGET = 11;             // ms of shading per animation frame, so dragging never janks
const MIN_SPAN = 20;           // m — floor on the hypsometric range, or flat ground goes rainbow

const BASEMAPS = {
  osm:   {path: 'osm',   maxZoom: 19, dark: false,
          direct: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          attr: '&copy; OpenStreetMap contributors'},
  light: {path: 'light', maxZoom: 20, dark: false,
          direct: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          attr: '&copy; OpenStreetMap, &copy; CARTO'},
  dark:  {path: 'dark',  maxZoom: 20, dark: true,
          direct: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          attr: '&copy; OpenStreetMap, &copy; CARTO'},
  sat:   {path: 'sat',   maxZoom: 19, dark: true,
          direct: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/' +
                  'MapServer/tile/{z}/{y}/{x}',
          attr: 'Imagery &copy; Esri'},
  topo:  {path: 'topo',  maxZoom: 17, dark: false,
          direct: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
          attr: '&copy; OpenStreetMap, OpenTopoMap (CC-BY-SA)'},
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

// ---------------------------------------------------------------------------
// status helpers — never throw, never spam
// ---------------------------------------------------------------------------
const said = new Set();
function warnOnce(msg) {
  if (said.has(msg)) return;
  said.add(msg);
  console.warn('[map2d]', msg);
  window.reliefStatus?.(msg, true);
}
let errAt = 0, errN = 0;
function tileFailed(e) {
  errN++;
  const now = Date.now();
  if (now - errAt < 4000) return;
  errAt = now;
  window.reliefStatus?.(`elevation tile failed (${errN}) — ${(e && e.message) || e}`, true);
}
function pushReadout(html, plain) {
  if (typeof window.reliefReadout === 'function') window.reliefReadout(html);
  else if (typeof window.reliefStatus === 'function' && plain) window.reliefStatus(plain);
}

// ---------------------------------------------------------------------------
// raster prep: one 256-sample raster per map tile, padded by PAD on every side
// ---------------------------------------------------------------------------
const RSIZE = TILE + 2 * PAD;
const mppCache = new Map();

// Per-row metres/pixel. Mercator stretches with latitude and a tile spans enough of it at low
// zoom to matter, so slope would be wrong across the tile from a single latitude.
function rowMpp(z, ty) {
  const key = `${z}/${ty}`;
  let a = mppCache.get(key);
  if (a) return a;
  a = new Float32Array(TILE);
  for (let v = 0; v < TILE; v++) {
    const lat = dem.tileToLonLat(0, ty + (v + 0.5) / TILE, z)[1];
    a[v] = dem.metresPerPixel(lat, z);
  }
  if (mppCache.size > 4096) mppCache.clear();
  mppCache.set(key, a);
  return a;
}

// Bilinear blow-up of a sub-rectangle of a coarser DEM tile, used above DEM z15 (relief goes
// soft rather than blocky). Output keeps the same PAD halo so the kernels stay seam-free.
function upsample(src, srcSize, srcPad, ox, oy, scale) {
  const out = new Float32Array(RSIZE * RSIZE);
  const inv = 1 / scale;
  const lim = TILE + srcPad - 1, min = -srcPad;
  for (let j = 0; j < RSIZE; j++) {
    const sy = oy + (j - PAD + 0.5) * inv - 0.5;
    const y0 = Math.floor(sy), fy = sy - y0;
    const ra = (clamp(y0, min, lim) + srcPad) * srcSize + srcPad;
    const rb = (clamp(y0 + 1, min, lim) + srcPad) * srcSize + srcPad;
    for (let i = 0; i < RSIZE; i++) {
      const sx = ox + (i - PAD + 0.5) * inv - 0.5;
      const x0 = Math.floor(sx), fx = sx - x0;
      const ca = clamp(x0, min, lim), cb = clamp(x0 + 1, min, lim);
      const p = src[ra + ca], q = src[ra + cb], r = src[rb + ca], s = src[rb + cb];
      out[j * RSIZE + i] = p + (q - p) * fx + (r - p) * fy + (p - q - r + s) * fx * fy;
    }
  }
  return out;
}

async function loadRaster(tz, tx, ty) {
  const demZ = Math.min(dem.demZoomFor(tz), tz);
  const scale = 1 << (tz - demZ);
  const t = await dem.getPaddedTile(demZ, Math.floor(tx / scale), Math.floor(ty / scale), PAD);
  const srcPad = t.pad ?? PAD;
  const srcSize = t.size ?? (TILE + 2 * srcPad);
  let data = t.data, size = srcSize, pad = srcPad;
  if (scale > 1) {
    const sub = TILE / scale;
    const ox = (((tx % scale) + scale) % scale) * sub;
    const oy = (((ty % scale) + scale) % scale) * sub;
    data = upsample(t.data, srcSize, srcPad, ox, oy, scale);
    size = RSIZE; pad = PAD;
  }
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < TILE; y++) {
    const row = (y + pad) * size + pad;
    for (let x = 0; x < TILE; x++) {
      const v = data[row + x];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  // mpp belongs to the raster's own spacing: 256 samples across a tz tile, upsampled or not
  return {data, size, pad, demZ, scale, min, max, mppRow: rowMpp(tz, ty)};
}

// ---------------------------------------------------------------------------
export function create2D({container, state = {}, onStateChange} = {}) {
  if (typeof L === 'undefined' || !L.GridLayer) {
    throw new Error('Leaflet (global L) is not loaded — index.html must load vendor/leaflet/leaflet.js first');
  }
  if (!container) throw new Error('create2D needs a container element');

  const o = {
    zFactor: clamp(num(state.ex2d, 6), 0.1, 60),
    sunAz: num(state.sunAz, 315),
    sunAlt: clamp(num(state.sunAlt, 45), 1, 89),
    basemap: BASEMAPS[state.basemap] ? state.basemap : 'light',
    units: state.units === 'imperial' ? 'imperial' : 'metric',
    layers: {hillshade: true, multi: false, gradient: true, hypso: false, contours: false,
             ...(state.layers || {})},
    hiRes: !!(L.Browser && L.Browser.retina),
    reliefOpacity: 1,
    gradientStrength: 1,
    hypsoAlpha: 0.72,
    contourInterval: 0,        // 0 = auto, from shade.contourInterval
    contourLabels: true,
  };

  const recs = new Map();      // tile key -> {data, canvas, slope, contours, …}
  let range = {lo: 0, hi: MIN_SPAN};
  let hLut = null, gLut = null, img = null;
  let hidden = false, useDirect = !/^https?:$/.test(location.protocol);
  let base = null, relief = null, scaleCtl = null;

  // ---- colour lookup tables (per-pixel calls into shade.js would allocate 65k arrays/tile) ----
  function hypsoLut() {
    if (hLut) return hLut;
    hLut = new Uint8Array(768);
    const span = range.hi - range.lo;
    for (let i = 0; i < 256; i++) {
      const c = shade.hypsoColor(range.lo + (span * i) / 255, range.lo, range.hi) || [0, 0, 0];
      hLut[i * 3] = c[0]; hLut[i * 3 + 1] = c[1]; hLut[i * 3 + 2] = c[2];
    }
    return hLut;
  }
  function bandLut() {
    if (gLut) return gLut;
    gLut = new Uint8Array(1024);                  // index = pct*8, so 0..31.875% in 1/8% steps
    const g = clamp(num(o.gradientStrength, 1), 0, 2);
    for (let i = 0; i < 256; i++) {
      const c = shade.gradientBandColor(i / 8);
      if (!c) continue;                           // below the first band: leave flat ground alone
      // tolerate an alpha given either 0..1 or 0..255
      let a = c[3] == null ? 0.55 : c[3] > 1 ? c[3] / 255 : c[3];
      a = clamp(a * g, 0, 0.95);
      gLut[i * 4] = c[0]; gLut[i * 4 + 1] = c[1]; gLut[i * 4 + 2] = c[2];
      gLut[i * 4 + 3] = a * 255;
    }
    return gLut;
  }
  function imgFor(ctx) {
    if (!img) {
      try { img = new ImageData(TILE, TILE); }
      catch { img = ctx.createImageData(TILE, TILE); }
    }
    return img;
  }

  // ---- which tiles are on screen (for priority, and for the view elevation range) ----
  function visibleRange() {
    if (!relief || !relief._map || relief._tileZoom == null) return null;
    const z = relief._tileZoom, ts = relief.getTileSize().x;
    const b = map.getBounds();
    const nw = map.project(b.getNorthWest(), z), se = map.project(b.getSouthEast(), z);
    return {z, x0: Math.floor(nw.x / ts), y0: Math.floor(nw.y / ts),
            x1: Math.ceil(se.x / ts), y1: Math.ceil(se.y / ts)};
  }
  function inView(rec, vr) {
    if (!vr) return true;
    const c = rec.coords;
    return c.z === vr.z && c.x >= vr.x0 && c.x < vr.x1 && c.y >= vr.y0 && c.y < vr.y1;
  }

  // The hypsometric ramp and the auto contour interval must come from the whole view, not from
  // each tile — per-tile ranges would put a colour seam on every tile border.
  function refreshRange() {
    const vr = visibleRange();
    let lo = Infinity, hi = -Infinity;
    for (const rec of recs.values()) {
      if (!rec.ready || !inView(rec, vr)) continue;
      if (rec.min < lo) lo = rec.min;
      if (rec.max > hi) hi = rec.max;
    }
    if (!Number.isFinite(lo)) return false;
    if (hi - lo < MIN_SPAN) { const m = (lo + hi) / 2; lo = m - MIN_SPAN / 2; hi = m + MIN_SPAN / 2; }
    const tol = Math.max(1, (hi - lo) * 0.02);
    if (Math.abs(range.lo - lo) < tol && Math.abs(range.hi - hi) < tol) return false;
    range = {lo, hi};
    hLut = null;
    return true;
  }
  function autoInterval() {
    try { return shade.contourInterval(map.getZoom(), range.hi - range.lo) || 10; }
    catch { return 10; }
  }

  // ---- the shading pass: everything below reads cached elevation, never the network ----
  function shadeRec(rec) {
    if (!rec || rec.dead || !rec.ready || !rec.data) return;
    const ctx = rec.canvas.getContext('2d');
    if (!ctx) return;
    const ly = o.layers;
    const {data, size, pad} = rec;
    const kern = {size, pad, mppRow: rec.mppRow};

    let hs = null;
    if (ly.hillshade) {
      try {
        hs = shade.hillshade(data, TILE, TILE, {...kern,
          zFactor: o.zFactor, azimuth: o.sunAz, altitude: o.sunAlt,
          multiDirectional: !!ly.multi});
      } catch (e) { warnOnce(`hillshade failed: ${e.message}`); }
    }
    let sl = null;
    if (ly.gradient) {
      // slope is zFactor-free and never changes, so it survives every slider move
      if (!rec.slope) {
        try { rec.slope = shade.slopePercent(data, TILE, TILE, kern); }
        catch (e) { warnOnce(`slope failed: ${e.message}`); }
      }
      sl = rec.slope;
    }

    const gl = sl ? bandLut() : null;
    const ah = ly.hypso ? clamp(num(o.hypsoAlpha, 0.72), 0, 1) : 0;
    const hl = ah > 0 ? hypsoLut() : null;
    const neutral = Math.sin(clamp(num(o.sunAlt, 45), 1, 89) * D2R);  // flat ground = cos(zenith)
    const hiDen = 1 / neutral - 1;             // largest possible s-1, so highlights normalise
    const lo = range.lo;
    const invSpan = range.hi - lo > 1e-6 ? 255 / (range.hi - lo) : 0;
    const out = imgFor(ctx).data;

    for (let y = 0, i = 0, q = 0; y < TILE; y++) {
      const row = (y + pad) * size + pad;
      for (let x = 0; x < TILE; x++, i++, q += 4) {
        let mul = 1, hi = 0;
        if (hs) {
          const s = hs[i] / neutral;           // 1.0 on flat ground
          if (s < 1) mul = s > 0 ? s : 0;
          else if (hiDen > 1e-3) { hi = (HL * (s - 1)) / hiDen; if (hi > 1) hi = 1; }
        }
        const k = mul * (1 - hi);
        let a = 1 - k * (1 - ah), r = 0, g = 0, b = 0;
        if (a > 1e-4) {
          const w = 255 * hi;
          if (ah > 0) {
            let t = (data[row + x] - lo) * invSpan;
            t = t < 0 ? 0 : t > 255 ? 255 : t;
            const p = (t | 0) * 3, f = ah * k;
            r = (hl[p] * f + w) / a; g = (hl[p + 1] * f + w) / a; b = (hl[p + 2] * f + w) / a;
          } else {
            r = g = b = w / a;
          }
        }
        if (gl) {
          const pv = sl[i] * 8;
          const bi = (pv > 255 ? 255 : pv > 0 ? pv | 0 : 0) << 2;
          const ba = gl[bi + 3];
          if (ba) {                            // plain source-over: bands sit above the shading
            const ab = ba / 255, keep = a * (1 - ab), na = ab + keep;
            r = (gl[bi] * ab + r * keep) / na;
            g = (gl[bi + 1] * ab + g * keep) / na;
            b = (gl[bi + 2] * ab + b * keep) / na;
            a = na;
          }
        }
        out[q] = r; out[q + 1] = g; out[q + 2] = b; out[q + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);               // replaces, so no clearRect and no stale strokes
    if (ly.contours) strokeContours(ctx, rec);
    rec.dirty = false;
  }

  function strokeContours(ctx, rec) {
    const iv = num(o.contourInterval, 0) || autoInterval();
    if (!(iv > 0)) return;
    let c = rec.contours;
    if (!c || c.iv !== iv) {
      let list = [];
      try {
        // TILE+1 samples so the marching-squares cells reach the tile's far edge; with only
        // TILE the last row/column of cells is missing and every tile seam breaks the lines.
        list = shade.contourSegments(rec.data, TILE + 1, TILE + 1,
                                     {size: rec.size, pad: rec.pad, interval: iv}) || [];
      } catch (e) { warnOnce(`contours failed: ${e.message}`); }
      c = rec.contours = {iv, list};
    }
    if (!c.list.length) return;

    const rr = rec.rr || 1;                    // canvas px per CSS px (2 on HiDPI)
    const ink = BASEMAPS[o.basemap]?.dark ? '255,255,255' : '46,32,18';
    const major = iv * 5;
    const fine = [], bold = [];
    for (const lv of c.list) (Math.abs(lv.level % major) < 1e-6 ? bold : fine).push(lv);

    ctx.lineCap = 'round';
    for (const [group, width, alpha] of [[fine, Math.max(1, rr * 0.6), 0.42],
                                         [bold, Math.max(1, rr * 1.1), 0.66]]) {
      if (!group.length) continue;
      ctx.beginPath();
      for (const lv of group) {
        const s = lv.segs;
        for (let i = 0; i < s.length; i += 4) {
          ctx.moveTo(s[i] + 0.5, s[i + 1] + 0.5);
          ctx.lineTo(s[i + 2] + 0.5, s[i + 3] + 0.5);
        }
      }
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(${ink},${alpha})`;
      ctx.stroke();
    }

    if (!o.contourLabels) return;
    const fs = Math.round(9 * rr);
    ctx.font = `600 ${fs}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const lv of bold) {
      const s = lv.segs;
      let best = -1, bd = Infinity;
      for (let i = 0; i < s.length; i += 4) {
        const d = Math.abs((s[i] + s[i + 2]) / 2 - TILE / 2) +
                  Math.abs((s[i + 1] + s[i + 3]) / 2 - TILE / 2);
        if (d < bd) { bd = d; best = i; }
      }
      // nothing near the middle: let a neighbouring tile carry this level's label
      if (best < 0 || bd > TILE * 0.4) continue;
      const dx = s[best + 2] - s[best], dy = s[best + 3] - s[best + 1];
      let ang = Math.atan2(dy, dx);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      ctx.save();
      ctx.translate((s[best] + s[best + 2]) / 2, (s[best + 1] + s[best + 3]) / 2);
      ctx.rotate(ang);
      const txt = `${Math.round(lv.level)} m`;
      ctx.lineWidth = Math.max(2, rr * 2);
      ctx.strokeStyle = BASEMAPS[o.basemap]?.dark ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.8)';
      ctx.strokeText(txt, 0, 0);
      ctx.fillStyle = `rgba(${ink},.95)`;
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    }
  }

  // ---- re-shade scheduler: debounced, viewport-first, time-budgeted per frame ----
  let flushT = 0, rafId = 0, lastPoke = 0;
  function markAll() { for (const rec of recs.values()) rec.dirty = true; schedule(); }
  function schedule(delay = 16) {
    lastPoke = performance.now();
    if (flushT || rafId) return;
    flushT = setTimeout(() => { flushT = 0; rafId = requestAnimationFrame(drain); }, delay);
  }
  function drain() {
    rafId = 0;
    if (hidden) return;                        // nothing on screen: stay dirty, repaint on show()
    const vr = visibleRange();
    const busy = performance.now() - lastPoke < 150;
    const list = [];
    for (const rec of recs.values()) if (rec.dirty && rec.ready) list.push(rec);
    if (!list.length) return;
    if (list.length > 1 && vr) {
      const ts = relief.getTileSize().x;
      const c = map.project(map.getCenter(), vr.z);
      for (const rec of list) {
        rec.d = rec.coords.z !== vr.z ? 1e9
          : Math.hypot((rec.coords.x + 0.5) * ts - c.x, (rec.coords.y + 0.5) * ts - c.y);
      }
      list.sort((a, b) => a.d - b.d);
    }
    const t0 = performance.now();
    let left = false;
    for (const rec of list) {
      // while the slider is moving, spend the frame on what the user can actually see
      if (busy && !inView(rec, vr)) { left = true; continue; }
      shadeRec(rec);
      if (performance.now() - t0 > BUDGET) { left = true; break; }
    }
    for (const rec of recs.values()) if (rec.dirty && rec.ready) { left = true; break; }
    if (left) rafId = requestAnimationFrame(drain);
  }

  // ---- the relief GridLayer ----
  const key = (c) => `${c.z}/${c.x}/${c.y}`;
  const ReliefLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const canvas = L.DomUtil.create('canvas', 'm2d-relief');
      canvas.width = canvas.height = TILE;
      const zo = this.options.zoomOffset || 0;
      const tz = coords.z + zo;                // tileSize 128 + zoomOffset 1 => one DEM tile each
      const k = key(coords);
      const rec = {coords: {x: coords.x, y: coords.y, z: coords.z}, tz, canvas,
                   rr: TILE / this.getTileSize().x, ready: false, dirty: false};
      recs.set(k, rec);

      loadRaster(tz, coords.x, coords.y).then((r) => {
        Object.assign(rec, r);
        rec.ready = true;
        if (recs.get(k) === rec) rangeSoon();
        shadeRec(rec);
        done(null, canvas);                    // always: Leaflet hangs on 'loading' otherwise
      }).catch((e) => {
        rec.failed = true;
        tileFailed(e);
        done(e, canvas);                       // err keeps the tile hidden, no blank-screen throw
      });
      return canvas;
    },
  });

  // ---- map + layers ----
  const map = L.map(container, {
    center: [num(state.lat, 51.412172), num(state.lon, -0.022933)],
    zoom: clamp(Math.round(num(state.zoom, 14)), 2, 19),
    minZoom: 2, maxZoom: 19,
    zoomControl: false, attributionControl: true,
    preferCanvas: true, worldCopyJump: true,
    zoomAnimation: true, fadeAnimation: true,
  });
  L.control.zoom({position: 'topleft'}).addTo(map);

  function buildBase() {
    const src = BASEMAPS[o.basemap] || BASEMAPS.light;
    const retina = !!(o.hiRes && L.Browser.retina);
    const url = useDirect ? src.direct : `/tile/${src.path}/{z}/{x}/{y}`;
    const next = L.tileLayer(url, {
      minZoom: 2, maxZoom: 20,
      // detectRetina asks for z+1 tiles, so the source's own cap drops by one
      maxNativeZoom: src.maxZoom - (retina ? 1 : 0),
      detectRetina: retina,
      crossOrigin: useDirect ? 'anonymous' : undefined,
      className: 'm2d-base', zIndex: 1, keepBuffer: 2, updateWhenZooming: false,
      attribution: `${src.attr} &middot; elevation: ` +
        '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" ' +
        'rel="noopener">Terrain Tiles</a>',
    });
    let errs = 0;
    next.on('tileerror', () => {
      if (useDirect || ++errs < 4) return;
      useDirect = true;                        // proxy is down or we are served elsewhere
      window.reliefStatus?.('tile proxy unavailable — fetching tiles direct', true);
      buildBase();
    });
    next.addTo(map);
    if (base) map.removeLayer(base);
    base = next;
  }

  function buildRelief() {
    if (relief) { relief.off(); map.removeLayer(relief); }
    for (const rec of recs.values()) rec.dead = true;
    recs.clear();
    const retina = !!(o.hiRes && L.Browser.retina);
    relief = new ReliefLayer({
      tileSize: retina ? TILE / 2 : TILE,      // half-size CSS tiles => full-res DEM on HiDPI
      zoomOffset: retina ? 1 : 0,
      minZoom: 2, maxZoom: 19,
      // past DEM z15 there is no new detail; let Leaflet stretch beyond +2 rather than
      // shade four times as many tiles for nothing
      maxNativeZoom: Math.min(19, MAXZ + 2) - (retina ? 1 : 0),
      opacity: clamp(num(o.reliefOpacity, 1), 0, 1),
      zIndex: 2, className: 'm2d-relief-pane',
      keepBuffer: 1, updateWhenZooming: false,
    });
    relief.on('tileunload', (e) => {
      const c = relief._wrapCoords ? relief._wrapCoords(e.coords) : e.coords;
      const rec = recs.get(key(c));
      if (!rec || (e.tile && rec.canvas !== e.tile)) return;   // a world-copy twin, not ours
      recs.delete(key(c));
      rec.dead = true;
      rec.data = rec.slope = rec.contours = null;              // dem.js keeps its own LRU
    });
    relief.addTo(map);
  }

  let rangeT = 0;
  function rangeSoon() {
    if (rangeT) return;
    rangeT = setTimeout(() => {
      rangeT = 0;
      const changed = refreshRange();
      if (changed && (o.layers.hypso || (o.layers.contours && !o.contourInterval))) markAll();
    }, 140);
  }

  buildBase();
  buildRelief();

  // ---- hover readout: elevation + true local gradient under the cursor ----
  let hoverLL = null, hoverRaf = 0;
  function readout() {
    hoverRaf = 0;
    if (!hoverLL || !relief || relief._tileZoom == null) return;
    const z = relief._tileZoom, ts = relief.getTileSize().x;
    const p = map.project(hoverLL, z);
    const tx = Math.floor(p.x / ts), ty = Math.floor(p.y / ts);
    const rec = recs.get(`${z}/${tx}/${ty}`);
    if (!rec || !rec.ready || !rec.data) { pushReadout(''); return; }
    const fx = clamp((p.x / ts - tx) * TILE, 0, TILE - 1);
    const fy = clamp((p.y / ts - ty) * TILE, 0, TILE - 1);
    const px = Math.round(fx), py = Math.round(fy);
    const {data, size, pad} = rec;

    // bilinear elevation (x0+1 / y0+1 may fall in the halo — that is real neighbour data)
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const gx = fx - x0, gy = fy - y0;
    const rowA = (y0 + pad) * size + pad, rowB = rowA + size;
    const e00 = data[rowA + x0], e10 = data[rowA + x0 + 1];
    const e01 = data[rowB + x0], e11 = data[rowB + x0 + 1];
    const elev = e00 + (e10 - e00) * gx + (e01 - e00) * gy + (e00 - e10 - e01 + e11) * gx * gy;

    // Gradient from the same kernel the map uses, on a 3x3 window around the cursor: a
    // subarray view makes the padded tile look like a 1x1 raster with pad 1. zFactor stays 1,
    // so the number a human reads is never touched by the exaggeration slider.
    let pct = NaN;
    if (rec.slope) {
      pct = rec.slope[py * TILE + px];
    } else {
      const base = (py - 1 + pad) * size + (px - 1 + pad);
      if (base >= 0 && base + 2 * size + 2 < data.length) {
        try {
          pct = shade.slopePercent(data.subarray(base), 1, 1,
                                   {size, pad: 1, mpp: rec.mppRow[py]})[0];
        } catch { /* readout is a nicety, never a failure */ }
      }
    }

    const imp = o.units === 'imperial';
    const ev = imp ? `${Math.round(elev * 3.28084)} ft` : `${Math.round(elev)} m`;
    let html = `<b>${ev}</b>`;
    let plain = ev;
    if (Number.isFinite(pct)) {
      const band = bandFor(pct);
      html += `  <b>${pct.toFixed(1)}%</b>` + (band ? ` ${band.hint || ''}` : '');
      plain += `  ${pct.toFixed(1)}%`;
    }
    const soft = rec.demZ < rec.tz ? ` z${rec.demZ}↑` : '';
    html += `  <span class="m2d-dim">${hoverLL.lat.toFixed(5)}, ${hoverLL.lng.toFixed(5)}` +
            `${soft}</span>`;
    pushReadout(html, plain);
  }
  function bandFor(pct) {
    const bands = shade.GRADIENT_BANDS || [];
    for (let i = bands.length - 1; i >= 0; i--) if (pct >= bands[i].min) return bands[i];
    return null;
  }
  map.on('mousemove', (e) => {
    hoverLL = e.latlng;
    if (!hoverRaf) hoverRaf = requestAnimationFrame(readout);
  });
  map.on('mouseout', () => { hoverLL = null; pushReadout(''); });

  // ---- movement reporting ----
  map.on('moveend', () => {
    const c = map.getCenter().wrap();
    onStateChange?.({lon: c.lng, lat: c.lat, zoom: map.getZoom()});
    rangeSoon();
  });
  map.on('zoomend', rangeSoon);

  // ---- scale bar (units follow the shell) ----
  function buildScale() {
    if (scaleCtl) map.removeControl(scaleCtl);
    scaleCtl = L.control.scale({position: 'bottomleft', maxWidth: 140,
                                metric: o.units !== 'imperial', imperial: o.units === 'imperial'});
    scaleCtl.addTo(map);
  }
  buildScale();

  // ---- 2D-only extras in the shell's panel slot ----
  buildExtraPanel();
  function buildExtraPanel() {
    const host = document.getElementById('panel-2d-extra');
    if (!host) return;
    const retinaRow = (L.Browser && L.Browser.retina)
      ? `<label class="row"><input type="checkbox" id="m2dHi" checked>
           <span>Hi-res relief</span></label>` : '';
    host.innerHTML = `
      <div class="m2d-extra">
        <div class="slider">
          <div class="lab"><span>Relief opacity</span><b id="m2dOpVal">100%</b></div>
          <input id="m2dOp" type="range" min="20" max="100" step="5" value="100">
        </div>
        <div class="slider">
          <div class="lab"><span>Band strength</span><b id="m2dGsVal">1.0×</b></div>
          <input id="m2dGs" type="range" min="20" max="150" step="10" value="100">
        </div>
        <div class="m2d-line">
          <label for="m2dIv">Contour interval</label>
          <select id="m2dIv">
            <option value="0">Auto</option><option value="5">5 m</option>
            <option value="10">10 m</option><option value="25">25 m</option>
            <option value="50">50 m</option><option value="100">100 m</option>
          </select>
        </div>
        ${retinaRow}
      </div>`;
    const $ = (id) => document.getElementById(id);
    const fill = (el) => el.style.setProperty('--pct',
      `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
    const op = $('m2dOp'), gs = $('m2dGs'), iv = $('m2dIv'), hi = $('m2dHi');
    fill(op); fill(gs);
    op.addEventListener('input', () => {
      fill(op); $('m2dOpVal').textContent = `${op.value}%`;
      api.setOptions({reliefOpacity: +op.value / 100});
    });
    gs.addEventListener('input', () => {
      fill(gs); $('m2dGsVal').textContent = `${(+gs.value / 100).toFixed(1)}×`;
      api.setOptions({gradientStrength: +gs.value / 100});
    });
    iv.addEventListener('change', () => api.setOptions({contourInterval: +iv.value}));
    hi?.addEventListener('change', () => api.setOptions({hiRes: hi.checked}));
  }

  // ---- API ----
  function syncFromState() {
    const lat = num(state.lat, null), lon = num(state.lon, null);
    if (lat == null || lon == null) return;
    const c = map.getCenter();
    const z = clamp(Math.round(num(state.zoom, map.getZoom())), 2, 19);
    if (Math.abs(c.lat - lat) > 1e-7 || Math.abs(c.lng - lon) > 1e-7 || map.getZoom() !== z) {
      map.setView([lat, lon], z, {animate: false});
    }
  }

  const api = {
    show() {
      hidden = false;
      requestAnimationFrame(() => {
        map.invalidateSize(false);
        syncFromState();
        schedule(0);
      });
    },
    hide() {
      hidden = true;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      pushReadout('');
    },
    setExaggeration(z) {
      const v = clamp(num(z, o.zFactor), 0.1, 60);
      if (v === o.zFactor) return;
      o.zFactor = v;
      if (o.layers.hillshade) markAll();       // nothing else depends on it
    },
    setOptions(p = {}) {
      let dirty = false;
      if (p.basemap && BASEMAPS[p.basemap] && p.basemap !== o.basemap) {
        o.basemap = p.basemap;
        buildBase();
        if (o.layers.contours) dirty = true;   // contour ink follows the basemap's darkness
      }
      if (p.layers) {
        const was = o.layers;
        o.layers = {...was, ...p.layers};
        if (!o.layers.gradient) for (const r of recs.values()) r.slope = null;
        if (!o.layers.contours) for (const r of recs.values()) r.contours = null;
        for (const k of ['hillshade', 'multi', 'gradient', 'hypso', 'contours']) {
          if (!!was[k] !== !!o.layers[k]) dirty = true;
        }
        if (o.layers.hypso || o.layers.contours) refreshRange();
      }
      if (p.sunAz != null && num(p.sunAz, o.sunAz) !== o.sunAz) {
        o.sunAz = num(p.sunAz, o.sunAz); dirty = dirty || o.layers.hillshade;
      }
      if (p.sunAlt != null) {
        const v = clamp(num(p.sunAlt, o.sunAlt), 1, 89);
        if (v !== o.sunAlt) { o.sunAlt = v; dirty = dirty || o.layers.hillshade; }
      }
      if (p.units && p.units !== o.units) {
        o.units = p.units === 'imperial' ? 'imperial' : 'metric';
        buildScale();
        readout();
      }
      if (p.reliefOpacity != null) {
        o.reliefOpacity = clamp(num(p.reliefOpacity, 1), 0, 1);
        relief.setOpacity(o.reliefOpacity);
      }
      if (p.gradientStrength != null) {
        o.gradientStrength = clamp(num(p.gradientStrength, 1), 0, 2);
        gLut = null;
        dirty = dirty || o.layers.gradient;
      }
      if (p.hypsoAlpha != null) {
        o.hypsoAlpha = clamp(num(p.hypsoAlpha, 0.72), 0, 1);
        dirty = dirty || o.layers.hypso;
      }
      if (p.contourInterval != null) {
        o.contourInterval = Math.max(0, num(p.contourInterval, 0));
        dirty = dirty || o.layers.contours;
      }
      if (p.contourLabels != null) {
        o.contourLabels = !!p.contourLabels;
        dirty = dirty || o.layers.contours;
      }
      if (p.hiRes != null && !!p.hiRes !== o.hiRes) {
        o.hiRes = !!p.hiRes;
        buildBase();
        buildRelief();                         // tileSize cannot change on a live GridLayer
        dirty = false;
      }
      if (dirty) markAll();
    },
    setView(lon, lat, zoom) {
      if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) return;
      map.setView([+lat, +lon], clamp(Math.round(num(zoom, map.getZoom())), 2, 19),
                  {animate: false});
    },
    getBounds() { return map.getBounds(); },
    getMap() { return map; },
    invalidate() {
      map.invalidateSize(false);
      refreshRange();
      markAll();
    },
  };
  return api;
}
