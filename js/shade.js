// Pure raster relief kernels — no DOM, no imports, so this file also runs under Node
// (see test/core.test.mjs).
//
// Conventions used throughout:
//   x increases EAST, y increases SOUTH (raster row order), z is metres.
//   Zx = dz/d(east)  — rise per metre eastward
//   Zn = dz/d(north) — rise per metre northward  =  -(dz/d(row))
//
// Rasters are padded: the caller passes a (w + 2*pad) x (h + 2*pad) grid so that the
// 3x3 Horn window has real neighbour data at the tile border and shading has no seams.
// Outputs are always unpadded, length w*h, row-major.

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// Horn's 3x3 gradient estimator.
//
// Rather than ESRI's slope/aspect decomposition we hand (Zx, Zn) straight to the
// caller and shade with a normal-dot-light product. It is the same maths, but the
// sign conventions are self-evident instead of hidden in an aspect-to-compass
// conversion, which is where hillshade implementations usually go wrong.
// ---------------------------------------------------------------------------
function eachGradient(elev, w, h, opts, fn) {
  const pad = opts.pad ?? 1;
  const size = opts.size ?? (w + 2 * pad);
  const {mppRow, mpp} = opts;
  if (!mppRow && !(mpp > 0)) throw new Error('shade: need opts.mpp or opts.mppRow');

  if (pad >= 1) {
    for (let y = 0; y < h; y++) {
      const m = mppRow ? mppRow[y] : mpp;
      const inv = 1 / (8 * m);
      const r0 = (y + pad - 1) * size + pad;   // northern row of the window, at x = 0
      const r1 = r0 + size;
      const r2 = r1 + size;
      for (let x = 0; x < w; x++) {
        const a = elev[r0 + x - 1], b = elev[r0 + x], c = elev[r0 + x + 1];
        const d = elev[r1 + x - 1], /* centre */      f = elev[r1 + x + 1];
        const g = elev[r2 + x - 1], hh = elev[r2 + x], i = elev[r2 + x + 1];
        // east minus west, and north minus south (y grows southward, so r0 is north)
        const Zx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv;
        const Zn = ((a + 2 * b + c) - (g + 2 * hh + i)) * inv;
        fn(y * w + x, Zx, Zn);
      }
    }
    return;
  }

  // pad === 0: clamp at the edges. Slower, and it produces a faint seam at tile
  // borders, so callers that care pass pad >= 1.
  const at = (x, y) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return elev[cy * size + cx];
  };
  for (let y = 0; y < h; y++) {
    const m = mppRow ? mppRow[y] : mpp;
    const inv = 1 / (8 * m);
    for (let x = 0; x < w; x++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
      const d = at(x - 1, y),                       f = at(x + 1, y);
      const g = at(x - 1, y + 1), hh = at(x, y + 1), i = at(x + 1, y + 1);
      const Zx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv;
      const Zn = ((a + 2 * b + c) - (g + 2 * hh + i)) * inv;
      fn(y * w + x, Zx, Zn);
    }
  }
}

// Unit vector pointing TOWARDS the light, in (east, north, up).
function lightVec(azimuthDeg, altitudeDeg) {
  const a = azimuthDeg * D2R, alt = altitudeDeg * D2R;
  const ca = Math.cos(alt);
  return [Math.sin(a) * ca, Math.cos(a) * ca, Math.sin(alt)];
}

/**
 * Lambertian hillshade, 0..1.
 * opts: {size, pad, mpp | mppRow, zFactor=1, azimuth=315, altitude=45,
 *        multiDirectional=false}
 *
 * zFactor exaggerates the surface before lighting it — that is the whole point of
 * this app. It never touches the slope/gradient kernels below.
 */
export function hillshade(elev, w, h, opts = {}) {
  const {zFactor = 1, azimuth = 315, altitude = 45, multiDirectional = false} = opts;
  const out = new Float32Array(w * h);

  // Multi-directional light keeps lee slopes readable instead of crushing them to
  // black once zFactor is cranked up. Weights sum to 1.
  const lights = multiDirectional
    ? [[225, 0.2], [270, 0.3], [315, 0.3], [360, 0.2]].map(([off, wt]) =>
        [lightVec(azimuth + off - 315, altitude), wt])
    : [[lightVec(azimuth, altitude), 1]];

  eachGradient(elev, w, h, opts, (i, Zx, Zn) => {
    const zx = Zx * zFactor, zn = Zn * zFactor;
    // surface normal (east, north, up), unnormalised
    const nx = -zx, ny = -zn, nz = 1;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    let s = 0;
    for (const [L, wt] of lights) {
      const d = (nx * L[0] + ny * L[1] + nz * L[2]) * inv;
      s += wt * (d > 0 ? d : 0);
    }
    out[i] = s > 1 ? 1 : s;
  });
  return out;
}

/** Slope as rise/run percent. Ignores zFactor — a number a human reads must be true. */
export function slopePercent(elev, w, h, opts = {}) {
  const out = new Float32Array(w * h);
  eachGradient(elev, w, h, opts, (i, Zx, Zn) => {
    out[i] = Math.sqrt(Zx * Zx + Zn * Zn) * 100;
  });
  return out;
}

/** Slope in degrees. Ignores zFactor, as above. */
export function slopeDegrees(elev, w, h, opts = {}) {
  const out = new Float32Array(w * h);
  eachGradient(elev, w, h, opts, (i, Zx, Zn) => {
    out[i] = Math.atan(Math.sqrt(Zx * Zx + Zn * Zn)) / D2R;
  });
  return out;
}

/**
 * Aspect: the compass bearing the slope faces (i.e. the downhill direction),
 * 0 = north, increasing clockwise. Flat cells report -1.
 */
export function aspectDegrees(elev, w, h, opts = {}) {
  const out = new Float32Array(w * h);
  eachGradient(elev, w, h, opts, (i, Zx, Zn) => {
    if (Zx === 0 && Zn === 0) { out[i] = -1; return; }
    // downhill horizontal direction is (-Zx, -Zn) in (east, north)
    let deg = Math.atan2(-Zx, -Zn) / D2R;
    out[i] = deg < 0 ? deg + 360 : deg;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Colour ramps
// ---------------------------------------------------------------------------

// Low green -> tan -> brown -> grey-white. Deliberately muted: it sits *under* the
// hillshade multiply, so saturated stops would fight the relief.
const HYPSO_STOPS = [
  [0.00, [ 74, 106,  74]],
  [0.18, [116, 141,  86]],
  [0.38, [173, 166, 110]],
  [0.58, [166, 132,  92]],
  [0.76, [140, 110,  96]],
  [0.90, [170, 165, 165]],
  [1.00, [236, 238, 242]],
];

/** Hypsometric tint for `metres` within the [lo, hi] range present in view. */
export function hypsoColor(metres, lo, hi) {
  const span = hi - lo;
  let t = span > 1e-6 ? (metres - lo) / span : 0.5;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < HYPSO_STOPS.length; i++) {
    const [t1, c1] = HYPSO_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = HYPSO_STOPS[i - 1];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f,
              c0[1] + (c1[1] - c0[1]) * f,
              c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return HYPSO_STOPS[HYPSO_STOPS.length - 1][1].slice();
}

/**
 * Cycling gradient bands. Alpha rises with severity so gentle ground stays legible
 * and only the genuinely steep shouts. Band 0 exists for the legend but is not
 * painted (see gradientBandColor).
 */
export const GRADIENT_BANDS = [
  {min: 0,  max: 3,        color: [122, 176, 116], alpha: 0.00, label: '0–3%',   hint: 'flat-ish'},
  {min: 3,  max: 6,        color: [235, 205,  90], alpha: 0.35, label: '3–6%',   hint: 'noticeable'},
  {min: 6,  max: 9,        color: [240, 150,  60], alpha: 0.46, label: '6–9%',   hint: 'a climb'},
  {min: 9,  max: 12,       color: [225,  85,  60], alpha: 0.56, label: '9–12%',  hint: 'hard'},
  {min: 12, max: 15,       color: [170,  40,  70], alpha: 0.66, label: '12–15%', hint: 'brutal'},
  {min: 15, max: Infinity, color: [110,  40, 120], alpha: 0.76, label: '15%+',   hint: 'walk it'},
];

/** Band for a gradient, as [r, g, b, a]; null below 3% so flat ground is left alone. */
export function gradientBandColor(pct) {
  if (!(pct >= GRADIENT_BANDS[1].min)) return null;   // also catches NaN
  for (let i = GRADIENT_BANDS.length - 1; i >= 1; i--) {
    const b = GRADIENT_BANDS[i];
    if (pct >= b.min) return [b.color[0], b.color[1], b.color[2], b.alpha];
  }
  return null;
}

/** The band object itself, for labelling a readout. Always returns something. */
export function gradientBand(pct) {
  for (let i = GRADIENT_BANDS.length - 1; i >= 0; i--) {
    if (pct >= GRADIENT_BANDS[i].min) return GRADIENT_BANDS[i];
  }
  return GRADIENT_BANDS[0];
}

// ---------------------------------------------------------------------------
// Contours (marching squares)
// ---------------------------------------------------------------------------

/** Metre interval that yields roughly 10–20 lines without turning to mush. */
export function contourInterval(mapZoom, relief = 100) {
  const ladder = [200, 100, 50, 25, 20, 10, 5];
  const target = Math.max(5, relief / 12);
  const byRelief = ladder.find((v) => v <= target) ?? 5;
  const byZoom = mapZoom >= 14 ? 5 : mapZoom >= 12 ? 10 : mapZoom >= 10 ? 25 : 50;
  return Math.max(byRelief, byZoom);
}

/**
 * Marching squares over the padded grid.
 * opts: {size, pad, interval, min, max}
 * Returns [{level, segs: Float32Array([x0,y0,x1,y1, ...])}], coordinates in
 * unpadded pixel space (so they line up with the shading output).
 */
export function contourSegments(elev, w, h, opts = {}) {
  const pad = opts.pad ?? 1;
  const size = opts.size ?? (w + 2 * pad);
  const interval = opts.interval || 10;

  let lo = opts.min, hi = opts.max;
  if (lo == null || hi == null) {
    lo = Infinity; hi = -Infinity;
    for (let y = 0; y < h; y++) {
      const r = (y + pad) * size + pad;
      for (let x = 0; x < w; x++) {
        const v = elev[r + x];
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9) return [];

  const first = Math.ceil(lo / interval) * interval;
  const out = [];
  for (let level = first; level <= hi; level += interval) {
    const segs = [];
    // one cell per (x, y) pair of neighbouring samples
    for (let y = 0; y < h - 1; y++) {
      const rt = (y + pad) * size + pad;
      const rb = rt + size;
      for (let x = 0; x < w - 1; x++) {
        const tl = elev[rt + x], tr = elev[rt + x + 1];
        const bl = elev[rb + x], br = elev[rb + x + 1];
        if (!(Number.isFinite(tl) && Number.isFinite(tr) &&
              Number.isFinite(bl) && Number.isFinite(br))) continue;

        const code = (tl > level ? 8 : 0) | (tr > level ? 4 : 0) |
                     (br > level ? 2 : 0) | (bl > level ? 1 : 0);
        if (code === 0 || code === 15) continue;

        // crossing points on each edge, lazily
        const top    = () => [x + (level - tl) / (tr - tl), y];
        const right  = () => [x + 1, y + (level - tr) / (br - tr)];
        const bottom = () => [x + (level - bl) / (br - bl), y + 1];
        const left   = () => [x, y + (level - tl) / (bl - tl)];
        const push = (p, q) => segs.push(p[0], p[1], q[0], q[1]);

        switch (code) {
          case 1: case 14: push(left(), bottom()); break;
          case 2: case 13: push(bottom(), right()); break;
          case 3: case 12: push(left(), right()); break;
          case 4: case 11: push(top(), right()); break;
          case 6: case  9: push(top(), bottom()); break;
          case 7: case  8: push(top(), left()); break;
          // saddles: resolve with the cell-centre average
          case 5:
            if ((tl + tr + br + bl) / 4 > level) { push(top(), right()); push(bottom(), left()); }
            else { push(top(), left()); push(bottom(), right()); }
            break;
          case 10:
            if ((tl + tr + br + bl) / 4 > level) { push(top(), left()); push(bottom(), right()); }
            else { push(top(), right()); push(bottom(), left()); }
            break;
        }
      }
    }
    if (segs.length) out.push({level, segs: new Float32Array(segs)});
  }
  return out;
}
