# relief-app — module contract (single source of truth)

A zero-build static web app: vanilla ES modules, **no npm, no bundler, no framework**.
Vendored libs already on disk:

- `vendor/leaflet/leaflet.js` + `leaflet.css` (Leaflet 1.9.4) — loaded as a *classic script* in
  `index.html`, so `L` is a global. Do not `import` it.
- `vendor/three/three.module.js` (three r160) + `vendor/three/controls/OrbitControls.js` —
  reachable via an import map already present in `index.html`:
  `import * as THREE from 'three'` and `import {OrbitControls} from 'three/addons/controls/OrbitControls.js'`.

Target: Chrome/Edge current. Code style: plain modern JS, 2-space indent, terse comments that
explain *why*, no TypeScript, no JSDoc walls.

---

## 0. Purpose (read this — it drives every design call)

The user is a **cyclist** who wants an intuitive mental picture of how steep local hills are.
Two things follow:

1. **Exaggeration must be dramatic and unbounded-feeling.** Sliders go far past "realistic"
   (2D hillshade z-factor 1–25, 3D vertical 1–15). Cranking it must visibly transform the map.
2. **Reported numbers must never lie.** Exaggeration affects *shading and geometry only*.
   Gradient percentages, contour labels, and profile statistics are always computed from
   true elevation with zFactor = 1. Never scale a number a human will read as a real gradient.

Default location (user's home, South London): `lat 51.412172, lon -0.022933`.

---

## 1. Elevation data

AWS Terrarium DEM tiles, 256×256 PNG, `Access-Control-Allow-Origin: *` (verified).

- Same-origin proxy (preferred, disk-cached by `serve.js`): `/dem/{z}/{x}/{y}.png`
- Direct fallback if the proxy 5xx/404s or the app is served elsewhere:
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (needs
  `img.crossOrigin = 'anonymous'`).

Decode, per pixel: `metres = R * 256 + G + B / 256 - 32768`.
Keep values honest — do **not** clamp negatives to 0 (the lunar app did; we don't).
Max useful zoom is **15**; above that, upsample.

Basemap tiles, all CORS-clean (verified) — proxy path `/tile/{src}/{z}/{x}/{y}`:

| key | url |
|---|---|
| `osm` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| `light` | `https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png` |
| `dark` | `https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` |
| `sat` | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` (note y/x order) |
| `topo` | `https://tile.opentopomap.org/{z}/{x}/{y}.png` |

---

## 2. `js/dem.js` — shared DEM core  *(owner: agent A)*

No DOM globals at module top level beyond `document`/`Image` used inside functions, so the pure
maths stays importable in Node for tests.

```js
export const DEM_MAX_Z = 15;
export const TILE_PX = 256;

// --- Web Mercator / slippy maths ---
export function lonLatToTile(lon, lat, z);   // -> [xFloat, yFloat]  (fractional tile coords)
export function tileToLonLat(x, y, z);       // -> [lon, lat] of the tile's NW corner
export function metresPerPixel(lat, z);      // 156543.03392804097 * cos(lat°) / 2**z
export function demZoomFor(mapZoom);         // -> min(max(round(mapZoom), 0), DEM_MAX_Z)

// --- tile access (in-memory LRU ~600 tiles, in-flight dedup, 3 retries) ---
export async function getDemTile(z, x, y);   // -> Float32Array(256*256), row-major, metres
export function peekDemTile(z, x, y);        // -> Float32Array | null   (sync, cache-only)

// Seam-free shading input: the tile plus a `pad`-pixel halo taken from its neighbours.
// Missing/failed neighbours are edge-clamped. size === TILE_PX + 2*pad.
export async function getPaddedTile(z, x, y, pad = 1);
//   -> {data: Float32Array(size*size), size, pad, z, x, y}

// Arbitrary-extent mosaic, used by the 3D view and the profile tool.
export async function getRegion({west, south, east, north}, z, opts = {});
//   -> {data: Float32Array(w*h), w, h, z, west, south, east, north,
//       sample(lon, lat),        // bilinear, metres, edge-clamped
//       min, max}
//   opts: {onProgress(done, total), signal}

export async function elevationAt(lon, lat, z = DEM_MAX_Z);  // bilinear single point, metres

// --- pure, unit-tested in Node ---
export function decodeTerrarium(rgba, out);   // rgba: Uint8ClampedArray|Uint8Array -> Float32Array
```

Report tile-loading progress through `window.reliefStatus(msg)` when convenient (see §7).

## 3. `js/shade.js` — raster relief kernels  *(owner: agent A)*

**Pure functions only. No DOM, no imports.** Must run under `node --input-type=module`.
Input rasters are padded (`size = w + 2*pad`); outputs are unpadded `w*h`.

```js
export function hillshade(elev, w, h, opts);      // -> Float32Array(w*h), 0..1
export function slopePercent(elev, w, h, opts);   // -> Float32Array(w*h), rise/run * 100
export function slopeDegrees(elev, w, h, opts);   // -> Float32Array(w*h)
export function aspectDegrees(elev, w, h, opts);  // -> Float32Array(w*h), 0=N, clockwise

// opts (all kernels): {size, pad, mpp, mppRow, zFactor=1, azimuth=315, altitude=45,
//                      multiDirectional=false}
//   mpp     — metres per pixel (scalar) OR
//   mppRow  — Float32Array(h) of per-row metres/pixel (preferred: Mercator stretches with
//             latitude, and a tile spans enough latitude at low zoom to matter)
```

**IMPLEMENTED AND TESTED** — Horn's 3×3 gradient, neighbourhood `a b c / d e f / g h i`
with **y increasing southward**, expressed as rise-per-metre eastward/northward:

```
Zx = ((c + 2f + i) - (a + 2d + g)) / (8 * mpp)     // rise per metre EAST
Zn = ((a + 2b + c) - (g + 2h + i)) / (8 * mpp)     // rise per metre NORTH
```

Shading is then a plain Lambertian dot product, in (east, north, up) coordinates —
equivalent to the ESRI slope/aspect formula but with self-evident sign conventions,
which is where hillshade implementations normally go wrong:

```
normal = normalise(-Zx * zFactor, -Zn * zFactor, 1)
light  = (sin(az) * cos(alt), cos(az) * cos(alt), sin(alt))
shade  = max(0, normal · light)
```

Verified invariants (`test/core.test.mjs`, 68 assertions): flat ground → `cos(zenith)`;
a 45° ramp → 100 % / 45°; ground rising eastward has aspect 270°; a 45° west-facing slope
lit from due west at 45° → exactly 1.0, lit from due east → exactly 0.0; `zFactor` alters
shading but never `slopePercent`.

`multiDirectional: true` → weighted mean of four lights (225°/270°/315°/360°, weights
0.2/0.3/0.3/0.2). It keeps lee slopes legible instead of crushing them to black, which matters
once the z-factor is cranked up.

`slopePercent` / `slopeDegrees` **ignore `zFactor`** (see §0.2).

Colour helpers, returning `[r, g, b]` 0–255:

```js
export function hypsoColor(metres, lo, hi);   // low green -> tan -> brown -> grey-white
export const GRADIENT_BANDS;                  // ordered, ascending
//   [{min: 0,  max: 3,  color: [...], label: '0–3%',  hint: 'flat-ish'},
//    {min: 3,  max: 6,  ...'noticeable'}, {min: 6,  max: 9,  ...'a climb'},
//    {min: 9,  max: 12, ...'hard'},       {min: 12, max: 15, ...'brutal'},
//    {min: 15, max: Infinity, ...'walk it'}]
export function gradientBandColor(pct);       // -> [r,g,b,a] | null  (null below the first band)
export function contourSegments(elev, w, h, opts);
//   opts {size, pad, interval}  ->  [{level, segs: Float32Array([x0,y0,x1,y1, ...])}]
//   marching squares on the padded grid, coordinates in unpadded pixel space
export function contourInterval(mapZoom, relief);  // sensible metres: 100/50/25/10/5
export function gradientBand(pct);            // the band object itself, for labelling
```

`GRADIENT_BANDS[i]` is `{min, max, color: [r,g,b], alpha, label, hint}`. Band 0 (0–3 %) has
`alpha: 0` and `gradientBandColor()` returns `null` below 3 % — flat ground is left untinted so
the basemap stays readable; the band still exists so the legend can show it.

Extra helpers present in the shipped modules (beyond the original list, free to use):

```js
// dem.js
export function mppRowsForTile(z, ty, size, pad);  // Float32Array(size) of per-row metres/px
export function haversine(lon1, lat1, lon2, lat2); // metres
export function tileFailed(z, x, y);               // did this tile give up after retries?
export const _cacheStats;                          // {tiles, inflight, failed}
// getDemTile / getPaddedTile / elevationAt all take an optional trailing AbortSignal.
```

## 4. `js/map2d.js` — 2D exaggerated-relief map  *(owner: agent B)*

```js
export function create2D({container, state, onStateChange});
//   -> {show(), hide(), setExaggeration(z), setOptions(partial), setView(lon, lat, zoom),
//       getBounds(), getMap(), invalidate(), setUserLocation(loc | null)}
```

`setUserLocation({lat, lon, accuracy, heading} | null)` — added for live device-location tracking
(v0.2, Android). Draws/updates a pulsing dot + true-radius accuracy circle; `null` removes it.
Owned and called by the shell (`app.js`), which runs the actual `watchPosition` — this method
only ever touches the map's own overlay, never geolocation itself.

A Leaflet map in `container` (`#map2d`), basemap `L.tileLayer` underneath, plus a custom
`L.GridLayer` subclass that paints relief per tile onto its own canvas:

1. `getPaddedTile(demZ, ...)` for the tile (pad 1, or 2 when contours are on).
2. Per-row `mppRow` from each row's latitude — do not use one latitude for the whole tile.
3. Composite, bottom-up: hypsometric tint (if on) → **multiply** by hillshade →
   gradient-band tint (if on, `globalAlpha` ~0.55) → contour strokes (if on).
4. Cache the tile's decoded elevation so a slider move re-shades from memory with **no refetch**.

Requirements:

- **Seam-free.** The 1px halo comes from real neighbour data, not edge-clamping of the own tile.
- **Slider is live.** Dragging re-renders visible tiles at interactive speed; debounce ~16–30 ms
  and skip offscreen tiles. Target < 150 ms for a full viewport re-shade.
- **DEM zoom vs map zoom.** Above z15 sample z15 and upsample bilinearly (relief goes soft, not
  blocky). Below ~z9 relief is naturally faint — that's honest, don't fake it.
- **Retina.** Respect `L.Browser.retina` / `detectRetina` so the relief isn't half-res on HiDPI.
- Hover readout: elevation + local gradient % at the cursor, pushed via
  `window.reliefStatus()` or the `#readout` element if present.
- Call `onStateChange({lon, lat, zoom})` on `moveend` so the 3D view can open on the same ground.
- Extra mode-specific controls go in `#panel-2d-extra`; styles in `css/map2d.css`.

## 5. `js/view3d.js` — 3D terrain view  *(owner: agent C)*

```js
export function create3D({container, state, onStateChange});
//   -> {show(), hide(), setExaggeration(v), setOptions(partial), setView(lon, lat, zoom),
//       dispose()}
```

three.js scene in `container` (`#view3d`), built from `getRegion()` over the extent implied by
`state` (default ~12 km across, user-adjustable 4–60 km):

- Mesh: `PlaneGeometry` on the XZ plane, ~320×320 segments, Y = metres × exaggeration, in a
  world scaled so 1 unit = 1 km (keeps camera/fog numbers sane).
- Basemap draped as a `CanvasTexture` mosaicked from the same `state.basemap` source; swap it
  without rebuilding geometry. `THREE.SRGBColorSpace`, max anisotropy.
- Lighting: hemisphere + directional sun; sun azimuth/altitude follow `state.sunAz`/`sunAlt`.
  Recompute vertex normals whenever exaggeration changes or the terrain rebuilds.
- **`setExaggeration` must be cheap** — rewrite `position.array` Y from the cached height array
  and recompute normals; never rebuild geometry or refetch DEM.
- `OrbitControls`, damping on, `maxPolarAngle` just under horizontal, sensible min/max distance.
- A skirt/side wall down to the base so the slab reads as solid, and a subtle sky gradient + fog.
- Readouts: min/max elevation in view, current exaggeration, north indicator.
- Loading progress via `window.reliefStatus()` while DEM/basemap tiles stream in.
- Extra controls in `#panel-3d-extra`; styles in `css/view3d.css`.

## 6. `js/profile.js` — elevation & gradient profile  *(owner: agent D)*

The one feature that turns "pretty relief" into a cycling tool. Works on the 2D map.

```js
export function createProfile({getMap, container});
//   -> {enable(), disable(), toggle(), clear(), isActive(), setUnits('metric'|'imperial')}
```

- `enable()` puts the 2D map in draw mode: click to add vertices, double-click/Enter to finish,
  Esc/`clear()` to discard, drag a vertex to move it, right-click a vertex to delete.
  Render the working polyline with `L.polyline` (+ vertex markers).
- Sample the line every ~25 m via `dem.elevationAt` / a `getRegion` covering its bbox (batch —
  do not fire one request per sample). Haversine for distances.
- Draw a canvas profile chart in `container` (`#panel-profile`): distance x-axis, elevation
  y-axis, area fill coloured by the `GRADIENT_BANDS` of each segment.
- Stats: length, total ascent/descent, min/max elevation, mean gradient, **max sustained
  gradient over a 100 m window** (single-sample spikes are DEM noise, not a hill).
- Hovering the chart marks the spot on the map, and vice versa.
- Gradients from true elevation, zFactor 1, always (§0.2).
- Styles in `css/profile.css`.

## 7. Shell — owned by the integrator (do not edit)

`index.html`, `css/app.css`, `js/app.js`, `serve.js`, `README.md`.

Shared mutable state, created in `app.js` and handed to every module:

```js
state = {
  lon, lat, zoom,            // shared ground position (2D drives it, 3D reads it)
  ex2d,                      // hillshade z-factor, 1..25
  ex3d,                      // 3D vertical exaggeration, 1..15
  basemap,                   // resolved: 'none' | 'osm' | 'light' | 'dark' | 'sat' | 'topo'
                              // — this is what setOptions({basemap}) actually receives;
                              // 'none' is 2D-only, see mapType below
  mapType,                   // 'none' | 'roads' | 'sat' — drives the shell's Map type UI;
                              // basemap = mapType==='none' ? 'none' : mapType==='sat' ? 'sat' : roadsStyle
  roadsStyle,                // 'osm' | 'light' | 'dark' | 'topo' — provider when mapType is 'roads',
                              // and always what 3D drapes (3D never receives 'none')
  reliefMix,                 // 0..1 — 2D's basemap/relief crossfade (setOptions({reliefOpacity}))
  layers: {hypso, hillshade, gradient, contours},   // booleans
  sunAz, sunAlt,             // degrees
  extentKm,                  // 3D slab width
  units                      // 'metric' | 'imperial'
}
```

- `app.js` owns the panel, both sliders, the Map type / Style / Relief mix controls,
  layer toggles, search (Nominatim), geolocate, mode switching, URL-hash + localStorage
  persistence. Modules receive changes through `setOptions()` / `setExaggeration()` and
  report movement through `onStateChange()`. `setOptions({reliefOpacity})` on the 2D
  module (§4) is the shell-owned crossfade — it used to be that module's own "Relief
  opacity" slider inside `#panel-2d-extra`; the control moved to the shell, the API
  (`o.reliefOpacity`, 0..1) did not change.
- Global status line: **`window.reliefStatus(msg)`** — always available, safe to call any time.
- DOM ids you may rely on: `#map2d`, `#view3d`, `#panel-2d-extra`, `#panel-3d-extra`,
  `#panel-profile`, `#readout`, `#status`.
- CSS custom properties available: `--bg`, `--panel`, `--fg`, `--dim`, `--accent`, `--line`.
- `css/map2d.css`, `css/view3d.css`, `css/profile.css` are already linked — create your own.

## 8. Rules for every agent

1. **Only create/edit the files you own.** Never touch another agent's file or the shell files.
   If you need something from the shell, assume this contract and say so in your final report.
2. Code against this contract even if the other modules do not exist yet.
3. Fail soft: a dead tile, a DEM hole, or a WebGL-less browser degrades gracefully with a
   message — it never throws an unhandled error or shows a blank screen.
4. No `alert()`, no external CDN references, no npm.
5. Leave a short comment above any non-obvious bit of maths (why, not what).
6. Sanity-check your maths before reporting done: a 45° slope must read ~100%, a flat area ~0%,
   and hillshade on flat ground must equal `cos(zenith)`.
