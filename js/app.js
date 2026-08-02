// Shell: owns shared state, the control panel, mode switching and persistence.
// The two view modules (map2d / view3d) and the profile tool are loaded lazily so
// that three.js never costs anything until the 3D view is actually opened, and so
// one broken module cannot blank the whole app.

import {NATIVE} from './platform.js';
import {Geolocation} from '@capacitor/geolocation';

const HOME_DEFAULT = {lat: 51.412172, lon: -0.022933};   // user's home (South London)
const LS_KEY = 'relief-app/state/v1';

const $ = (id) => document.getElementById(id);

// ---------- status line + readout (global, always safe to call) ----------
let statusTimer = null;
window.reliefStatus = (msg, isErr = false) => {
  const el = $('status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
  el.classList.toggle('on', !!msg);
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => el.classList.remove('on'), isErr ? 8000 : 3200);
};
window.reliefReadout = (text) => {
  const el = $('readout');
  if (!el) return;
  el.innerHTML = text || '';
  el.classList.toggle('on', !!text);
};

function fatal(msg) {
  $('fatalMsg').textContent = msg;
  $('fatal').classList.add('on');
  console.error('[relief]', msg);
}

// ---------- state ----------
const state = {
  mode: '2d',
  lon: HOME_DEFAULT.lon, lat: HOME_DEFAULT.lat, zoom: 14,
  ex2d: 6, ex3d: 4,
  basemap: 'light',           // resolved provider actually sent to the view modules
  mapType: 'roads',           // 'none' | 'roads' | 'sat' — what the shell UI shows
  roadsStyle: 'light',        // provider used when mapType is 'roads', and by the 3D drape
  reliefMix: 1,               // 0..1 — remembered even while mapType is 'none' and the slider is hidden
  layers: {hillshade: true, multi: false, gradient: true, hypso: false, contours: false},
  sunAz: 315, sunAlt: 45,
  extentKm: 12,
  units: 'metric',
  home: {...HOME_DEFAULT},
};

const ROADS_STYLES = new Set(['light', 'osm', 'topo', 'dark']);

// state.basemap is the resolved value the view modules actually consume; mapType +
// roadsStyle are what the "Map type" UI shows. Keep the former derived from the latter.
function resolveBasemap() {
  return state.mapType === 'none' ? 'none' : state.mapType === 'sat' ? 'sat' : state.roadsStyle;
}
// 3D never sees 'none' — a bare, untextured terrain slab was not asked for, and the
// module was not built or tested for it. It keeps showing the last real map style.
function resolveBasemap3d() {
  return state.mapType === 'sat' ? 'sat' : state.roadsStyle;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    Object.assign(state, saved, {layers: {...state.layers, ...(saved.layers || {})},
                                 home: {...state.home, ...(saved.home || {})}});
  } catch { /* corrupt or unavailable storage — defaults are fine */ }

  // the URL hash wins, so a shared link always lands where it says
  const h = new URLSearchParams(location.hash.slice(1));
  const num = (k, fallback) => (h.has(k) && isFinite(+h.get(k)) ? +h.get(k) : fallback);
  state.lat = num('lat', state.lat);
  state.lon = num('lon', state.lon);
  state.zoom = num('z', state.zoom);
  state.ex2d = num('ex2d', state.ex2d);
  state.ex3d = num('ex3d', state.ex3d);
  if (h.get('m') === '3d' || h.get('m') === '2d') state.mode = h.get('m');

  // mt/rs/mix are the current scheme; a bare b= (URL) or state.basemap (localStorage,
  // merged above) is an older link/save from before this feature and gets inferred.
  if (!h.get('mt')) {
    const b = h.get('b') || state.basemap;
    if (b) {
      state.mapType = b === 'none' ? 'none' : b === 'sat' ? 'sat' : 'roads';
      if (ROADS_STYLES.has(b)) state.roadsStyle = b;
    }
  }
  if (h.get('mt')) state.mapType = h.get('mt');
  if (h.get('rs') && ROADS_STYLES.has(h.get('rs'))) state.roadsStyle = h.get('rs');
  if (!['none', 'roads', 'sat'].includes(state.mapType)) state.mapType = 'roads';
  if (!ROADS_STYLES.has(state.roadsStyle)) state.roadsStyle = 'light';
  state.reliefMix = Math.min(1, Math.max(0, num('mix', state.reliefMix)));
  state.basemap = resolveBasemap();
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
    const h = new URLSearchParams({
      m: state.mode, lat: state.lat.toFixed(5), lon: state.lon.toFixed(5),
      z: String(Math.round(state.zoom)), ex2d: String(state.ex2d), ex3d: String(state.ex3d),
      mt: state.mapType, rs: state.roadsStyle, mix: state.reliefMix.toFixed(2),
    });
    history.replaceState(null, '', `#${h}`);
  }, 400);
}

// ---------- module loading ----------
let map2d = null, view3d = null, profile = null, shade = null, dem = null;
let load2dPromise = null, load3dPromise = null;

async function get2d() {
  if (map2d) return map2d;
  if (!load2dPromise) load2dPromise = (async () => {
    const mod = await import('./map2d.js');
    map2d = mod.create2D({
      container: $('map2d'), state,
      onStateChange: (s) => {
        if (s.lat != null) state.lat = s.lat;
        if (s.lon != null) state.lon = s.lon;
        if (s.zoom != null) state.zoom = s.zoom;
        saveState();
      },
    });
    // reliefMix isn't part of create2D's constructor read, unlike basemap/layers/sun
    map2d.setOptions({reliefOpacity: state.mapType === 'none' ? 1 : state.reliefMix});
    return map2d;
  })().catch((e) => {
    load2dPromise = null;
    fatal(`The 2D map module failed: ${e.message}`);
    throw e;
  });
  return load2dPromise;
}

async function get3d() {
  if (view3d) return view3d;
  if (!load3dPromise) load3dPromise = (async () => {
    const mod = await import('./view3d.js');
    view3d = mod.create3D({
      container: $('view3d'), state,
      onStateChange: (s) => {
        if (s.lat != null) state.lat = s.lat;
        if (s.lon != null) state.lon = s.lon;
        saveState();
      },
    });
    // create3D reads state.basemap verbatim at construction, which may be 'none' if
    // that was the restored 2D map type — 3D has no such mode, so correct it here.
    if (state.mapType === 'none') view3d.setOptions({basemap: resolveBasemap3d()});
    return view3d;
  })().catch((e) => {
    load3dPromise = null;
    fatal(`The 3D view module failed: ${e.message}`);
    throw e;
  });
  return load3dPromise;
}

async function getProfile() {
  if (profile) return profile;
  const mod = await import('./profile.js');
  profile = mod.createProfile({container: $('panel-profile'), getMap: () => map2d?.getMap()});
  profile.setUnits?.(state.units);
  return profile;
}

// ---------- mode switching ----------
let built3dAt = null;   // where the 3D slab was last built, so we rebuild only on real movement

async function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-2d', mode === '2d');
  document.body.classList.toggle('mode-3d', mode === '3d');
  $('btn2d').classList.toggle('on', mode === '2d');
  $('btn3d').classList.toggle('on', mode === '3d');
  $('map2d').classList.toggle('hidden', mode !== '2d');
  $('view3d').classList.toggle('shown', mode === '3d');
  syncExSlider();
  saveState();

  if (mode === '2d') {
    view3d?.hide();
    const m = await get2d();
    m.show(); m.invalidate();
    if (tracking && lastFix) m.setUserLocation(lastFix);  // dot went stale while in 3D
  } else {
    map2d?.hide();
    window.reliefStatus('building terrain…');
    const v = await get3d();
    v.show();
    const moved = !built3dAt ||
      Math.hypot(built3dAt.lat - state.lat, built3dAt.lon - state.lon) > 0.002 ||
      built3dAt.extentKm !== state.extentKm;
    if (moved) {
      v.setView(state.lon, state.lat, state.zoom);
      built3dAt = {lat: state.lat, lon: state.lon, extentKm: state.extentKm};
    }
  }
}

// ---------- exaggeration slider (one control, two meanings) ----------
const EX_CFG = {
  '2d': {min: 1, max: 25, step: 0.5, label: 'Hillshade relief',
         title: 'Relief exaggeration',
         hint: (v) => v <= 1.2 ? 'True shading — as flat as every other map.'
             : v < 4  ? 'Gentle. Main valleys show.'
             : v < 9  ? 'Sweet spot for lowland England.'
             : v < 16 ? 'Strong. Every lane and embankment pops.'
             : 'Extreme — shape only, ignore the drama.'},
  '3d': {min: 1, max: 15, step: 0.25, label: 'Vertical scale',
         title: 'Vertical exaggeration',
         hint: (v) => v <= 1.2 ? 'True proportions. Hills look disappointing — they are.'
             : v < 3  ? 'Mild lift, still believable.'
             : v < 7  ? 'Reads like a relief model.'
             : 'Alpine drama on London clay.'},
};

function syncExSlider() {
  const cfg = EX_CFG[state.mode];
  const sl = $('exSlider');
  const v = state.mode === '2d' ? state.ex2d : state.ex3d;
  sl.min = cfg.min; sl.max = cfg.max; sl.step = cfg.step; sl.value = v;
  $('exTitle').textContent = cfg.title;
  $('exLabel').textContent = cfg.label;
  paintEx(v);
}

function paintEx(v) {
  const cfg = EX_CFG[state.mode];
  const sl = $('exSlider');
  $('exVal').textContent = `${(+v).toFixed(state.mode === '2d' ? 1 : 2).replace(/\.00?$/, '')}×`;
  $('exHint').textContent = cfg.hint(+v);
  sl.style.setProperty('--pct', `${(v - cfg.min) / (cfg.max - cfg.min) * 100}%`);
}

function applyEx(v) {
  v = +v;
  if (state.mode === '2d') { state.ex2d = v; map2d?.setExaggeration(v); }
  else { state.ex3d = v; view3d?.setExaggeration(v); }
  paintEx(v);
  saveState();
}

function bumpEx(dir) {
  const cfg = EX_CFG[state.mode];
  const cur = state.mode === '2d' ? state.ex2d : state.ex3d;
  const next = Math.min(cfg.max, Math.max(cfg.min, cur + dir * cfg.step * 2));
  $('exSlider').value = next;
  applyEx(next);
}

// ---------- generic range fill ----------
function paintRange(el) {
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--pct', `${pct}%`);
}

// ---------- layers ----------
function pushLayers() {
  map2d?.setOptions({layers: {...state.layers}});
  document.body.classList.toggle('grad-on', state.layers.gradient);
  saveState();
}

function bindLayer(id, key) {
  const el = $(id);
  el.checked = !!state.layers[key];
  el.addEventListener('change', () => { state.layers[key] = el.checked; pushLayers(); });
}

// ---------- legend, built from shade.js so colours can never drift ----------
async function buildLegend() {
  try {
    shade = await import('./shade.js');
  } catch (e) {
    $('legendGroup').style.display = 'none';
    return;
  }
  const bands = shade.GRADIENT_BANDS || [];
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  $('legend').innerHTML = bands.map((b) => {
    const range = b.max === Infinity ? `${b.min}%+` : `${b.min}–${b.max}%`;
    return `<div class="lrow"><i class="sw" style="background:${rgb(b.color)}"></i>` +
           `<span>${range}</span><span>${b.hint || ''}</span></div>`;
  }).join('');
}

// ---------- search ----------
let searchAbort = null;
async function doSearch() {
  const q = $('search').value.trim();
  if (!q) return;
  window.reliefStatus(`searching “${q}”…`);
  searchAbort?.abort();
  searchAbort = new AbortController();
  try {
    const url = NATIVE
      ? `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`
      : `/geocode?q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {signal: searchAbort.signal, headers: NATIVE ? {'Accept-Language': 'en'} : undefined});
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) { window.reliefStatus('nothing found', true); return; }
    showResults(list);
    window.reliefStatus('');
  } catch (e) {
    if (e.name !== 'AbortError') window.reliefStatus(`search failed: ${e.message}`, true);
  }
}

function showResults(list) {
  const box = $('results');
  box.innerHTML = list.map((r, i) => {
    const parts = (r.display_name || '').split(', ');
    return `<div data-i="${i}"><b>${parts[0]}</b> <small>${parts.slice(1, 4).join(', ')}</small></div>`;
  }).join('');
  box.classList.add('open');
  box.querySelectorAll('div[data-i]').forEach((el) => {
    el.addEventListener('click', () => {
      const r = list[+el.dataset.i];
      box.classList.remove('open');
      $('search').blur();
      goTo(+r.lon, +r.lat, 14);
    });
  });
}

function goTo(lon, lat, zoom = state.zoom) {
  state.lon = lon; state.lat = lat; state.zoom = zoom;
  if (state.mode === '2d') map2d?.setView(lon, lat, zoom);
  else {
    view3d?.setView(lon, lat, zoom);
    built3dAt = {lat, lon, extentKm: state.extentKm};
  }
  saveState();
}

// ---------- live location: pulsing dot, Google-Maps style ----------
// One button, toggled: first press asks permission, centres the map on the first
// fix, and starts a live watch; second press stops it and clears the dot.
let tracking = false, watchId = null, gotFirstFix = false, lastFix = null;

async function ensureLocationPermission() {
  if (!NATIVE) return true;      // the browser handles its own consent prompt inline
  let status = await Geolocation.checkPermissions();
  if (status.location === 'granted' || status.coarseLocation === 'granted') return true;
  status = await Geolocation.requestPermissions();
  return status.location === 'granted' || status.coarseLocation === 'granted';
}

function onFix(lat, lon, accuracy, heading) {
  lastFix = {lat, lon, accuracy, heading};
  if (state.mode === '2d') map2d?.setUserLocation(lastFix);
  if (!gotFirstFix) { gotFirstFix = true; goTo(lon, lat, 14); }
  window.reliefStatus('tracking your location');
}

function stopTracking() {
  if (watchId != null) {
    if (NATIVE) Geolocation.clearWatch({id: watchId});
    else navigator.geolocation.clearWatch(watchId);
  }
  watchId = null; tracking = false; gotFirstFix = false; lastFix = null;
  map2d?.setUserLocation(null);
  $('locate').classList.remove('on');
  window.reliefStatus('');
}

async function startTracking() {
  window.reliefStatus('locating…');
  const ok = await ensureLocationPermission();
  if (!ok) { window.reliefStatus('location permission denied', true); return; }
  tracking = true;
  $('locate').classList.add('on');
  if (NATIVE) {
    // plain navigator.geolocation needs the host app to implement WebView's
    // onGeolocationPermissionsShowPrompt, which Capacitor's bridge doesn't — the
    // native plugin talks to Android's location APIs directly instead.
    watchId = await Geolocation.watchPosition({enableHighAccuracy: true, timeout: 10000},
      (pos, err) => {
        if (err) { window.reliefStatus(`location error: ${err.message}`, true); return; }
        onFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.heading);
      });
    return;
  }
  if (!navigator.geolocation) {
    window.reliefStatus('no geolocation in this browser', true);
    tracking = false; $('locate').classList.remove('on');
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (p) => onFix(p.coords.latitude, p.coords.longitude, p.coords.accuracy, p.coords.heading),
    (e) => window.reliefStatus(`location error: ${e.message}`, true),
    {enableHighAccuracy: true, timeout: 10000, maximumAge: 5000});
}

function toggleTracking() {
  if (tracking) stopTracking(); else startTracking();
}

// ---------- profile dock ----------
async function toggleDraw() {
  if (state.mode !== '2d') await setMode('2d');
  try {
    const p = await getProfile();
    $('profileDock').classList.add('open');
    if (p.isActive?.()) { p.disable(); $('drawProfile').classList.remove('on'); }
    else { p.enable(); $('drawProfile').classList.add('on'); }
  } catch (e) {
    window.reliefStatus(`profile tool unavailable: ${e.message}`, true);
  }
}

// ---------- wiring ----------
function wire() {
  $('btn2d').onclick = () => setMode('2d');
  $('btn3d').onclick = () => setMode('3d');

  const sl = $('exSlider');
  sl.addEventListener('input', () => applyEx(sl.value));
  document.querySelectorAll('button.act[data-ex]').forEach((b) => {
    b.onclick = () => {
      const cfg = EX_CFG[state.mode];
      const v = Math.min(cfg.max, +b.dataset.ex);
      sl.value = v; applyEx(v);
    };
  });

  bindLayer('lyHillshade', 'hillshade');
  bindLayer('lyMulti', 'multi');
  bindLayer('lyGradient', 'gradient');
  bindLayer('lyHypso', 'hypso');
  bindLayer('lyContours', 'contours');

  // ---- map type: none / roads / satellite, plus the roads style and the crossfade ----
  const roadsStyleSel = $('roadsStyle');
  const mixSlider = $('mapMix');

  function syncMapTypeUI() {
    document.querySelectorAll('#mapType button').forEach((b) =>
      b.classList.toggle('on', b.dataset.type === state.mapType));
    $('roadsStyleRow').style.display = state.mapType === 'roads' ? '' : 'none';
    $('mixRow').style.display = state.mapType === 'none' ? 'none' : '';
  }

  function pushBasemap() {
    state.basemap = resolveBasemap();
    map2d?.setOptions({basemap: state.basemap});
    view3d?.setOptions({basemap: resolveBasemap3d()});
    // nothing to mix against with no map — force relief fully on without touching the
    // remembered slider value, so it is right where the user left it if they come back
    map2d?.setOptions({reliefOpacity: state.mapType === 'none' ? 1 : state.reliefMix});
  }

  document.querySelectorAll('#mapType button').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.type === state.mapType) return;
      state.mapType = btn.dataset.type;
      syncMapTypeUI();
      pushBasemap();
      saveState();
    };
  });

  roadsStyleSel.value = state.roadsStyle;
  roadsStyleSel.onchange = () => {
    state.roadsStyle = roadsStyleSel.value;
    pushBasemap();
    saveState();
  };

  mixSlider.value = Math.round(state.reliefMix * 100);
  $('mapMixVal').textContent = `${mixSlider.value}%`;
  paintRange(mixSlider);
  mixSlider.addEventListener('input', () => {
    state.reliefMix = +mixSlider.value / 100;
    $('mapMixVal').textContent = `${mixSlider.value}%`;
    paintRange(mixSlider);
    if (state.mapType !== 'none') map2d?.setOptions({reliefOpacity: state.reliefMix});
  });
  mixSlider.addEventListener('change', saveState);   // persist once, on release

  syncMapTypeUI();

  for (const [id, key, fmt] of [['sunAz', 'sunAz', (v) => `${v}°`],
                                ['sunAlt', 'sunAlt', (v) => `${v}°`]]) {
    const el = $(id);
    el.value = state[key];
    paintRange(el);
    el.addEventListener('input', () => {
      state[key] = +el.value;
      $(`${id}Val`).textContent = fmt(el.value);
      paintRange(el);
      map2d?.setOptions({sunAz: state.sunAz, sunAlt: state.sunAlt});
      view3d?.setOptions({sunAz: state.sunAz, sunAlt: state.sunAlt});
      saveState();
    });
  }

  const ex = $('extent');
  ex.value = state.extentKm;
  paintRange(ex);
  ex.addEventListener('input', () => {
    state.extentKm = +ex.value;
    $('extentVal').textContent = `${ex.value} km`;
    paintRange(ex);
  });
  ex.addEventListener('change', () => {          // rebuild on release, not every pixel
    view3d?.setOptions({extentKm: state.extentKm});
    built3dAt = {lat: state.lat, lon: state.lon, extentKm: state.extentKm};
    saveState();
  });
  $('rebuild3d').onclick = () => {
    view3d?.setView(state.lon, state.lat, state.zoom);
    built3dAt = {lat: state.lat, lon: state.lon, extentKm: state.extentKm};
  };

  $('searchGo').onclick = doSearch;
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
    if (e.key === 'Escape') { $('results').classList.remove('open'); $('search').blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!$('searchWrap').contains(e.target)) $('results').classList.remove('open');
  });
  $('locate').onclick = toggleTracking;

  $('drawProfile').onclick = toggleDraw;
  $('clearProfile').onclick = () => {
    profile?.clear();
    profile?.disable();
    $('drawProfile').classList.remove('on');
  };
  $('profileClose').onclick = () => {
    $('profileDock').classList.remove('open');
    profile?.disable();
    $('drawProfile').classList.remove('on');
  };

  const units = $('unitsImperial');
  units.checked = state.units === 'imperial';
  units.onchange = () => {
    state.units = units.checked ? 'imperial' : 'metric';
    profile?.setUnits?.(state.units);
    map2d?.setOptions({units: state.units});
    view3d?.setOptions({units: state.units});
    saveState();
  };

  $('goHome').onclick = () => goTo(state.home.lon, state.home.lat, 14);
  $('setHome').onclick = () => {
    state.home = {lat: state.lat, lon: state.lon};
    saveState();
    window.reliefStatus('home set to this view');
  };

  $('panelToggle').onclick = () => {
    const p = $('panel');
    p.classList.toggle('collapsed');
    $('panelToggle').textContent = p.classList.contains('collapsed') ? '+' : '−';
  };

  // keyboard — skipped while typing in the search box
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const tog = (id) => { const el = $(id); el.checked = !el.checked; el.dispatchEvent(new Event('change')); };
    if (k === '1') setMode('2d');
    else if (k === '2') setMode('3d');
    else if (k === '[') bumpEx(-1);
    else if (k === ']') bumpEx(1);
    else if (k === 'h') tog('lyHillshade');
    else if (k === 'm') tog('lyMulti');
    else if (k === 'g') tog('lyGradient');
    else if (k === 'e') tog('lyHypso');
    else if (k === 'c') tog('lyContours');
    else if (k === 'p') toggleDraw();
    else if (k === '/') { e.preventDefault(); $('search').focus(); }
    else return;
    e.preventDefault();
  });
}

// ---------- boot ----------
async function boot() {
  loadState();
  wire();
  $('sunAzVal').textContent = `${state.sunAz}°`;
  $('sunAltVal').textContent = `${state.sunAlt}°`;
  $('extentVal').textContent = `${state.extentKm} km`;
  document.body.classList.toggle('grad-on', state.layers.gradient);
  buildLegend();
  try {
    dem = await import('./dem.js');           // warm the module + surface an early failure
  } catch (e) {
    fatal(`Could not load the elevation module (js/dem.js): ${e.message}`);
    return;
  }
  await setMode(state.mode);
  window.reliefStatus('ready — drag the exaggeration slider');
  // expose for console poking
  window.relief = {state, get2d, get3d, getProfile, goTo};
}

boot().catch((e) => fatal(e.message));
