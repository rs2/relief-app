// Checks on the route-profile statistics — the numbers a cyclist actually trusts.
//   node test/profile.test.mjs

import {_internals as P} from '../js/profile.js';

const {smoothByDistance, ascentDescent, maxSustained, segmentGradients,
       fillGaps, haversineM, elevAtDist} = P;

let pass = 0, fail = 0;
const out = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; out.push(`  ok   ${name}`); }
  else { fail++; out.push(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};
const near = (name, got, want, tol = 1e-6) =>
  ok(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} (±${tol})`);
const group = (t) => out.push(`\n${t}`);

// uniform 25 m sampling, as buildTrack produces
function series(n, fn, step = 25) {
  const dist = new Float64Array(n), elev = new Float64Array(n);
  for (let i = 0; i < n; i++) { dist[i] = i * step; elev[i] = fn(i * step, i); }
  return {dist, elev};
}

// ---------------------------------------------------------------------------
group('smoothing must not eat the ends');
{
  // a dead-straight 8% climb: smoothing must return it untouched, endpoints included
  const {dist, elev} = series(40, (d) => d * 0.08);
  const sm = smoothByDistance(dist, elev, 75);
  let worst = 0, worstAt = -1;
  for (let i = 0; i < elev.length; i++) {
    const e = Math.abs(sm[i] - elev[i]);
    if (e > worst) { worst = e; worstAt = i; }
  }
  ok('constant 8% gradient survives smoothing exactly', worst < 1e-9,
     `worst error ${worst.toExponential(2)} m at sample ${worstAt}`);

  // the first 100 m of a climb must still read 8% after smoothing
  const g0 = (sm[4] - sm[0]) / (dist[4] - dist[0]) * 100;
  near('gradient over the first 100 m stays 8%', g0, 8, 1e-9);
  const gN = (sm[39] - sm[35]) / (dist[39] - dist[35]) * 100;
  near('gradient over the last 100 m stays 8%', gN, 8, 1e-9);

  // and it must still actually smooth: a one-sample spike gets knocked down
  const spike = series(40, (d) => d * 0.02);
  spike.elev[20] += 6;
  const ss = smoothByDistance(spike.dist, spike.elev, 75);
  ok('a 6 m single-sample spike is attenuated', ss[20] - spike.dist[20] * 0.02 < 3,
     `residual ${(ss[20] - spike.dist[20] * 0.02).toFixed(2)} m`);

  // degenerate inputs
  ok('n=0 survives', smoothByDistance(new Float64Array(0), new Float64Array(0), 75).length === 0);
  ok('n=2 survives', smoothByDistance(new Float64Array([0, 25]),
                                      new Float64Array([0, 2]), 75).length === 2);
  const flat = series(20, () => 42);
  ok('flat stays flat', [...smoothByDistance(flat.dist, flat.elev, 75)]
     .every((v) => Math.abs(v - 42) < 1e-9));
}

// ---------------------------------------------------------------------------
group('ascent / descent');
{
  // straight up 100 m, then straight back down
  const up = new Float64Array(51), down = new Float64Array(50);
  for (let i = 0; i <= 50; i++) up[i] = i * 2;
  for (let i = 0; i < 50; i++) down[i] = 100 - (i + 1) * 2;
  const both = Float64Array.from([...up, ...down]);
  const r = ascentDescent(both, 2);
  near('climbs 100 m', r.asc, 100, 1e-9);
  near('descends 100 m', r.desc, 100, 1e-9);

  // pure noise must not accumulate into fake climbing
  const noisy = new Float64Array(400);
  for (let i = 0; i < 400; i++) noisy[i] = 50 + (i % 2 ? 0.6 : -0.6);
  const n = ascentDescent(noisy, 2);
  ok('±0.6 m sawtooth adds almost no ascent', n.asc < 3, `got ${n.asc.toFixed(2)} m`);

  // a real climb hidden under noise is still counted in full
  const real = new Float64Array(200);
  for (let i = 0; i < 200; i++) real[i] = i * 0.5 + (i % 2 ? 0.4 : -0.4);
  const rr = ascentDescent(real, 2);
  ok('a 100 m climb under noise still reads ~100 m',
     Math.abs(rr.asc - 99.5) < 4, `got ${rr.asc.toFixed(2)} m`);
  ok('flat ground has no ascent', ascentDescent(new Float64Array(50).fill(7), 2).asc === 0);
}

// ---------------------------------------------------------------------------
group('max sustained gradient');
{
  // 8% throughout -> the headline number is 8%
  const s = series(60, (d) => d * 0.08);
  const m = maxSustained(s.dist, s.elev, 100);
  near('uniform 8% reports 8%', m.pct, 8, 1e-6);
  near('window is the full 100 m', m.windowM, 100, 1e-9);

  // a short brutal ramp must not be diluted by the flat around it, nor exaggerated:
  // 100 m at 20% sitting inside otherwise flat ground
  const t = series(60, (d) => (d >= 500 && d <= 600 ? (d - 500) * 0.20 : d > 600 ? 20 : 0));
  const mt = maxSustained(t.dist, t.elev, 100);
  near('a 100 m wall at 20% reports 20%', mt.pct, 20, 1e-6);
  near('and locates it', mt.d0, 500, 1e-6);

  // a 25 m spike must NOT report as a sustained gradient
  const spike = series(60, (d) => (Math.abs(d - 500) < 13 ? 5 : 0));
  const ms = maxSustained(spike.dist, spike.elev, 100);
  ok('a 25 m spike does not become a sustained gradient', ms.pct <= 5.1,
     `got ${ms.pct.toFixed(2)}%`);

  // a line shorter than the window is measured whole and says so
  const short = series(3, (d) => d * 0.10);
  const msh = maxSustained(short.dist, short.elev, 100);
  near('short line uses its own length', msh.windowM, 50, 1e-9);
  near('short line gradient', msh.pct, 10, 1e-6);

  // downhill only -> best sustained climb is negative, not zero
  const dn = series(40, (d) => -d * 0.05);
  ok('a pure descent reports a negative best climb', maxSustained(dn.dist, dn.elev, 100).pct < 0);
}

// ---------------------------------------------------------------------------
group('segment gradients + gap filling');
{
  const s = series(40, (d) => d * 0.06);
  const g = segmentGradients(s.dist, s.elev);
  ok('every segment of a 6% climb reads ~6%',
     [...g].every((v) => Math.abs(v - 6) < 1e-6), `e.g. ${g[0]}, ${g[g.length - 1]}`);
  ok('one gradient per segment', g.length === s.dist.length - 1);

  const holed = Float64Array.from([10, NaN, NaN, 40, 50]);
  const bad = fillGaps(holed);
  ok('gap filling reports the hole count', bad === 2, `got ${bad}`);
  ok('holes are bridged linearly',
     Math.abs(holed[1] - 20) < 1e-9 && Math.abs(holed[2] - 30) < 1e-9,
     `${holed[1]}, ${holed[2]}`);
  const leading = Float64Array.from([NaN, NaN, 30, 40]);
  fillGaps(leading);
  ok('leading holes clamp to the first real value', leading[0] === 30 && leading[1] === 30);
  const trailing = Float64Array.from([10, 20, NaN]);
  fillGaps(trailing);
  ok('trailing holes clamp to the last real value', trailing[2] === 20);
  ok('an all-hole series reports -1', fillGaps(Float64Array.from([NaN, NaN])) === -1);
}

// ---------------------------------------------------------------------------
group('geometry');
{
  near('1° latitude ≈ 111.2 km', haversineM(51, 0, 52, 0) / 1000, 111.2, 0.3);
  near('same point is 0 m', haversineM(51.4, -0.02, 51.4, -0.02), 0, 1e-9);
  // 8 m over 100 m is 8%
  const {dist, elev} = series(5, (d) => d * 0.08);
  near('interpolates mid-sample', elevAtDist(dist, elev, 37.5), 3, 1e-9);
  near('clamps below range', elevAtDist(dist, elev, -10), 0, 1e-9);
  near('clamps above range', elevAtDist(dist, elev, 1e6), elev[4], 1e-9);
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
