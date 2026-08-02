# Bike Terrain — exaggerated hills for cyclists

Ordinary online maps make everywhere look flat. This one lets you crank the vertical
relief until the hills actually read, in two modes:

- **2D map** — real hillshading computed in the browser, with an exaggeration slider
  that goes to 25× (standard web maps cap out around 1×), plus gradient bands coloured
  by how much a climb will hurt.
- **3D view** — the same terrain as a solid model you can orbit, with its own vertical
  exaggeration slider.

Elevation is AWS Terrarium DEM (≈6 m per pixel at London's latitude, and over the UK it
is backed by Environment Agency 2 m LiDAR, so lanes, embankments and cuttings show up).

## Running it

1. `cd relief-app`
2. `node serve.js 8099`
3. Open http://localhost:8099

No npm install, no build step — Leaflet and three.js
are vendored in `vendor/`, and everything else is plain ES modules.

Opening `index.html` straight off disk will *not* work: ES modules and canvas pixel
access both need a real HTTP origin.

Pass a port if 8099 is taken: `node serve.js 8100`.

## The two sliders

They mean different things, deliberately:

| Mode | Slider | What it does |
|---|---|---|
| 2D | 1–25× | Multiplies the terrain gradient *before* lighting it. Shadows deepen and stretch; the map geometry never moves. |
| 3D | 1–15× | Multiplies actual vertical geometry. The model gets taller. |

**Numbers never lie.** Exaggeration only ever affects shading and geometry. Every
gradient percentage, contour label and profile statistic is computed from true
elevation at 1×. If it says 11%, it is 11%.

For lowland England, 6–10× in 2D is the sweet spot; at 1× South London looks like a
table, which is exactly the problem this app exists to fix.

## Map type

In 2D, the **Map type** control switches between three underlying maps:

- **None** — relief only, no tiles fetched at all.
- **Roads** — OpenStreetMap, Carto (light/dark) or OpenTopoMap, picked from the *Style*
  dropdown.
- **Satellite** — Esri World Imagery.

For Roads and Satellite, the **Relief mix** slider crossfades between the plain map (0%)
and relief alone (100%) — the same control that used to be called "Relief opacity."
Nothing is faked to make this work: the relief tile is emitted as a partially
transparent RGBA image whose alpha is chosen so the browser's own compositing
reproduces a true multiply blend over whatever is underneath, so at any mix level roads
and place names stay legible right through the shading.

"None" is 2D-only. The 3D view always drapes a real map (Roads or Satellite, following
the same Style choice) since an untextured terrain slab wasn't part of the brief.

## Controls

| Key | Action |
| --- | --- |
| `1` / `2` | 2D map / 3D view |
| `[` `]` | decrease / increase exaggeration |
| `H` | hillshade |
| `M` | soft multi-directional light |
| `G` | gradient bands |
| `E` | elevation tint |
| `C` | contours |
| `P` | draw a route profile |
| `/` | search |

The sun direction slider matters more than it sounds: NW light (the default) is the
cartographic convention because it makes hills read as raised. Drag it to due south and
watch the same hills invert into valleys — a good demonstration of why every paper map
lights from the top left.

## Gradient bands

| Band | Feel |
| --- | --- |
| 0–3% | flat-ish |
| 3–6% | noticeable |
| 6–9% | a climb |
| 9–12% | hard |
| 12–15% | brutal |
| 15%+ | walk it |

These are DEM surface gradients, not road gradients. A road crossing a steep hillside
switchbacks and cuts, so it is usually gentler than the raw slope under it. Use the
bands to find where the steep ground is, and the route profile to see what a specific
road actually does.

## Route profile

Press `P` (or *Draw route*), click along a road, double-click to finish. You get length,
total ascent and descent, and the **steepest sustained 100 m** — a single DEM pixel spike
is noise, but 100 m of 12% is a real wall. Drag a vertex to adjust, right-click one to
delete it.

## Layout

```
serve.js          static server + caching tile proxy (Node stdlib only)
index.html        shell: panel, mode switch, import map
js/app.js         shared state, controls, persistence, mode switching
js/dem.js         DEM tiles: fetch, decode, LRU cache, padded windows, region mosaics
js/shade.js       pure kernels: hillshade, slope, aspect, hypsometric, contours
js/map2d.js       2D Leaflet relief layer
js/view3d.js      3D three.js terrain
js/profile.js     route elevation profile
test/core.test.mjs   68 maths assertions — node test/core.test.mjs
CONTRACT.md       module API contract (this app was built by parallel agents)
tilecache/        proxied tiles on disk; delete it any time to reclaim space
```

## Tests

```
node test/core.test.mjs
```

Covers the parts where a silent sign error would quietly ruin everything: Terrarium
decoding (including below sea level), slope on a synthetic 45° ramp, aspect direction,
hillshade against known analytic values (flat ground = `cos(zenith)`; a 45° west-facing
slope lit from due west = exactly 1.0, from due east = exactly 0.0), Mercator
metres-per-pixel, and marching-squares contours.

The DEM chain was also checked end-to-end against known ground truth — Scafell Pike
reads 960 m against an actual 978 m, Hampstead Heath's flagstaff 132 m against 134 m,
the Thames at Greenwich 5 m.

## Notes and limits

- Terrarium has no detail above zoom 15; beyond that the app upsamples, so relief goes
  soft rather than blocky.
- The DEM is a surface model in places — it can sit on treetops and buildings rather
  than the road. Expect a little noise in built-up areas.
- Tiles are cached on disk in `tilecache/` and in memory (~600 tiles). Ground you have
  already browsed works with the network off.
- Attribution: elevation from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen/Tilezen, incorporating Environment Agency LiDAR); basemaps from OpenStreetMap,
  CARTO, OpenTopoMap and Esri World Imagery; search by Nominatim. Be polite to the free
  tile services — the disk cache exists partly so you only fetch each tile once.
