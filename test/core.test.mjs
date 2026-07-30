// Maths checks for the relief kernels. No framework: node test/core.test.mjs
//
// dem.js only touches the DOM inside functions, so importing it here is safe; we
// exercise its pure geometry and decoding, and all of shade.js.

import {
  hillshade, slopePercent, slopeDegrees, aspectDegrees,
  hypsoColor, gradientBandColor, gradientBand, GRADIENT_BANDS,
  contourSegments, contourInterval,
} from '../js/shade.js';
import {
  lonLatToTile, tileToLonLat, metresPerPixel, demZoomFor,
  decodeTerrarium, haversine, mppRowsForTile, DEM_MAX_Z, TILE_PX,
} from '../js/dem.js';

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
}
function near(name, got, want, tol = 1e-6) {
  const good = Math.abs(got - want) <= tol;
  ok(name, good, good ? '' : `got ${got}, want ${want} (±${tol})`);
}
function group(title) { results.push(`\n${title}`); }

// ---------------------------------------------------------------------------
// helpers: build padded synthetic rasters
// ---------------------------------------------------------------------------
const W = 8, H = 8, PAD = 1, SIZE = W + 2 * PAD, MPP = 10;

// f(gx, gy) -> metres, where gx/gy are unpadded pixel coords (may be -1 or W)
function build(f) {
  const a = new Float32Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) a[py * SIZE + px] = f(px - PAD, py - PAD);
  }
  return a;
}
const O = {size: SIZE, pad: PAD, mpp: MPP};

const flat     = build(() => 100);
const rampEast = build((gx) => 10 * gx);          // rises 10 m per 10 m eastward = 45°
const rampNorth = build((gx, gy) => -10 * gy);    // y grows south, so this rises northward

// ---------------------------------------------------------------------------
group('decode');
{
  // 0 m is the terrarium mid-point: R=128, G=0, B=0
  near('decode 0 m', decodeTerrarium(new Uint8ClampedArray([128, 0, 0, 255]))[0], 0);
  near('decode 1 m', decodeTerrarium(new Uint8ClampedArray([128, 1, 0, 255]))[0], 1);
  near('decode 256.5 m', decodeTerrarium(new Uint8ClampedArray([129, 0, 128, 255]))[0], 256.5);
  near('decode -100 m (below sea)',
       decodeTerrarium(new Uint8ClampedArray([127, 156, 0, 255]))[0], -100);
  near('decode 8848 m (Everest-ish)',
       decodeTerrarium(new Uint8ClampedArray([162, 144, 0, 255]))[0], 8848);
  const multi = decodeTerrarium(new Uint8ClampedArray([128, 0, 0, 255, 128, 10, 0, 255]));
  ok('decode handles multiple pixels', multi.length === 2 && multi[1] === 10);
  const reuse = new Float32Array(4);
  ok('decode reuses the out buffer',
     decodeTerrarium(new Uint8ClampedArray([128, 5, 0, 255]), reuse) === reuse);
}

// ---------------------------------------------------------------------------
group('slope');
{
  const sp = slopePercent(rampEast, W, H, O);
  const sd = slopeDegrees(rampEast, W, H, O);
  near('45° ramp reads 100%', sp[3 * W + 3], 100, 1e-4);
  near('45° ramp reads 45°', sd[3 * W + 3], 45, 1e-4);
  ok('slope is uniform across a plane',
     sp.every((v) => Math.abs(v - 100) < 1e-3));

  const fp = slopePercent(flat, W, H, O);
  ok('flat ground reads 0%', fp.every((v) => v === 0));

  // a 1-in-10 ramp is 10%
  const gentle = build((gx) => 1 * gx);           // 1 m rise per 10 m run
  near('1-in-10 reads 10%', slopePercent(gentle, W, H, O)[10], 10, 1e-4);

  // mpp must matter: same heights over 5 m pixels is twice as steep
  near('halving mpp doubles slope',
       slopePercent(gentle, W, H, {...O, mpp: 5})[10], 20, 1e-4);
}

// ---------------------------------------------------------------------------
group('aspect');
{
  const aE = aspectDegrees(rampEast, W, H, O);
  const aN = aspectDegrees(rampNorth, W, H, O);
  near('rising eastward faces west (270°)', aE[3 * W + 3], 270, 1e-4);
  near('rising northward faces south (180°)', aN[3 * W + 3], 180, 1e-4);
  ok('flat ground reports -1', aspectDegrees(flat, W, H, O)[0] === -1);
}

// ---------------------------------------------------------------------------
group('hillshade');
{
  const alt = 45, zen = 90 - alt;
  const hf = hillshade(flat, W, H, {...O, altitude: alt});
  near('flat ground equals cos(zenith)', hf[0], Math.cos(zen * Math.PI / 180), 1e-6);

  // a 45° west-facing slope, lit from due west at 45°: normal points straight at the
  // light, so it is fully lit. Lit from due east it sits exactly on the terminator.
  const litW = hillshade(rampEast, W, H, {...O, azimuth: 270, altitude: 45});
  const litE = hillshade(rampEast, W, H, {...O, azimuth: 90, altitude: 45});
  near('west-facing slope lit from west is 1.0', litW[3 * W + 3], 1, 1e-6);
  near('same slope lit from east is 0.0', litE[3 * W + 3], 0, 1e-6);

  // the cartographic default (NW light) must brighten NW-facing ground
  const nw = hillshade(build((gx, gy) => 5 * gx + 5 * gy), W, H, {...O});  // faces NW
  const se = hillshade(build((gx, gy) => -5 * gx - 5 * gy), W, H, {...O}); // faces SE
  ok('NW light favours NW-facing ground', nw[3 * W + 3] > se[3 * W + 3],
     `nw=${nw[3 * W + 3]} se=${se[3 * W + 3]}`);

  ok('output stays within 0..1',
     [...hillshade(rampEast, W, H, {...O, zFactor: 20})].every((v) => v >= 0 && v <= 1));

  // exaggeration changes shading but must never change a reported gradient
  const h1 = hillshade(rampEast, W, H, {...O, zFactor: 1})[3 * W + 3];
  const h5 = hillshade(rampEast, W, H, {...O, zFactor: 5})[3 * W + 3];
  ok('zFactor changes the shading', Math.abs(h1 - h5) > 1e-3, `${h1} vs ${h5}`);
  const s1 = slopePercent(rampEast, W, H, {...O, zFactor: 1})[3 * W + 3];
  const s5 = slopePercent(rampEast, W, H, {...O, zFactor: 5})[3 * W + 3];
  near('zFactor does NOT change slope%', s5, s1, 1e-9);

  // gentle ground should visibly gain relief when exaggerated — the app's whole premise
  const soft = build((gx) => 0.2 * gx);           // 2%
  const g1 = hillshade(soft, W, H, {...O, zFactor: 1})[3 * W + 3];
  const g20 = hillshade(soft, W, H, {...O, zFactor: 20})[3 * W + 3];
  ok('2% ground gains contrast at 20x', Math.abs(g20 - g1) > 0.05, `${g1} -> ${g20}`);

  const md = hillshade(rampEast, W, H, {...O, azimuth: 90, multiDirectional: true});
  ok('multi-directional lifts the terminator off zero', md[3 * W + 3] > 0.05,
     `got ${md[3 * W + 3]}`);

  // per-row mpp must be honoured
  const rows = new Float32Array(H).fill(10);
  rows[4] = 5;
  const perRow = slopePercent(build((gx) => 1 * gx), W, H, {size: SIZE, pad: PAD, mppRow: rows});
  near('mppRow row 0 -> 10%', perRow[0 * W + 3], 10, 1e-4);
  near('mppRow row 4 -> 20%', perRow[4 * W + 3], 20, 1e-4);

  // pad 0 must still work (edge-clamped), just not seam-free
  const unpadded = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) unpadded[y * W + x] = 1 * x;
  const noPad = slopePercent(unpadded, W, H, {size: W, pad: 0, mpp: MPP});
  near('pad 0 interior still correct', noPad[3 * W + 3], 10, 1e-4);
}

// ---------------------------------------------------------------------------
group('tile geometry');
{
  near('mpp at equator z0', metresPerPixel(0, 0), 156543.03392804097, 1e-6);
  near('mpp halves per zoom', metresPerPixel(0, 1), 156543.03392804097 / 2, 1e-6);
  near('mpp at 51.41° z14', metresPerPixel(51.412172, 14),
       156543.03392804097 * Math.cos(51.412172 * Math.PI / 180) / 16384, 1e-9);
  ok('mpp shrinks with latitude', metresPerPixel(60, 12) < metresPerPixel(0, 12));

  const [tx, ty] = lonLatToTile(-0.022933, 51.412172, 14);
  const [lon, lat] = tileToLonLat(tx, ty, 14);
  near('lon round-trips', lon, -0.022933, 1e-9);
  near('lat round-trips', lat, 51.412172, 1e-9);

  const [x0, y0] = lonLatToTile(-180, 85.0511287798066, 3);
  near('NW corner maps to tile 0,0 (x)', x0, 0, 1e-6);
  near('NW corner maps to tile 0,0 (y)', y0, 0, 1e-6);
  near('z0 centre is tile 0.5', lonLatToTile(0, 0, 0)[0], 0.5, 1e-9);

  ok('demZoomFor clamps to DEM_MAX_Z', demZoomFor(19) === DEM_MAX_Z);
  ok('demZoomFor rounds', demZoomFor(13.6) === 14);
  ok('demZoomFor floors at 0', demZoomFor(-3) === 0);

  const rows = mppRowsForTile(14, 5461, TILE_PX + 2, 1);
  ok('mppRowsForTile length', rows.length === TILE_PX + 2);
  ok('mppRowsForTile decreases northward→southward sensibly',
     rows[0] > 0 && Math.abs(rows[0] - rows[rows.length - 1]) < 0.05,
     `${rows[0]} .. ${rows[rows.length - 1]}`);
}

// ---------------------------------------------------------------------------
group('distance');
{
  // one degree of latitude is ~111.2 km anywhere
  near('1° latitude ≈ 111.2 km', haversine(0, 51, 0, 52) / 1000, 111.2, 0.3);
  // a degree of longitude shrinks by cos(lat)
  near('1° longitude at 51.4° ≈ 69.5 km',
       haversine(0, 51.412172, 1, 51.412172) / 1000, 69.5, 0.4);
  near('zero distance', haversine(1, 1, 1, 1), 0, 1e-9);
}

// ---------------------------------------------------------------------------
group('gradient bands + hypso');
{
  ok('below 3% is untinted', gradientBandColor(1.5) === null);
  ok('NaN is untinted', gradientBandColor(NaN) === null);
  ok('4% lands in the 3–6 band', gradientBandColor(4)[0] === GRADIENT_BANDS[1].color[0]);
  ok('25% lands in the top band',
     gradientBandColor(25)[0] === GRADIENT_BANDS[GRADIENT_BANDS.length - 1].color[0]);
  ok('band alpha rises with severity',
     GRADIENT_BANDS.every((b, i) => i === 0 || b.alpha > GRADIENT_BANDS[i - 1].alpha));
  ok('bands are contiguous and ascending',
     GRADIENT_BANDS.every((b, i) => i === 0 || b.min === GRADIENT_BANDS[i - 1].max));
  ok('gradientBand always resolves', gradientBand(0).hint === 'flat-ish' &&
     gradientBand(99).hint === 'walk it');

  const lowC = hypsoColor(0, 0, 100), highC = hypsoColor(100, 0, 100);
  ok('hypso ramps light with height', highC[0] > lowC[0] && highC[2] > lowC[2]);
  ok('hypso clamps below range', hypsoColor(-50, 0, 100).every((v, i) => v === lowC[i]));
  ok('hypso clamps above range', hypsoColor(500, 0, 100).every((v, i) => v === highC[i]));
  ok('hypso survives a zero-width range',
     hypsoColor(5, 5, 5).every((v) => Number.isFinite(v)));
  ok('hypso stays in 0..255',
     [0, 25, 50, 75, 100].every((m) => hypsoColor(m, 0, 100).every((v) => v >= 0 && v <= 255)));
}

// ---------------------------------------------------------------------------
group('contours');
{
  const cs = contourSegments(rampEast, W, H, {size: SIZE, pad: PAD, interval: 10});
  ok('produces levels', cs.length > 0, `got ${cs.length}`);
  ok('every level is a multiple of the interval', cs.every((c) => c.level % 10 === 0));
  ok('levels sit inside the data range',
     cs.every((c) => c.level >= 0 && c.level <= 70), cs.map((c) => c.level).join(','));
  ok('levels ascend', cs.every((c, i) => i === 0 || c.level > cs[i - 1].level));
  ok('segments come in x0,y0,x1,y1 quads', cs.every((c) => c.segs.length % 4 === 0));
  ok('segment coords stay in the raster',
     cs.every((c) => [...c.segs].every((v) => v >= -0.001 && v <= W + 0.001)));

  ok('flat ground yields no contours',
     contourSegments(flat, W, H, {size: SIZE, pad: PAD, interval: 10}).length === 0);

  const holed = build((gx) => 10 * gx);
  holed[3 * SIZE + 3] = NaN;
  ok('a NaN hole does not produce NaN coordinates',
     contourSegments(holed, W, H, {size: SIZE, pad: PAD, interval: 10})
       .every((c) => [...c.segs].every(Number.isFinite)));

  ok('interval respects zoom', contourInterval(9, 100) >= 25);
  ok('interval gets finer when zoomed in', contourInterval(15, 40) <= contourInterval(9, 40));
  ok('interval never returns 0', [0, 5, 10, 14, 18].every((z) => contourInterval(z, 5) > 0));
}

// ---------------------------------------------------------------------------
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
