// Route profile: draw a line on the 2D map, get the elevation and the gradients
// that actually hurt. This is the module that turns pretty relief into a cycling
// tool, so its numbers have to be trustworthy:
//
//   * every figure comes from true elevation at zFactor 1 (CONTRACT §0.2) — the
//     exaggeration sliders touch shading and geometry, never a printed gradient;
//   * the headline figure is the steepest *sustained* 100 m, because a spike
//     between two 25 m samples is DEM quantisation, not a hill;
//   * total ascent uses a 2 m deadband so noise cannot inflate the climbing.
//
// Sampling is batched: one getRegion() mosaic over the line's bbox, sampled
// bilinearly, instead of one elevationAt() request per 25 m.

import * as dem from './dem.js';
import {GRADIENT_BANDS} from './shade.js';

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------
const SAMPLE_M = 25;          // nominal spacing of samples along the line
const MAX_SAMPLES = 4000;     // cap, so a 300 km line still draws instantly
const SUSTAIN_M = 100;        // window for the headline "steepest sustained" figure
const SMOOTH_M = 75;          // moving-average window for stats + the drawn line
const ASCENT_DEADBAND_M = 2;  // reversals smaller than this are noise, not terrain
const GRAD_WINDOW_M = 60;     // window used to colour a stretch by gradient
const MIN_RUN_M = 45;         // shorter band runs are folded into their neighbour
const REGION_PX_BUDGET = 3.2e6;   // ~13 MB of Float32 — keeps a long line sane
const REGION_TILE_BUDGET = 64;
const FALLBACK_POINTS = 96;   // single-point reads if the mosaic fails outright
const HOVER_PX = 15;          // how near the cursor must be to the line to hover
const PAD = {l: 42, r: 10, t: 12, b: 18};   // chart gutters, CSS px

const R_EARTH = 6371008.8;    // mean radius, metres
const M_FT = 3.280839895;
const M_MI = 1 / 1609.344;
const D2R = Math.PI / 180;

// The palette always comes from shade.js so the chart, the panel legend and the
// map's gradient tint cannot drift apart. The neutral stand-in only exists so a
// missing export degrades to a grey chart instead of a blank panel.
const BANDS = (Array.isArray(GRADIENT_BANDS) && GRADIENT_BANDS.length)
  ? GRADIENT_BANDS
  : [{min: 0, max: Infinity, color: [120, 140, 160], label: '', hint: ''}];

const status = (msg, err) => window.reliefStatus?.(msg, err);

// ---------------------------------------------------------------------------
// pure geometry / statistics — no DOM, no Leaflet, all hand-checkable
// ---------------------------------------------------------------------------

/** Great-circle distance in metres. */
function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Linear interpolation of an elevation series at an arbitrary distance. */
function elevAtDist(dist, elev, d) {
  const n = dist.length;
  if (!(n > 0)) return NaN;
  if (d <= dist[0]) return elev[0];
  if (d >= dist[n - 1]) return elev[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid; else hi = mid;
  }
  const span = dist[hi] - dist[lo];
  return span > 0 ? elev[lo] + (elev[hi] - elev[lo]) * (d - dist[lo]) / span : elev[lo];
}

/**
 * Moving average over a *distance* window. Terrarium quantises to 1/256 m on top
 * of ~30 m source data, so the raw series stair-steps; 75 m is far shorter than
 * any hill worth naming, so smoothing costs no real terrain but stops the
 * gradient bands strobing.
 */
function smoothByDistance(dist, elev, windowM) {
  const n = elev.length, out = new Float64Array(n);
  if (n < 3) { for (let i = 0; i < n; i++) out[i] = elev[i]; return out; }

  // buildTrack samples at a constant step, so a symmetric index window is exact
  const step = (dist[n - 1] - dist[0]) / (n - 1);
  const k = step > 0 ? Math.round(windowM / 2 / step) : 0;
  if (k < 1) { for (let i = 0; i < n; i++) out[i] = elev[i]; return out; }

  // Past each end, reflect *antisymmetrically*: e(-d) = 2*e(0) - e(+d), which is the
  // linear continuation of the series. A plain mirror (or a shrinking one-sided
  // window) would flatten the first and last stretch — precisely the gradient you
  // care about at the foot of a climb.
  const at = (j) => {
    if (j < 0) return 2 * elev[0] - elev[Math.min(n - 1, -j)];
    if (j > n - 1) return 2 * elev[n - 1] - elev[Math.max(0, 2 * (n - 1) - j)];
    return elev[j];
  };
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i - k; j <= i + k; j++) sum += at(j);
    out[i] = sum / (2 * k + 1);
  }
  return out;
}

/**
 * Ascent/descent with a deadband. Climbing, the reference tracks the running
 * high point and every rise counts; the direction only flips once the series has
 * dropped `dead` metres off that high point, and then the whole drop counts. A
 * real climb is therefore counted in full, while a ±1 m sawtooth of DEM noise
 * contributes once and nothing after.
 */
function ascentDescent(elev, dead) {
  let asc = 0, desc = 0, ref = elev[0], up = true;
  for (let i = 1; i < elev.length; i++) {
    const d = elev[i] - ref;
    if (up) {
      if (d > 0) { asc += d; ref = elev[i]; }
      else if (d <= -dead) { desc -= d; ref = elev[i]; up = false; }
    } else {
      if (d < 0) { desc -= d; ref = elev[i]; }
      else if (d >= dead) { asc += d; ref = elev[i]; up = true; }
    }
  }
  return {asc, desc};
}

/**
 * Steepest climb sustained over `windowM`, interpolated to exactly that length so
 * the answer is never flattered by a 100–125 m window. Windows that would run off
 * the end are skipped; a line shorter than the window is measured whole and
 * reports the length actually used.
 */
function maxSustained(dist, elev, windowM) {
  const n = dist.length, total = dist[n - 1];
  const w = Math.min(windowM, total);
  const none = {pct: 0, windowM: w, d0: 0, d1: w};
  if (!(w > 0)) return none;
  let best = -Infinity, bestD0 = 0;
  for (let i = 0; i < n - 1; i++) {
    const target = dist[i] + w;
    if (target > total + 1e-9) break;              // no full window left
    const g = (elevAtDist(dist, elev, target) - elev[i]) / w * 100;
    if (g > best) { best = g; bestD0 = dist[i]; }
  }
  if (!Number.isFinite(best)) return none;
  return {pct: best, windowM: w, d0: bestD0, d1: bestD0 + w};
}

/** Per-segment gradient (%) measured over a window centred on that segment. */
function segmentGradients(dist, elev) {
  const n = dist.length, total = dist[n - 1];
  const out = new Float32Array(Math.max(0, n - 1));
  const half = GRAD_WINDOW_M / 2;
  for (let i = 0; i < n - 1; i++) {
    const mid = (dist[i] + dist[i + 1]) / 2;
    const a = Math.max(0, mid - half), b = Math.min(total, mid + half);
    const run = b - a;
    out[i] = run > 1e-6
      ? (elevAtDist(dist, elev, b) - elevAtDist(dist, elev, a)) / run * 100
      : 0;
  }
  return out;
}

/** Bridge DEM holes linearly; returns how many samples were filled, -1 if none usable. */
function fillGaps(elev) {
  const n = elev.length;
  let first = -1, last = -1, bad = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(elev[i])) { if (first < 0) first = i; last = i; } else bad++;
  }
  if (first < 0) return -1;
  for (let i = 0; i < first; i++) elev[i] = elev[first];
  for (let i = last + 1; i < n; i++) elev[i] = elev[last];
  let i = first;
  while (i <= last) {
    if (Number.isFinite(elev[i])) { i++; continue; }
    let j = i;
    while (!Number.isFinite(elev[j])) j++;
    const a = elev[i - 1], b = elev[j];
    for (let k = i; k < j; k++) elev[k] = a + (b - a) * (k - i + 1) / (j - i + 1);
    i = j + 1;
  }
  return bad;
}

// Pure helpers, exposed for test/profile.test.mjs. Not part of the module's contract.
export const _internals = {
  haversineM, elevAtDist, smoothByDistance, ascentDescent, maxSustained,
  segmentGradients, fillGaps,
  consts: {SAMPLE_M, SUSTAIN_M, SMOOTH_M, ASCENT_DEADBAND_M, GRAD_WINDOW_M},
};

/** Index into BANDS for a gradient; sign is irrelevant, steep is steep. */
function bandIndex(pct) {
  const p = Math.abs(pct);
  for (let i = BANDS.length - 1; i >= 0; i--) if (p >= BANDS[i].min) return i;
  return 0;
}

/** Runs of consecutive segments in the same band, with confetti folded away. */
function bandRuns(dist, grad) {
  const out = [];
  if (!grad.length) return out;
  let start = 0, band = bandIndex(grad[0]);
  for (let i = 1; i <= grad.length; i++) {
    const b = i < grad.length ? bandIndex(grad[i]) : -1;
    if (b === band) continue;
    if (out.length && dist[i] - dist[start] < MIN_RUN_M) out[out.length - 1].end = i;
    else out.push({start, end: i, band});
    start = i; band = b;
  }
  return out;
}

/** 1 / 2 / 2.5 / 5 / 10 ladder — the only intervals that read as "round". */
function niceStep(span, count) {
  const raw = Math.abs(span) / Math.max(1, count);
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

function tickList(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return out;
}

function fmtTick(v, step) {
  const dec = step >= 1 ? 0 : step >= 0.5 ? 1 : step >= 0.05 ? 2 : 3;
  return v.toFixed(dec);
}

// ---------------------------------------------------------------------------
// module factory
// ---------------------------------------------------------------------------
export function createProfile({getMap, container} = {}) {
  let units = 'metric';
  let active = false;
  let bindGen = 0;              // invalidates a pending "wait for the map" loop

  // route + derived data
  let verts = [];               // [{lat, lon}] — the vertices the user clicked
  let phase = 'idle';           // 'idle' | 'drawing' | 'done'
  let data = null;              // {dist, lat, lon, elev, raw, grad, stats, z, mpp, …}
  let hoverIdx = -1;
  let gen = 0;                  // supersedes in-flight sampling
  let abortCtl = null;
  let computeTimer = null;
  let lastAddAt = 0;
  let note = '';

  // Leaflet bits: everything lives in two layer groups so disable() can hand the
  // map back exactly as it was found.
  let map = null, mapRoot = null;
  let ribbonGroup = null, lineGroup = null;
  let line = null, preview = null, hoverDot = null;
  let vtxMarkers = [];
  let dczWasEnabled = false;

  // DOM
  let root = null, statsEl = null, chartEl = null, canvas = null, ctx = null,
      noteEl = null;
  let theme = {fg: '#e6edf6', dim: '#8b9bb0', accent: '#4fd1c5', line: '#2a3746',
               panel: '#141b26'};
  let drawQueued = false;

  // ---- units -------------------------------------------------------------
  function distUnit(totalM) {
    if (units === 'imperial') return totalM >= 640 ? {k: M_MI, name: 'mi'} : {k: M_FT, name: 'ft'};
    return totalM >= 1200 ? {k: 0.001, name: 'km'} : {k: 1, name: 'm'};
  }
  const elevUnit = () => (units === 'imperial' ? {k: M_FT, name: 'ft'} : {k: 1, name: 'm'});

  function fmtDist(m) {
    if (units === 'imperial') {
      const mi = m * M_MI;
      return mi >= 0.19 ? `${mi.toFixed(2)} mi` : `${Math.round(m * M_FT)} ft`;
    }
    return m >= 950 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km` : `${Math.round(m)} m`;
  }
  const fmtElev = (m) => (units === 'imperial' ? `${Math.round(m * M_FT)} ft`
                                               : `${Math.round(m)} m`);
  const fmtBare = (m) => String(units === 'imperial' ? Math.round(m * M_FT) : Math.round(m));
  const fmtPct = (p, signed) =>
    `${signed ? (p >= 0 ? '+' : '−') : ''}${Math.abs(p).toFixed(1)}%`;
  // The sustained window is physically 100 m whatever the units; imperial just
  // gets it relabelled (~330 ft) rather than redefined.
  const fmtLen = (m) => (units === 'imperial' ? `${Math.round(m * M_FT / 10) * 10} ft`
                                              : `${Math.round(m)} m`);

  // ---- DOM ---------------------------------------------------------------
  function buildDom() {
    if (!container) return;
    root = document.createElement('div');
    root.className = 'prof';
    root.innerHTML =
      '<div class="prof-empty">Click along a road to trace a route. ' +
      'Double-click or <b>Enter</b> finishes, <b>Esc</b> discards. ' +
      'Drag a point to move it, right-click one to delete.</div>' +
      '<div class="prof-stats"></div>' +
      '<div class="prof-chart"><canvas></canvas></div>' +
      '<div class="prof-note"></div>';
    container.appendChild(root);
    statsEl = root.querySelector('.prof-stats');
    chartEl = root.querySelector('.prof-chart');
    noteEl = root.querySelector('.prof-note');
    canvas = root.querySelector('canvas');
    ctx = canvas.getContext('2d');

    canvas.addEventListener('pointermove', onChartMove);
    canvas.addEventListener('pointerleave', onChartLeave);

    readTheme();
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => requestDraw()).observe(chartEl);
    }
    addEventListener('resize', requestDraw);
    watchDpr();
  }

  // devicePixelRatio changes when the window crosses monitors or the page is
  // zoomed; a canvas sized for the old ratio goes soft, so redraw and re-arm.
  function watchDpr() {
    if (!window.matchMedia) return;
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => { requestDraw(); watchDpr(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange, {once: true});
    else if (mq.addListener) mq.addListener(onChange);
  }

  function readTheme() {
    if (!root) return;
    const cs = getComputedStyle(root);
    const pick = (name, fb) => ((cs.getPropertyValue(name) || '').trim() || fb);
    theme = {
      fg: pick('--fg', theme.fg),
      dim: pick('--dim', theme.dim),
      accent: pick('--accent', theme.accent),
      line: pick('--line', theme.line),
      panel: pick('--panel-solid', theme.panel),
    };
  }

  // ---- sampling ----------------------------------------------------------

  /** Evenly spaced points along the polyline with cumulative haversine distance. */
  function buildTrack(vs) {
    const cum = [0];
    for (let i = 1; i < vs.length; i++) {
      cum.push(cum[i - 1] + haversineM(vs[i - 1].lat, vs[i - 1].lon, vs[i].lat, vs[i].lon));
    }
    const total = cum[cum.length - 1];
    if (!(total > 1)) return null;                  // two clicks in the same spot

    let n = Math.floor(total / SAMPLE_M) + 1;
    if (n > MAX_SAMPLES) n = MAX_SAMPLES;
    if (n < 2) n = 2;

    const dist = new Float64Array(n), lat = new Float64Array(n), lon = new Float64Array(n);
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const d = total * i / (n - 1);
      while (seg < vs.length - 2 && cum[seg + 1] < d) seg++;
      const span = cum[seg + 1] - cum[seg];
      const t = span > 0 ? Math.min(1, (d - cum[seg]) / span) : 0;
      dist[i] = d;
      lat[i] = vs[seg].lat + (vs[seg + 1].lat - vs[seg].lat) * t;
      lon[i] = vs[seg].lon + (vs[seg + 1].lon - vs[seg].lon) * t;
    }
    return {dist, lat, lon, total, step: total / (n - 1), n};
  }

  function trackBbox(track) {
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (let i = 0; i < track.n; i++) {
      if (track.lon[i] < west) west = track.lon[i];
      if (track.lon[i] > east) east = track.lon[i];
      if (track.lat[i] < south) south = track.lat[i];
      if (track.lat[i] > north) north = track.lat[i];
    }
    // Inflate so bilinear sampling at the ends still has neighbours, and so a
    // dead-straight N–S or E–W line does not ask for a zero-width region.
    const midLat = (south + north) / 2;
    const dLat = 80 / 111320;
    const dLon = 80 / (111320 * Math.max(0.2, Math.cos(midLat * D2R)));
    return {west: west - dLon, east: east + dLon, south: south - dLat, north: north + dLat};
  }

  /** Highest DEM zoom whose mosaic over `bbox` stays inside the budgets. */
  function pickRegionZoom(bbox) {
    const maxZ = dem.DEM_MAX_Z ?? 15;
    const px = dem.TILE_PX ?? 256;
    try {
      for (let z = maxZ; z > 8; z--) {
        const [x0, y0] = dem.lonLatToTile(bbox.west, bbox.north, z);
        const [x1, y1] = dem.lonLatToTile(bbox.east, bbox.south, z);
        const w = Math.max(2, Math.ceil((x1 - x0) * px));
        const h = Math.max(2, Math.ceil((y1 - y0) * px));
        const tiles = (Math.floor(x1) - Math.floor(x0) + 1) *
                      (Math.floor(y1) - Math.floor(y0) + 1);
        if (w * h <= REGION_PX_BUDGET && tiles <= REGION_TILE_BUDGET) return z;
      }
      return 9;
    } catch {
      return 13;                                    // shrug: a safe middle zoom
    }
  }

  /** Sample every point out of one region mosaic; fall back to point reads. */
  async function sampleElevations(track, signal) {
    const bbox = trackBbox(track);
    const z = pickRegionZoom(bbox);
    const n = track.n;
    const out = new Float64Array(n);

    let region = null, regionErr = null, lastMsg = 0;
    try {
      region = await dem.getRegion(bbox, z, {
        signal,
        onProgress: (done, total) => {
          const now = Date.now();
          if (now - lastMsg < 180) return;
          lastMsg = now;
          status(`profile: elevation tiles ${done}/${total}…`);
        },
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      regionErr = e;
    }

    if (region && typeof region.sample === 'function') {
      for (let i = 0; i < n; i++) out[i] = region.sample(track.lon[i], track.lat[i]);
      let mpp = null;
      try { mpp = dem.metresPerPixel((bbox.north + bbox.south) / 2, z); } catch {}
      return {elev: out, z, mpp, coarse: false};
    }

    // The mosaic failed: read a sparse set of single points instead so the user
    // still gets the shape of the route rather than an empty panel.
    if (regionErr) console.warn('[profile] region mosaic failed, using point reads', regionErr);
    const idx = [];
    const stride = Math.max(1, Math.ceil(n / FALLBACK_POINTS));
    for (let i = 0; i < n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);

    const got = new Array(idx.length);
    let next = 0;
    const worker = async () => {
      while (next < idx.length) {
        const k = next++;
        if (signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
        try { got[k] = await dem.elevationAt(track.lon[idx[k]], track.lat[idx[k]], z); }
        catch { got[k] = NaN; }
      }
    };
    await Promise.all(Array.from({length: 6}, worker));

    out.fill(NaN);
    for (let k = 0; k < idx.length; k++) out[idx[k]] = got[k];
    return {elev: out, z, mpp: null, coarse: true};   // fillGaps() bridges the rest
  }

  function scheduleCompute(delay = 180) {
    clearTimeout(computeTimer);
    computeTimer = setTimeout(compute, delay);
  }

  async function compute() {
    clearTimeout(computeTimer);
    const my = ++gen;
    abortCtl?.abort();
    abortCtl = new AbortController();
    const signal = abortCtl.signal;

    const vs = verts.slice();
    if (vs.length < 2) { data = null; paint(); return; }

    const track = buildTrack(vs);
    if (!track) {
      data = null;
      note = 'Those points are in the same place — nothing to profile.';
      paint();
      return;
    }

    try {
      const res = await sampleElevations(track, signal);
      if (my !== gen) return;

      const gaps = fillGaps(res.elev);
      if (gaps < 0) {
        data = null;
        note = 'No elevation data covers that line.';
        paint();
        status('profile: no elevation data for that line', true);
        return;
      }

      const raw = res.elev;
      const elev = smoothByDistance(track.dist, raw, SMOOTH_M);
      const stats = statsOf(track.dist, elev);
      const grad = segmentGradients(track.dist, elev);

      data = {...track, elev, raw, grad, stats, z: res.z, mpp: res.mpp,
              gaps, coarse: res.coarse};
      note = footnote(data);
      if (hoverIdx >= data.n) hoverIdx = -1;
      paint();
      paintRibbon();
      status(`profile: ${fmtDist(stats.total)}, ${fmtElev(stats.asc)} of climbing`);
    } catch (e) {
      if (e?.name === 'AbortError' || my !== gen) return;
      data = null;
      note = `Could not read elevation: ${e.message}`;
      paint();
      status(`profile: elevation failed — ${e.message}`, true);
    }
  }

  function statsOf(dist, elev) {
    const n = elev.length;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      if (elev[i] < min) min = elev[i];
      if (elev[i] > max) max = elev[i];
    }
    const {asc, desc} = ascentDescent(elev, ASCENT_DEADBAND_M);
    const total = dist[n - 1];
    const net = elev[n - 1] - elev[0];
    return {
      total, min, max, asc, desc, net,
      meanPct: total > 0 ? net / total * 100 : 0,
      sustain: maxSustained(dist, elev, SUSTAIN_M),
    };
  }

  function footnote(d) {
    const bits = [`every ${fmtLen(d.step)}`];
    bits.push(d.coarse
      ? `DEM mosaic unavailable, coarse point reads at z${d.z}`
      : `DEM z${d.z}${d.mpp ? ` ≈ ${d.mpp.toFixed(d.mpp < 10 ? 1 : 0)} m/px` : ''}`);
    bits.push(`smoothed over ${fmtLen(SMOOTH_M)}`);
    bits.push(`ascent ignores wobbles under ${fmtElev(ASCENT_DEADBAND_M)}`);
    if (d.gaps > 0) bits.push(`${d.gaps} sample${d.gaps > 1 ? 's' : ''} bridged over DEM holes`);
    bits.push('true elevation — exaggeration never changes these numbers');
    return bits.join(' · ');
  }

  // ---- panel: stats + chart ---------------------------------------------
  function paint() {
    if (!root) return;
    root.classList.toggle('has-route', !!data);
    paintStats();
    if (noteEl) noteEl.textContent = note;
    requestDraw();
  }

  function paintStats() {
    if (!statsEl) return;
    if (!data) { statsEl.textContent = ''; return; }
    const s = data.stats;
    const u = elevUnit().name;
    const hint = BANDS[bandIndex(s.sustain.pct)].hint || '';
    const tiles = [
      ['Length', fmtDist(s.total), ''],
      ['Ascent', `+${fmtBare(s.asc)}`, u],
      ['Descent', `−${fmtBare(s.desc)}`, u],
      ['Low–high', `${fmtBare(s.min)}–${fmtBare(s.max)}`, u],
      ['Mean grade', fmtPct(s.meanPct, true), ''],
      [`Steepest ${fmtLen(s.sustain.windowM)}`, fmtPct(s.sustain.pct), hint],
    ];
    statsEl.innerHTML = tiles.map(([k, v, sub]) =>
      `<div class="prof-stat"><span class="k">${k}</span><b>${v}` +
      `${sub ? ` <i>${sub}</i>` : ''}</b></div>`).join('');
  }

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function draw() {
    if (!canvas || !ctx || !chartEl) return;
    const cssW = chartEl.clientWidth, cssH = chartEl.clientHeight;
    if (!(cssW > 8 && cssH > 8)) return;                    // dock is closed
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const pxW = Math.round(cssW * dpr), pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) { canvas.width = pxW; canvas.height = pxH; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!data) return;

    const x0 = PAD.l, y0 = PAD.t;
    const pw = cssW - PAD.l - PAD.r, ph = cssH - PAD.t - PAD.b;
    if (!(pw > 24 && ph > 24)) return;
    const base = y0 + ph;

    const s = data.stats;
    const du = distUnit(s.total), eu = elevUnit();
    const totalD = s.total * du.k;

    // y domain: a 20 m floor stops a flat lane masquerading as an alp
    let loM = s.min, hiM = s.max;
    if (hiM - loM < 20) { const mid = (loM + hiM) / 2; loM = mid - 10; hiM = mid + 10; }
    const eStep = niceStep((hiM - loM) * eu.k, Math.max(2, Math.min(5, Math.floor(ph / 26))));
    const loD = Math.floor(loM * eu.k / eStep) * eStep;
    let hiD = Math.ceil(hiM * eu.k / eStep) * eStep;
    if (hiD - loD < eStep) hiD = loD + eStep;

    const xOf = (m) => x0 + (totalD > 0 ? (m * du.k) / totalD : 0) * pw;
    const yOf = (m) => y0 + (hiD - m * eu.k) / (hiD - loD) * ph;

    // --- grid under the fill, so the terrain reads as solid ground ---
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.line;
    ctx.fillStyle = theme.dim;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const v of tickList(loD, hiD, eStep)) {
      const y = Math.round(y0 + (hiD - v) / (hiD - loD) * ph) + 0.5;
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + pw, y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmtTick(v, eStep), x0 - 6, y);
    }
    const xStep = niceStep(totalD, Math.max(2, Math.min(8, Math.floor(pw / 64))));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of tickList(0, totalD, xStep)) {
      const x = Math.round(x0 + (totalD > 0 ? v / totalD : 0) * pw) + 0.5;
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, base); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmtTick(v, xStep), x, base + 4);
    }
    // unit captions live in the left gutter, out of the tick labels' way
    ctx.textAlign = 'left';
    ctx.fillText(du.name, 2, base + 4);
    ctx.textBaseline = 'middle';
    ctx.fillText(eu.name, 2, y0 - 5);

    // --- area fill, coloured per stretch by its gradient band ---
    const {dist, elev, grad} = data;
    for (const r of bandRuns(dist, grad)) {
      const c = BANDS[r.band].color;
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.88)`;
      ctx.beginPath();
      // start half a pixel early so neighbouring runs overlap instead of leaving
      // an antialiased hairline between them
      ctx.moveTo(Math.max(x0, xOf(dist[r.start]) - 0.5), base);
      for (let i = r.start; i <= r.end; i++) ctx.lineTo(xOf(dist[i]), yOf(elev[i]));
      ctx.lineTo(xOf(dist[r.end]), base);
      ctx.closePath();
      ctx.fill();
    }

    // --- the steepest sustained window ---
    if (s.sustain.pct > 0.5) {
      const sx0 = xOf(s.sustain.d0), sx1 = xOf(s.sustain.d1);
      ctx.fillStyle = '#ffffff14';
      ctx.fillRect(sx0, y0, Math.max(1.5, sx1 - sx0), ph);
      ctx.strokeStyle = '#ffffff55';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sx0 + 0.5, y0); ctx.lineTo(sx0 + 0.5, base);
      ctx.moveTo(sx1 - 0.5, y0); ctx.lineTo(sx1 - 0.5, base);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- the profile line ---
    ctx.strokeStyle = theme.fg;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < data.n; i++) {
      const x = xOf(dist[i]), y = yOf(elev[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // --- hover crosshair + readout ---
    if (hoverIdx >= 0 && hoverIdx < data.n) {
      const i = hoverIdx;
      const x = xOf(dist[i]), y = yOf(elev[i]);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, base); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent; ctx.fill();

      const g = grad.length ? grad[Math.min(i, grad.length - 1)] : 0;
      const label = `${fmtDist(dist[i])}   ${fmtElev(elev[i])}   ${fmtPct(g, true)}`;
      const tw = ctx.measureText(label).width + 14, th = 16, rr = 4;
      const tx = Math.min(Math.max(x0, x - tw / 2), x0 + pw - tw), ty = y0 + 1;
      ctx.fillStyle = theme.panel;
      ctx.globalAlpha = 0.94;
      ctx.beginPath();
      ctx.moveTo(tx + rr, ty);
      ctx.arcTo(tx + tw, ty, tx + tw, ty + th, rr);
      ctx.arcTo(tx + tw, ty + th, tx, ty + th, rr);
      ctx.arcTo(tx, ty + th, tx, ty, rr);
      ctx.arcTo(tx, ty, tx + tw, ty, rr);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.line; ctx.stroke();
      ctx.fillStyle = theme.fg;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, tx + tw / 2, ty + th / 2 + 0.5);
    }
  }

  // ---- map layers --------------------------------------------------------
  function rebuildLayers() {
    if (!map || !lineGroup) return;
    lineGroup.clearLayers();
    vtxMarkers = [];
    hoverDot = null;

    const lls = verts.map((v) => [v.lat, v.lon]);
    line = L.polyline(lls, {color: '#fff', weight: 2.5, opacity: 0.95,
                            interactive: false, className: 'prof-route'}).addTo(lineGroup);
    preview = L.polyline([], {color: '#fff', weight: 2, opacity: 0.55, dashArray: '4 5',
                              interactive: false}).addTo(lineGroup);

    verts.forEach((v, i) => {
      const mk = L.marker([v.lat, v.lon], {
        draggable: true, keyboard: false, bubblingMouseEvents: false,
        zIndexOffset: 900, riseOnHover: true,
        icon: L.divIcon({className: `prof-vtx${i === 0 ? ' first' : ''}`,
                         iconSize: [13, 13], iconAnchor: [6.5, 6.5]}),
      });
      mk.on('drag', () => {
        const ll = mk.getLatLng();
        verts[i] = {lat: ll.lat, lon: ll.lng};
        line.setLatLngs(verts.map((p) => [p.lat, p.lon]));
        scheduleCompute(260);
      });
      mk.on('dragend', () => compute());
      mk.on('contextmenu', (e) => { stopEvt(e); removeVertex(i); });
      mk.on('click', (e) => {
        stopEvt(e);
        if (phase === 'drawing' && i === verts.length - 1) finish();
      });
      mk.addTo(lineGroup);
      vtxMarkers.push(mk);
    });
  }

  /**
   * Gradient ribbon under the route, from the same GRADIENT_BANDS as the chart and
   * the map's tint. Bands below 3% are left unpainted, matching shade.js's policy
   * of not colouring flat ground; the white centre line keeps the route continuous.
   */
  function paintRibbon() {
    if (!map || !ribbonGroup) return;
    ribbonGroup.clearLayers();
    if (!data || data.n > 6000) return;
    for (const r of bandRuns(data.dist, data.grad)) {
      if (r.band < 1) continue;
      const c = BANDS[r.band].color;
      const lls = [];
      for (let i = r.start; i <= r.end; i++) lls.push([data.lat[i], data.lon[i]]);
      if (lls.length < 2) continue;
      L.polyline(lls, {color: `rgb(${c[0]},${c[1]},${c[2]})`, weight: 8, opacity: 0.8,
                       lineCap: 'butt', interactive: false}).addTo(ribbonGroup);
    }
  }

  function showMapDot(i) {
    if (!map || !lineGroup || !data) return;
    const ll = [data.lat[i], data.lon[i]];
    if (hoverDot) hoverDot.setLatLng(ll);
    else {
      hoverDot = L.circleMarker(ll, {radius: 5, weight: 2, color: '#fff',
                                     fillColor: theme.accent, fillOpacity: 1,
                                     interactive: false}).addTo(lineGroup);
    }
  }

  function hideMapDot() {
    if (hoverDot && lineGroup) { lineGroup.removeLayer(hoverDot); }
    hoverDot = null;
  }

  // ---- interaction -------------------------------------------------------
  const stopEvt = (e) => { if (e?.originalEvent) L.DomEvent.stop(e.originalEvent); };

  function nearestSample(lat, lon) {
    if (!data) return -1;
    // Planar approximation: over a route-sized extent Mercator is conformal enough
    // that the nearest sample in scaled lat/lon is the nearest one on screen.
    const cosLat = Math.cos(lat * D2R);
    let best = Infinity, bi = -1;
    for (let i = 0; i < data.n; i++) {
      const dx = (lon - data.lon[i]) * cosLat, dy = lat - data.lat[i];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; bi = i; }
    }
    return bi;
  }

  function onMapClick(e) {
    if (!active || !map) return;
    if (phase === 'done') resetRoute();             // a fresh click starts a new route
    const now = performance.now();
    const last = verts[verts.length - 1];
    if (last) {
      // Leaflet emits two clicks before a dblclick: drop the second if it landed on
      // the first. Doubles as the guard against a zero-length line.
      const p = map.latLngToContainerPoint([last.lat, last.lon]);
      if (p.distanceTo(e.containerPoint) < 14 && now - lastAddAt < 450) return;
    }
    lastAddAt = now;
    verts.push({lat: e.latlng.lat, lon: e.latlng.lng});
    phase = 'drawing';
    rebuildLayers();
    if (verts.length >= 2) scheduleCompute();
    else { note = 'Keep clicking along the road…'; paint(); }
  }

  function onMapDblClick(e) {
    if (!active) return;
    stopEvt(e);
    finish();
  }

  function onMapMove(e) {
    if (!active || !map) return;
    if (phase === 'drawing' && verts.length && preview) {
      const last = verts[verts.length - 1];
      preview.setLatLngs([[last.lat, last.lon], e.latlng]);
    }
    if (!data) return;
    const i = nearestSample(e.latlng.lat, e.latlng.lng);
    if (i < 0) return;
    const p = map.latLngToContainerPoint([data.lat[i], data.lon[i]]);
    if (p.distanceTo(e.containerPoint) <= HOVER_PX) {     // only when really on the line
      if (hoverIdx !== i) { hoverIdx = i; requestDraw(); }
      showMapDot(i);
    } else if (hoverIdx >= 0) {
      hoverIdx = -1; hideMapDot(); requestDraw();
    }
  }

  function onMapOut() {
    if (hoverIdx < 0) return;
    hoverIdx = -1; hideMapDot(); requestDraw();
  }

  function onChartMove(ev) {
    if (!data || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const pw = r.width - PAD.l - PAD.r;
    if (!(pw > 0)) return;
    const t = Math.min(1, Math.max(0, (ev.clientX - r.left - PAD.l) / pw));
    const i = Math.round(t * (data.n - 1));           // samples are evenly spaced
    if (i !== hoverIdx) { hoverIdx = i; requestDraw(); }
    showMapDot(i);
  }

  function onChartLeave() {
    if (hoverIdx < 0) return;
    hoverIdx = -1; hideMapDot(); requestDraw();
  }

  function onKey(e) {
    if (!active) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Enter' && phase === 'drawing') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') {
      if (!verts.length) return;
      e.preventDefault();
      clear();
      status('profile: route discarded');
    } else if ((e.key === 'Backspace' || e.key === 'Delete') &&
               phase === 'drawing' && verts.length) {
      e.preventDefault();
      removeVertex(verts.length - 1);
    }
  }

  function removeVertex(i) {
    if (i < 0 || i >= verts.length) return;
    verts.splice(i, 1);
    rebuildLayers();
    if (verts.length >= 2) { compute(); return; }
    gen++;                                            // orphan any in-flight sampling
    abortCtl?.abort();
    data = null; hoverIdx = -1;
    ribbonGroup?.clearLayers();
    if (!verts.length) phase = 'idle';
    note = verts.length ? 'Keep clicking along the road…' : '';
    paint();
  }

  function finish() {
    if (phase !== 'drawing') return;
    preview?.setLatLngs([]);
    if (verts.length < 2) { clear(); return; }
    phase = 'done';
    compute();
    status('profile: drag a point to adjust, right-click one to delete');
  }

  function resetRoute() {
    verts = [];
    phase = 'idle';
    data = null;
    hoverIdx = -1;
    note = '';
    gen++;
    abortCtl?.abort();
    ribbonGroup?.clearLayers();
    hideMapDot();
    rebuildLayers();
  }

  // ---- bind / unbind the map --------------------------------------------
  async function waitForMap(token) {
    for (let i = 0; i < 120; i++) {                   // ~12 s, then give up
      const m = getMap?.();
      if (m && typeof m.getContainer === 'function') return m;
      if (token !== bindGen || !active) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  function bind(m) {
    map = m;
    mapRoot = m.getContainer();
    ribbonGroup = L.layerGroup().addTo(m);            // added first → drawn under
    lineGroup = L.layerGroup().addTo(m);
    m.on('click', onMapClick);
    m.on('dblclick', onMapDblClick);
    m.on('mousemove', onMapMove);
    m.on('mouseout', onMapOut);
    dczWasEnabled = !!m.doubleClickZoom?.enabled();
    m.doubleClickZoom?.disable();                     // here dblclick means "finish"
    mapRoot.classList.add('prof-drawing');
    document.addEventListener('keydown', onKey);
    rebuildLayers();
    paintRibbon();
  }

  function unbind() {
    if (!map) return;
    map.off('click', onMapClick);
    map.off('dblclick', onMapDblClick);
    map.off('mousemove', onMapMove);
    map.off('mouseout', onMapOut);
    if (dczWasEnabled) map.doubleClickZoom?.enable();
    mapRoot?.classList.remove('prof-drawing');
    document.removeEventListener('keydown', onKey);
    for (const g of [ribbonGroup, lineGroup]) {
      try { if (g) map.removeLayer(g); } catch { /* already gone */ }
    }
    ribbonGroup = lineGroup = null;
    line = preview = hoverDot = null;
    vtxMarkers = [];
    map = null; mapRoot = null;
  }

  // ---- public API --------------------------------------------------------
  function enable() {
    if (active) return;
    if (typeof L === 'undefined') { status('profile: Leaflet is not loaded', true); return; }
    active = true;
    readTheme();
    paint();
    const token = ++bindGen;
    // getMap() can hand back undefined until the 2D module has built its map
    waitForMap(token).then((m) => {
      if (!active || token !== bindGen) return;
      if (!m) { active = false; status('profile: the 2D map is not ready yet', true); return; }
      bind(m);
      paint();
      status(verts.length >= 2
        ? 'profile: drag a point to adjust, right-click one to delete'
        : 'profile: click along a road, double-click to finish');
    });
  }

  function disable() {
    if (!active && !map) return;
    active = false;
    bindGen++;
    clearTimeout(computeTimer);
    // an unfinished one-point line is not worth keeping; a real one survives so
    // re-enabling puts the route (and its chart) straight back
    if (phase === 'drawing') { if (verts.length >= 2) phase = 'done'; else resetRoute(); }
    hoverIdx = -1;
    unbind();                                         // map back exactly as found
    requestDraw();
  }

  function clear() {
    clearTimeout(computeTimer);
    resetRoute();
    paint();
  }

  buildDom();
  paint();

  return {
    enable,
    disable,
    toggle() { if (active) disable(); else enable(); },
    clear,
    isActive() { return active; },
    setUnits(u) {
      const next = u === 'imperial' ? 'imperial' : 'metric';
      if (next === units) return;
      units = next;
      if (data) note = footnote(data);
      paint();                                        // reformat only: no resampling
    },
  };
}
