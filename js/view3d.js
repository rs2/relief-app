// js/view3d.js — 3D terrain view (CONTRACT §5).  Owner: agent C.
//
// ---------------------------------------------------------------------------
// UNITS / SCALE CONVENTION — read this before touching any number in here.
//
//   * 1 world unit = 1 kilometre, on every axis.  Camera distances, fog and
//     the sky dome are all expressed in km, which keeps them human-readable.
//   * Axes: +X = east, -Z = north (so +Z is south), +Y = up.
//   * Ground: the slab is `state.extentKm` across in *ground distance* both
//     ways, so X and Z each span -extentKm/2 .. +extentKm/2.
//   * Height: Y = metres * exaggeration / 1000.
//     Consequence worth keeping in mind: at exaggeration 1 the slab is
//     geometrically true — a 100 m rise over 1 km really is a 10% grade on
//     screen (0.1 world units of Y over 1 world unit of X).
//   * Exaggeration touches geometry and nothing else.  Every number this
//     module prints (elevation, relief, gradient tint) comes from the true
//     metre heights with no z-factor applied (CONTRACT §0.2).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {getRegion, metresPerPixel, lonLatToTile, DEM_MAX_Z, TILE_PX} from './dem.js';

const SEG = 320;                              // mesh segments per side -> 321^2 vertices
const KM_PER_DEG_LAT = 111.19492664455873;    // 6371.0088 km * PI/180
const DRAPE_MAX_TILES = 6;                    // tiles across; bounds the mosaic at ~7x7 fetches
const SUN_BASE = 2.2, HEMI_BASE = 0.95;       // r160 lights are physical: no PI factor any more

// Sky/fog palette. These are written straight to the framebuffer by the sky
// shader, so they are plain sRGB values — same numbers a CSS colour would use.
const SKY_TOP = [0x18, 0x27, 0x3a], SKY_HORIZON = [0x84, 0x96, 0xa8], SKY_GROUND = [0x0a, 0x0f, 0x16];
const FOG_HEX = 0x76889b;

// Direct CDN fallbacks, used only when the shell's own /tile proxy fails
// (CONTRACT §1 — all of these are CORS-clean; note the y/x swap on ArcGIS).
const DIRECT_TILE = {
  osm:   (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  light: (z, x, y) => `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
  dark:  (z, x, y) => `https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
  topo:  (z, x, y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png`,
  sat:   (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/` +
                      `World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

// Per-basemap grading. Tiles are cartography, not albedo: satellite imagery and
// the dark Carto style sit so low that a lambertian surface turns them to mud,
// so they get lifted on the way into the canvas, lit slightly harder, and given
// a touch of self-illumination so shaded slopes never crush to black.
const GRADE = {
  light: {filter: 'saturate(1.06)',                                sun: 1.00, hemi: 1.00, emis: 0.04, base: '#e9e7e2'},
  osm:   {filter: 'saturate(0.95) brightness(1.03)',               sun: 1.00, hemi: 1.00, emis: 0.05, base: '#e4e1d9'},
  topo:  {filter: 'saturate(1.04) brightness(1.03)',               sun: 1.00, hemi: 1.00, emis: 0.05, base: '#e7e3d7'},
  sat:   {filter: 'brightness(1.26) contrast(0.90) saturate(1.18)', sun: 1.10, hemi: 1.20, emis: 0.13, base: '#59614a'},
  dark:  {filter: 'brightness(2.05) contrast(0.82) saturate(1.28)', sun: 1.18, hemi: 1.35, emis: 0.17, base: '#2b3038'},
};
const GRADE_FLAT = {filter: 'none', sun: 1, hemi: 1, emis: 0.03, base: '#9aa4ac'};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// Mercator y, in the same units the slippy grid uses. Only needed by the
// fallback sampler below, so it stays local rather than leaning on dem.js.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + clamp(lat, -85.05, 85.05) * Math.PI / 360));

const HUD_HTML = `
<div class="v3d-rose"><svg viewBox="-16 -16 32 32" aria-hidden="true">
  <circle class="ring" cx="0" cy="0" r="14.4"/>
  <path class="nn" d="M0,-12.4 L4.4,2 L0,-1 L-4.4,2 Z"/>
  <path class="ss" d="M0,12.4 L4.4,-2 L0,1 L-4.4,-2 Z"/>
</svg></div>
<dl class="v3d-stats">
  <dt>looking</dt><dd data-k="hdg">–</dd>
  <dt>high</dt><dd data-k="hi">–</dd>
  <dt>low</dt><dd data-k="lo">–</dd>
  <dt>relief</dt><dd data-k="rel">–</dd>
  <dt>vertical</dt><dd data-k="ex">–</dd>
  <dt>slab</dt><dd data-k="slab">–</dd>
</dl>`;

const EXTRA_HTML = `
<div class="v3d-extra">
  <div class="v3d-sub">Drape</div>
  <select data-k="drape">
    <option value="basemap">Basemap tiles</option>
    <option value="hypso">Elevation tint</option>
    <option value="gradient">Gradient bands</option>
    <option value="plain">Plain relief</option>
  </select>
  <div class="rows" style="margin-top:8px">
    <label class="row"><input type="checkbox" data-k="wire"><span>Wireframe</span></label>
    <label class="row"><input type="checkbox" data-k="spin"><span>Slow spin</span></label>
  </div>
  <div class="btnrow" style="margin-top:6px">
    <button class="act" data-k="reset">Reset camera</button>
  </div>
</div>`;

/**
 * Build the 3D view. Never throws: if WebGL is missing (or three fails to get a
 * context) the container gets an explanation and a no-op API, so mode switching
 * in the shell keeps working.
 */
export function create3D({container, state = {}, onStateChange} = {}) {
  const say = (m, err) => { try { window.reliefStatus?.(m, err); } catch { /* shell may be gone */ } };

  // ---- overlay first: it is also how we report a hard failure --------------
  const overlay = el('div', 'v3d-overlay');
  container.appendChild(overlay);

  const noop = () => {};
  if (!hasWebGL()) {
    overlay.classList.add('on');
    overlay.appendChild(el('div', 'v3d-msg',
      '<h3>3D needs WebGL</h3><p>This browser or GPU driver will not give us a WebGL context, ' +
      'so the terrain view cannot run. The 2D relief map works without it — it does the same ' +
      'exaggeration in a canvas.</p>'));
    say('3D unavailable: no WebGL in this browser', true);
    return {show: noop, hide: noop, setExaggeration: noop, setOptions: noop, setView: noop,
            dispose: () => { overlay.remove(); }};
  }

  // ---- local mirrors of shared state (the shell mutates `state` first, then
  // calls us; we keep our own copies so we can tell a real change from a nudge)
  let ex = clamp(num(state.ex3d, 4), 0.1, 100);
  let sunAz = num(state.sunAz, 315), sunAlt = num(state.sunAlt, 45);
  let bmKey = GRADE[state.basemap] ? state.basemap : 'light';
  let unitsImp = state.units === 'imperial';
  let drapeMode = 'basemap', wire = false;
  let wantLon = num(state.lon, -0.022933), wantLat = num(state.lat, 51.412172);
  let appliedExtentKm = null;

  // ---- three.js scene ------------------------------------------------------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  } catch (e) {
    overlay.classList.add('on');
    overlay.appendChild(el('div', 'v3d-msg',
      `<h3>3D could not start</h3><p>WebGL refused to initialise: ${e.message}</p>`));
    say(`3D unavailable: ${e.message}`, true);
    return {show: noop, hide: noop, setExaggeration: noop, setOptions: noop, setView: noop,
            dispose: () => { overlay.remove(); }};
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(FOG_HEX, 1);
  container.insertBefore(renderer.domElement, overlay);

  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 1;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOG_HEX, 10, 40);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.02, 2000);
  camera.position.set(-4, 5, 10);

  // sky dome: gradient taken from the view direction, so it reads correctly
  // wherever the camera is inside the dome. Drawn first, with depth off.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        top: {value: new THREE.Vector3(...SKY_TOP.map((c) => c / 255))},
        horizon: {value: new THREE.Vector3(...SKY_HORIZON.map((c) => c / 255))},
        ground: {value: new THREE.Vector3(...SKY_GROUND.map((c) => c / 255))},
      },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top, horizon, ground;
        varying vec3 vWorld;
        void main() {
          float h = normalize(vWorld - cameraPosition).y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55))
                           : mix(horizon, ground, pow(clamp(-h, 0.0, 1.0), 0.45));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.scale.setScalar(240);
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xbdd3ea, 0x4a4436, HEMI_BASE);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2df, SUN_BASE);
  scene.add(sun, sun.target);

  const terrainMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.94, metalness: 0.0,
    emissive: 0xffffff, emissiveIntensity: 0,
  });
  const skirtMat = new THREE.MeshStandardMaterial({
    color: 0x7c6d5d, roughness: 1.0, metalness: 0.0,
    vertexColors: true, side: THREE.DoubleSide,
  });

  let geo = null, mesh = null, skirtGeo = null, skirt = null, skirtIdx = null;
  let geoW = 0, geoH = 0, baseY = 0;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = false;     // pan along the ground, not the screen
  controls.minPolarAngle = 0.04;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;   // just under horizontal: never see under the slab
  controls.autoRotateSpeed = 0.35;
  controls.minDistance = 1;
  controls.maxDistance = 100;

  // ---- HUD ---------------------------------------------------------------
  const hud = el('div', 'v3d-hud', HUD_HTML);
  container.insertBefore(hud, overlay);
  const rose = hud.querySelector('.v3d-rose svg');
  const hudEl = {};
  hud.querySelectorAll('[data-k]').forEach((n) => { hudEl[n.dataset.k] = n; });

  // ---- panel extras (3D-only bits; the main panel belongs to the shell) ----
  const extraHost = document.getElementById('panel-3d-extra');
  let extra = null;
  if (extraHost) {
    extra = el('div', null, EXTRA_HTML).firstElementChild;
    extraHost.appendChild(extra);
    const q = (k) => extra.querySelector(`[data-k="${k}"]`);
    q('drape').addEventListener('change', (e) => {
      drapeMode = e.target.value;
      startDrape();
    });
    q('wire').addEventListener('change', (e) => {
      wire = e.target.checked;
      terrainMat.wireframe = wire;
      if (skirt) skirt.visible = !wire;
      dirty = true;
    });
    q('spin').addEventListener('change', (e) => { controls.autoRotate = e.target.checked; dirty = true; });
    q('reset').addEventListener('click', () => { frameCamera(true); });
  }

  // ---- state that survives rebuilds ---------------------------------------
  let heights = null;             // Float32Array((SEG+1)^2), true metres, row 0 = north edge
  let hMin = 0, hMax = 0;
  let ext = null;                 // {lon, lat, extentKm, west, south, east, north, widthKm, heightKm}
  let demZ = 0;
  let buildGen = 0, drapeGen = 0;
  let abortCtl = null;
  let drapeTex = null;
  let kicked = false, framed = false, building = false;
  let visible = false, rafId = 0, dirty = true, disposed = false;
  let autoTimer = 0, lastProg = 0, lastHdg = null, lastReported = null;
  let shadeMod = null, shadeTried = false;

  // =========================================================================
  // extent maths
  // =========================================================================
  function makeExtent(lon, lat, extentKm) {
    const half = extentKm / 2;
    const dLat = half / KM_PER_DEG_LAT;
    // east-west degrees shrink with latitude; use the centre latitude so the
    // slab is square in *ground* distance, which is what "12 km across" means.
    const dLon = dLat / Math.max(0.02, Math.cos(lat * Math.PI / 180));
    return {
      lon, lat, extentKm,
      west: lon - dLon, east: lon + dLon,
      south: clamp(lat - dLat, -85, 85), north: clamp(lat + dLat, -85, 85),
      widthKm: extentKm, heightKm: extentKm,
    };
  }

  // Smallest DEM zoom that still gives at least one source sample per mesh
  // vertex — never upsample, never fetch a hundred tiles for one slab.
  function pickDemZoom(lat, extentKm) {
    for (let z = 5; z <= DEM_MAX_Z; z++) {
      if (extentKm * 1000 / metresPerPixel(lat, z) >= SEG + 1) return z;
    }
    return DEM_MAX_Z;
  }

  // Highest basemap zoom whose mosaic stays inside DRAPE_MAX_TILES across.
  function pickTileZoom(lat, extentKm) {
    for (let z = 19; z >= 1; z--) {
      if (extentKm * 1000 / metresPerPixel(lat, z) <= DRAPE_MAX_TILES * TILE_PX) return z;
    }
    return 1;
  }

  // =========================================================================
  // DEM -> height grid
  // =========================================================================
  function makeSampler(reg, e) {
    // Preferred path: dem.js's own bilinear geographic sampler (CONTRACT §2).
    if (typeof reg.sample === 'function') {
      const probe = reg.sample((e.west + e.east) / 2, (e.south + e.north) / 2);
      if (Number.isFinite(probe)) return (lon, lat) => reg.sample(lon, lat);
    }
    // Fallback: bilinear straight off the mosaic. Rows are evenly spaced in
    // Mercator y, not in latitude, so the row index goes through mercY.
    const {data, w, h} = reg;
    const yN = mercY(reg.north), yS = mercY(reg.south);
    const lonSpan = reg.east - reg.west || 1e-9, ySpan = yS - yN || 1e-9;
    const at = (r, c) => data[clamp(r, 0, h - 1) * w + clamp(c, 0, w - 1)];
    return (lon, lat) => {
      const fx = clamp((lon - reg.west) / lonSpan, 0, 1) * (w - 1);
      const fy = clamp((mercY(lat) - yN) / ySpan, 0, 1) * (h - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const a = at(y0, x0), b = at(y0, x0 + 1), c = at(y0 + 1, x0), d = at(y0 + 1, x0 + 1);
      return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    };
  }

  function sampleHeights(reg, e) {
    const N = SEG + 1;
    if (!heights || heights.length !== N * N) heights = new Float32Array(N * N);
    const smp = makeSampler(reg, e);
    const dLon = (e.east - e.west) / SEG, dLat = (e.north - e.south) / SEG;
    let mn = Infinity, mx = -Infinity;
    for (let r = 0; r < N; r++) {
      const lat = e.north - r * dLat, row = r * N;
      for (let c = 0; c < N; c++) {
        let v = smp(e.west + c * dLon, lat);
        // a DEM hole must dent the mesh, not spike it through the floor
        if (!Number.isFinite(v)) v = c ? heights[row + c - 1] : (r ? heights[row - N + c] : 0);
        heights[row + c] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    hMin = Number.isFinite(mn) ? mn : 0;
    hMax = Number.isFinite(mx) ? mx : 0;
  }

  // =========================================================================
  // geometry
  // =========================================================================
  function ensureTerrain(e) {
    if (mesh && geoW === e.widthKm && geoH === e.heightKm) return;
    dropGeometry();
    geoW = e.widthKm; geoH = e.heightKm;

    geo = new THREE.PlaneGeometry(e.widthKm, e.heightKm, SEG, SEG);
    // PlaneGeometry is built on XY; drop it onto XZ. After this rotation row 0
    // (uv.v = 1) sits at -Z, i.e. the north edge — which is also the top row of
    // the drape canvas, so texture and DEM agree without any uv fiddling.
    geo.rotateX(-Math.PI / 2);
    mesh = new THREE.Mesh(geo, terrainMat);
    mesh.frustumCulled = false;          // one big mesh; culling it can only go wrong
    scene.add(mesh);

    buildSkirt();
  }

  // Side walls, as one ring of quads around the slab. Traversal order is
  // north W->E, east N->S, south E->W, west S->N: with `up x traversal` that
  // gives outward-facing triangles. Normals are set by hand (each wall is
  // vertical, so its normal is constant) which means an exaggeration change
  // only has to rewrite Y.
  function buildSkirt() {
    const N = SEG + 1, tpos = geo.attributes.position.array;
    const ring = new Int32Array(4 * N);
    let p = 0;
    for (let c = 0; c < N; c++) ring[p++] = c;
    for (let r = 0; r < N; r++) ring[p++] = r * N + (N - 1);
    for (let c = N - 1; c >= 0; c--) ring[p++] = (N - 1) * N + c;
    for (let r = N - 1; r >= 0; r--) ring[p++] = r * N;
    skirtIdx = ring;

    const P = ring.length;
    const pos = new Float32Array(P * 2 * 3);
    const nrm = new Float32Array(P * 2 * 3);
    const col = new Float32Array(P * 2 * 3);
    const wall = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]];
    for (let i = 0; i < P; i++) {
      const gi = ring[i], x = tpos[gi * 3], z = tpos[gi * 3 + 2];
      const w = wall[Math.min(3, Math.floor(i / N))];
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = x; pos[o + 2] = z;                 // Y is filled by applyHeights()
        nrm[o] = w[0]; nrm[o + 1] = w[1]; nrm[o + 2] = w[2];
        const s = k ? 0.32 : 1.0;                   // darken toward the base
        col[o] = s; col[o + 1] = s; col[o + 2] = s;
      }
    }
    const idx = new Uint32Array((P - 1) * 6);
    for (let i = 0, o = 0; i < P - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx[o++] = a; idx[o++] = d; idx[o++] = b;
      idx[o++] = a; idx[o++] = c; idx[o++] = d;
    }

    skirtGeo = new THREE.BufferGeometry();
    skirtGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    skirtGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    skirtGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    skirtGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.frustumCulled = false;
    skirt.visible = !wire;
    scene.add(skirt);
  }

  // The whole point of the slider: rewrite Y from the cached metre heights and
  // recompute normals. No geometry allocation, no DEM refetch, no texture work.
  function applyHeights() {
    if (!mesh || !heights || !ext) return;
    const k = ex / 1000;                       // metres * exaggeration -> km
    const pos = geo.attributes.position.array;
    for (let i = 0, n = heights.length; i < n; i++) pos[i * 3 + 1] = heights[i] * k;
    geo.attributes.position.needsUpdate = true;
    gridNormals();

    // slab thickness: enough to read as solid at any exaggeration
    baseY = hMin * k - (0.045 * ext.extentKm + 0.16 * (hMax - hMin) * k + 0.05);
    const sp = skirtGeo.attributes.position.array;
    for (let i = 0, n = skirtIdx.length; i < n; i++) {
      sp[(i * 2) * 3 + 1] = heights[skirtIdx[i]] * k;
      sp[(i * 2 + 1) * 3 + 1] = baseY;
    }
    skirtGeo.attributes.position.needsUpdate = true;

    dirty = true;
    updateHud();
  }

  // Analytic heightfield normals: n = normalize(-dy/dx, 1, -dy/dz). ~4x faster
  // than computeVertexNormals() on a 320x320 grid and exactly smooth, which
  // matters because this runs on every slider tick.
  function gridNormals() {
    const N = SEG + 1;
    const pos = geo.attributes.position.array;
    const nrm = geo.attributes.normal.array;
    const stepX = ext.widthKm / SEG, stepZ = ext.heightKm / SEG;
    for (let r = 0; r < N; r++) {
      const rm = (r > 0 ? r - 1 : r) * N, rp = (r < N - 1 ? r + 1 : r) * N, row = r * N;
      const dz = (r > 0 && r < N - 1) ? 2 * stepZ : stepZ;
      for (let c = 0; c < N; c++) {
        const cm = c > 0 ? c - 1 : c, cp = c < N - 1 ? c + 1 : c;
        const dx = (c > 0 && c < N - 1) ? 2 * stepX : stepX;
        const nx = -(pos[(row + cp) * 3 + 1] - pos[(row + cm) * 3 + 1]) / dx;
        const nz = -(pos[(rp + c) * 3 + 1] - pos[(rm + c) * 3 + 1]) / dz;
        const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        const o = (row + c) * 3;
        nrm[o] = nx * inv; nrm[o + 1] = inv; nrm[o + 2] = nz * inv;
      }
    }
    geo.attributes.normal.needsUpdate = true;
  }

  function dropGeometry() {
    if (mesh) { scene.remove(mesh); geo.dispose(); mesh = null; geo = null; }
    if (skirt) { scene.remove(skirt); skirtGeo.dispose(); skirt = null; skirtGeo = null; }
    skirtIdx = null;
  }

  // =========================================================================
  // camera + lighting
  // =========================================================================
  function frameCamera(refit) {
    const midY = (hMin + hMax) * 0.5 * (ex / 1000);
    const e = ext || makeExtent(wantLon, wantLat, 12);
    camera.far = Math.max(60, e.extentKm * 80);
    camera.updateProjectionMatrix();
    controls.minDistance = e.extentKm * 0.10;
    controls.maxDistance = e.extentKm * 3.4;
    sky.scale.setScalar(e.extentKm * 20);
    scene.fog.near = e.extentKm * 0.9;
    scene.fog.far = e.extentKm * 3.3;

    if (refit || !framed) {
      // from the SSW, 34° up: with the conventional NW sun the light then rakes
      // across the slopes instead of coming straight down the barrel
      const d = e.extentKm * 1.15, az = 200 * Math.PI / 180, alt = 34 * Math.PI / 180;
      controls.target.set(0, midY, 0);
      camera.position.set(
        Math.sin(az) * Math.cos(alt) * d + controls.target.x,
        Math.sin(alt) * d + midY,
        -Math.cos(az) * Math.cos(alt) * d + controls.target.z);
      framed = true;
    } else {
      // keep the viewing angle across a rebuild; rescale distance with the slab
      const off = camera.position.clone().sub(controls.target);
      if (appliedExtentKm) off.multiplyScalar(e.extentKm / appliedExtentKm);
      const len = clamp(off.length(), controls.minDistance, controls.maxDistance);
      off.setLength(len || 1);
      controls.target.set(0, midY, 0);
      camera.position.copy(controls.target).add(off);
    }
    controls.update();
    dirty = true;
  }

  function updateSun() {
    const az = sunAz * Math.PI / 180, alt = clamp(sunAlt, 2, 89) * Math.PI / 180;
    const d = Math.max(30, (ext ? ext.extentKm : 12) * 4);
    // compass azimuth: 0 = north = -Z, 90 = east = +X
    sun.position.set(Math.sin(az) * Math.cos(alt) * d, Math.sin(alt) * d,
                     -Math.cos(az) * Math.cos(alt) * d);
    // a low sun would leave half the slab unreadable, so lift the fill instead
    const lift = 1 + 0.5 * (1 - clamp(sunAlt, 2, 89) / 90);
    const g = gradeNow();
    hemi.intensity = HEMI_BASE * g.hemi * lift;
    sun.intensity = SUN_BASE * g.sun;
    dirty = true;
  }

  const gradeNow = () => (drapeMode === 'basemap' ? (GRADE[bmKey] || GRADE.light) : GRADE_FLAT);

  function applyGrade() {
    const g = gradeNow();
    terrainMat.emissiveIntensity = g.emis;
    updateSun();
  }

  // =========================================================================
  // drape
  // =========================================================================
  function setDrape(canvas, ox, oy, rx, ry) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.offset.set(ox, oy);
    tex.repeat.set(rx, ry);
    if (drapeTex) drapeTex.dispose();
    drapeTex = tex;
    terrainMat.map = tex;
    terrainMat.emissiveMap = tex;        // same uv transform, so they stay in register
    terrainMat.color.setHex(0xffffff);
    terrainMat.needsUpdate = true;
    applyGrade();
    dirty = true;
    return tex;
  }

  function clearDrape(hex) {
    if (drapeTex) { drapeTex.dispose(); drapeTex = null; }
    terrainMat.map = null;
    terrainMat.emissiveMap = null;
    terrainMat.color.setHex(hex);
    terrainMat.needsUpdate = true;
    applyGrade();
    dirty = true;
  }

  function startDrape() {
    if (!ext) return;
    const gen = ++drapeGen;
    if (drapeMode === 'basemap') drapeBasemap(gen);
    else drapeTint(gen);
  }

  function drapeBasemap(gen) {
    const g = GRADE[bmKey] || GRADE.light;
    const z = pickTileZoom(ext.lat, ext.extentKm);
    const [fx0, fy0] = lonLatToTile(ext.west, ext.north, z);
    const [fx1, fy1] = lonLatToTile(ext.east, ext.south, z);
    const tx0 = Math.floor(fx0), ty0 = Math.floor(fy0);
    const tx1 = Math.max(tx0, Math.ceil(fx1) - 1), ty1 = Math.max(ty0, Math.ceil(fy1) - 1);
    const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;

    const cv = document.createElement('canvas');
    cv.width = nx * TILE_PX; cv.height = ny * TILE_PX;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = g.base;
    ctx.fillRect(0, 0, cv.width, cv.height);

    // uv maps onto the sub-rectangle of the mosaic that the slab actually covers.
    // (Texture v runs from the bottom of the canvas, hence 1 - v.)
    const u0 = (fx0 - tx0) / nx, u1 = (fx1 - tx0) / nx;
    const v0 = (fy0 - ty0) / ny, v1 = (fy1 - ty0) / ny;
    const tex = setDrape(cv, u0, 1 - v1, Math.max(1e-6, u1 - u0), Math.max(1e-6, v1 - v0));

    const world = 2 ** z;
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= world) continue;
      for (let tx = tx0; tx <= tx1; tx++) {
        jobs.push([((tx % world) + world) % world, ty, (tx - tx0) * TILE_PX, (ty - ty0) * TILE_PX]);
      }
    }
    let done = 0, failed = 0;
    const total = jobs.length;
    say(`basemap: 0/${total} tiles`);
    for (const [tx, ty, dx, dy] of jobs) {
      loadTile(bmKey, z, tx, ty).then((img) => {
        if (gen !== drapeGen || disposed) return;
        if (img) {
          ctx.filter = g.filter;                  // grade on the way in, once per tile
          ctx.drawImage(img, dx, dy, TILE_PX, TILE_PX);
          ctx.filter = 'none';
          tex.needsUpdate = true;                 // let tiles pop in as they land
          dirty = true;
        } else failed++;
        if (++done === total) {
          say(failed ? `basemap draped (${failed}/${total} tiles missing)`
                     : `basemap draped · z${z}`, !!failed && failed === total);
        } else if (performance.now() - lastProg > 140) {
          lastProg = performance.now();
          say(`basemap: ${done}/${total} tiles`);
        }
      });
    }
  }

  function loadTile(src, z, x, y) {
    const urls = [`/tile/${src}/${z}/${x}/${y}`];
    if (DIRECT_TILE[src]) urls.push(DIRECT_TILE[src](z, x, y));
    return new Promise((resolve) => {
      let i = 0;
      const attempt = () => {
        if (i >= urls.length) return resolve(null);
        const url = urls[i++];
        const img = new Image();
        if (i > 1) img.crossOrigin = 'anonymous';   // direct CDN needs it to stay canvas-safe
        img.onload = () => resolve(img);
        img.onerror = attempt;                      // proxy down -> try the CDN, then give up
        img.src = url;
      };
      attempt();
    });
  }

  async function loadShade() {
    if (shadeMod || shadeTried) return shadeMod;
    shadeTried = true;
    try { shadeMod = await import('./shade.js'); } catch { shadeMod = null; }
    return shadeMod;
  }

  // Elevation / gradient tints, painted straight off the height grid so they are
  // pixel-aligned with the mesh. Colours come from shade.js so they can never
  // drift from the 2D map and the legend.
  async function drapeTint(gen) {
    if (drapeMode === 'plain') { clearDrape(0xb6bdc4); return; }
    const sh = await loadShade();
    if (gen !== drapeGen || disposed) return;
    if (!sh || !sh.hypsoColor || !sh.gradientBandColor) {
      say('tints need js/shade.js — showing plain relief', true);
      clearDrape(0xb6bdc4);
      return;
    }
    const N = SEG + 1;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(N, N);
    const px = img.data;

    if (drapeMode === 'hypso') {
      for (let i = 0; i < N * N; i++) {
        const c = sh.hypsoColor(heights[i], hMin, hMax);
        const o = i * 4;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
    } else {
      // Horn's 3x3 on the true metre heights with zFactor 1 (CONTRACT §0.2):
      // the tint must mean the same thing here as on the 2D map, whatever the
      // vertical exaggeration is doing to the geometry.
      const mpp = ext.extentKm * 1000 / SEG;   // ground metres between mesh vertices
      const H = (r, c) => heights[clamp(r, 0, N - 1) * N + clamp(c, 0, N - 1)];
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const a = H(r - 1, c - 1), b = H(r - 1, c), cc = H(r - 1, c + 1);
          const d = H(r, c - 1), f = H(r, c + 1);
          const g = H(r + 1, c - 1), h = H(r + 1, c), ii = H(r + 1, c + 1);
          const dzdx = ((a + 2 * d + g) - (cc + 2 * f + ii)) / (8 * mpp);
          const dzdy = ((g + 2 * h + ii) - (a + 2 * b + cc)) / (8 * mpp);
          const pct = Math.hypot(dzdx, dzdy) * 100;
          const band = sh.gradientBandColor(pct);
          const o = (r * N + c) * 4;
          let R = 206, G = 212, B = 203;
          if (band) {
            const al = band[3];
            R += (band[0] - R) * al; G += (band[1] - G) * al; B += (band[2] - B) * al;
          }
          px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    // half-texel inset so texel centres land exactly on mesh vertices
    setDrape(cv, 0.5 / N, 0.5 / N, (N - 1) / N, (N - 1) / N);
    say(drapeMode === 'hypso' ? 'elevation tint draped' : 'gradient bands draped');
  }

  // =========================================================================
  // build
  // =========================================================================
  function setBusy(msg) {
    overlay.classList.add('on');
    overlay.innerHTML = '';
    overlay.appendChild(el('div', 'v3d-msg busy',
      `<div class="v3d-spin"></div><p>${msg}</p>`));
  }
  function setFail(msg) {
    overlay.classList.add('on');
    overlay.innerHTML = '';
    const box = el('div', 'v3d-msg', `<h3>No terrain here yet</h3><p>${msg}</p>`);
    const btn = el('button', 'act', 'Try again');
    btn.onclick = () => build();
    box.appendChild(btn);
    overlay.appendChild(box);
  }
  const setIdle = () => { overlay.classList.remove('on'); overlay.innerHTML = ''; };

  async function build() {
    clearTimeout(autoTimer);
    kicked = true;
    const gen = ++buildGen;
    abortCtl?.abort();
    abortCtl = typeof AbortController === 'function' ? new AbortController() : null;
    building = true;

    const extentKm = clamp(num(state.extentKm, 12), 1, 200);
    const e = makeExtent(wantLon, clamp(wantLat, -84, 84), extentKm);
    const z = pickDemZoom(e.lat, extentKm);
    setBusy(`reading elevation · z${z}`);
    say(`terrain: reading elevation at z${z}…`);

    let reg;
    try {
      reg = await getRegion({west: e.west, south: e.south, east: e.east, north: e.north}, z, {
        signal: abortCtl?.signal,
        onProgress: (d, t) => {
          if (gen !== buildGen) return;
          const now = performance.now();
          if (now - lastProg < 120 && d !== t) return;
          lastProg = now;
          say(`terrain: elevation ${d}/${t} tiles`);
        },
      });
    } catch (err) {
      building = false;
      if (gen !== buildGen || disposed || err?.name === 'AbortError') return;
      setFail(`The elevation tiles for this area would not load (${err?.message || err}). ` +
              `Check that the server is running, then try again.`);
      say(`3D: elevation failed — ${err?.message || err}`, true);
      return;
    }
    building = false;
    if (gen !== buildGen || disposed) return;
    if (!reg || !reg.data || !reg.w || !reg.h) {
      setFail('The elevation service returned an empty region.');
      return;
    }

    sampleHeights(reg, e);
    ext = e;
    demZ = z;
    ensureTerrain(e);
    applyHeights();
    frameCamera(false);
    appliedExtentKm = extentKm;
    setIdle();
    startDrape();
    say(`terrain ready · ${fmtEl(hMax - hMin)} of relief across ${fmtKm(extentKm)}`);
  }

  // =========================================================================
  // HUD
  // =========================================================================
  const fmtEl = (m) => (unitsImp ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`);
  const fmtKm = (km) => (unitsImp ? `${(km * 0.621371).toFixed(1)} mi` : `${+km.toFixed(1)} km`);

  function updateHud() {
    if (!hudEl.ex) return;
    hudEl.ex.textContent = `${(+ex).toFixed(2).replace(/\.?0+$/, '')}×`;
    if (!ext) return;
    hudEl.hi.textContent = fmtEl(hMax);
    hudEl.lo.textContent = fmtEl(hMin);
    hudEl.rel.textContent = fmtEl(hMax - hMin);
    hudEl.slab.textContent = `${fmtKm(ext.extentKm)} · dem z${demZ}`;
  }

  function updateCompass() {
    // bearing of the camera as seen from the target; north is -Z
    const dx = camera.position.x - controls.target.x, dz = camera.position.z - controls.target.z;
    const camBear = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    if (lastHdg != null && Math.abs(camBear - lastHdg) < 0.4) return;
    lastHdg = camBear;
    // we look the other way; north then sits (180 - camBear)° clockwise of screen-up
    const view = (camBear + 180) % 360;
    if (rose) rose.style.transform = `rotate(${180 - camBear}deg)`;
    if (hudEl.hdg) hudEl.hdg.textContent = `${CARDINALS[Math.round(view / 45) % 8]} ${Math.round(view)}°`;
  }

  // =========================================================================
  // loop / sizing
  // =========================================================================
  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  addEventListener('resize', resize);

  function frame() {
    if (!visible || disposed) return;
    rafId = requestAnimationFrame(frame);
    const moved = controls.update();          // true while damping/auto-rotate is still moving
    if (moved) keepTargetOnSlab();
    if (moved || dirty) {
      dirty = false;
      updateCompass();
      renderer.render(scene, camera);
    }
  }

  // Panning off into the fog is disorienting: shift the whole camera rig back
  // rather than clamping the target alone, so the view angle is untouched.
  function keepTargetOnSlab() {
    if (!ext) return;
    const lim = ext.extentKm * 0.6, t = controls.target;
    const x = clamp(t.x, -lim, lim), z = clamp(t.z, -lim, lim);
    if (x !== t.x || z !== t.z) {
      camera.position.x += x - t.x;
      camera.position.z += z - t.z;
      t.x = x; t.z = z;
    }
  }

  controls.addEventListener('change', () => { dirty = true; });
  controls.addEventListener('end', () => {
    if (!ext || !onStateChange) return;
    const t = controls.target;
    if (Math.hypot(t.x, t.z) < ext.extentKm * 0.08) return;
    const lon = ext.lon + (t.x / ext.widthKm) * (ext.east - ext.west);
    const lat = ext.lat - (t.z / ext.heightKm) * (ext.north - ext.south);
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (key === lastReported) return;
    lastReported = key;
    try { onStateChange({lon, lat}); } catch { /* shell's problem, not ours */ }
  });

  updateSun();
  updateHud();

  // =========================================================================
  // public API
  // =========================================================================
  return {
    show() {
      if (disposed) return;
      visible = true;
      resize();
      dirty = true;
      if (!rafId) rafId = requestAnimationFrame(frame);
      // the shell normally follows show() with setView(); only build ourselves
      // if it does not, so the first open never fetches the same DEM twice
      if (!kicked) autoTimer = setTimeout(() => build(), 0);
    },

    hide() {
      visible = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;                     // nothing renders while the 2D map has the stage
      controls.autoRotate = false;
      const spin = extra?.querySelector('[data-k="spin"]');
      if (spin) spin.checked = false;
    },

    // cheap path: rewrite Y + normals from the cached heights, nothing else.
    // The drape is never touched — it is geographic, and both tints are computed
    // from true metres, so exaggeration cannot change them.
    setExaggeration(v) {
      const next = clamp(num(v, ex), 0.1, 100);
      if (next === ex) return;
      ex = next;
      applyHeights();
    },

    setOptions(o = {}) {
      if (!o || typeof o !== 'object' || disposed) return;
      let rebuild = false, redrape = false, relight = false;

      if (o.basemap != null && GRADE[o.basemap] && o.basemap !== bmKey) {
        bmKey = o.basemap;
        if (drapeMode === 'basemap') redrape = true;
      }
      if (o.sunAz != null) { sunAz = num(o.sunAz, sunAz); relight = true; }
      if (o.sunAlt != null) { sunAlt = num(o.sunAlt, sunAlt); relight = true; }
      if (o.units != null) { unitsImp = o.units === 'imperial'; updateHud(); }
      if (o.drape != null && o.drape !== drapeMode) {
        drapeMode = o.drape;
        const sel = extra?.querySelector('[data-k="drape"]');
        if (sel) sel.value = drapeMode;
        redrape = true;
      }
      if (o.extentKm != null && clamp(num(o.extentKm, 12), 1, 200) !== appliedExtentKm) rebuild = true;

      if (rebuild) build();
      else if (redrape) startDrape();
      if (relight) updateSun();
    },

    // Always rebuilds: the shell calls this deliberately (move, search, or the
    // explicit "Rebuild here" button), and re-centres the slab on this ground.
    setView(lon, lat, zoom) {
      if (disposed) return;
      wantLon = num(lon, wantLon);
      wantLat = num(lat, wantLat);
      if (zoom != null) state.zoom = num(zoom, state.zoom);
      build();
    },

    dispose() {
      disposed = true;
      visible = false;
      buildGen++;
      clearTimeout(autoTimer);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      abortCtl?.abort();
      removeEventListener('resize', resize);
      ro?.disconnect();
      controls.dispose();
      dropGeometry();
      sky.geometry.dispose();
      sky.material.dispose();
      terrainMat.map = terrainMat.emissiveMap = null;
      drapeTex?.dispose();
      terrainMat.dispose();
      skirtMat.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
      hud.remove();
      overlay.remove();
      extra?.remove();
    },

    // handy from the console; not part of the contract
    _debug: () => ({ext, demZ, hMin, hMax, ex, drapeMode, verts: heights?.length || 0}),
  };
}
