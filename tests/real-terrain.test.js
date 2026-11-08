import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lonLatToPixel, zoomForSpacing, tilesFor, decodeTerrarium, sampleGrid, chooseDatum,
  clipPolyline, clipPolygon, simplify, joinRings, osmToFeatures, trailColor, overpassQuery,
} from '../src/real-terrain.js';
import { itmToWgs84 } from '../src/itm.js';

const TABOR = { e: 235400, n: 730300 }; // SW corner of a 4 km map around Mount Tabor

test('tile maths: pixel coordinates and zoom by spacing', () => {
  const p = lonLatToPixel(0, 0, 0);
  assert.deepEqual([p.x, p.y], [128, 128]);
  assert.equal(zoomForSpacing(42, 32.7), 12);
  assert.equal(zoomForSpacing(5, 32.7), 14); // capped: the source is ~30 m
  const tiles = tilesFor(TABOR, 4000, 12);
  assert.ok(tiles.length >= 1 && tiles.length <= 4, String(tiles.length));
});

test('Terrarium decoding', () => {
  // 575.5 m → 33343.5 → R=130, G=63, B=128
  const h = decodeTerrarium(new Uint8ClampedArray([130, 63, 128, 255, 128, 0, 0, 255]));
  assert.equal(h[0], 575.5);
  assert.equal(h[1], 0);
});

test('grid sampling follows a synthetic slope (north up, west left)', () => {
  const z = 12;
  const tiles = new Map();
  // Height = global pixel x (east grows) − global pixel y (north grows): a tilted plane.
  for (const t of tilesFor(TABOR, 4000, z)) {
    const data = new Float32Array(256 * 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) data[y * 256 + x] = (t.x * 256 + x + .5) - (t.y * 256 + y + .5);
    tiles.set(`${z}/${t.x}/${t.y}`, data);
  }
  const n = 9;
  const heights = sampleGrid({ origin: TABOR, extent: 4000, n, z, tiles });
  const at = (row, col) => {
    const { lat, lon } = itmToWgs84(TABOR.e + col / (n - 1) * 4000, TABOR.n + (1 - row / (n - 1)) * 4000);
    const p = lonLatToPixel(lon, lat, z);
    return p.x - p.y;
  };
  for (const [r, c] of [[0, 0], [8, 8], [4, 2], [0, 8]]) assert.ok(Math.abs(heights[r * n + c] - at(r, c)) < .2);
  assert.ok(heights[0 * n + 8] > heights[0 * n + 0], 'east is higher');
  assert.ok(heights[0 * n + 0] > heights[8 * n + 0], 'north is higher');
});

test('missing tiles are filled from neighbours; datum is a round hundred', () => {
  const heights = sampleGrid({ origin: TABOR, extent: 4000, n: 5, z: 12, tiles: new Map() });
  assert.ok(heights.every((h) => h === 0));
  assert.equal(chooseDatum(Float32Array.of(120, 575)), 100);
  assert.equal(chooseDatum(Float32Array.of(-415, -200)), -500);
});

test('clipping lines and polygons to the map', () => {
  const pieces = clipPolyline([{ u: -.5, v: .5 }, { u: .5, v: .5 }, { u: 1.5, v: .5 }, { u: 1.5, v: .2 }, { u: .5, v: .2 }]);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[0], [{ u: 0, v: .5 }, { u: .5, v: .5 }, { u: 1, v: .5 }]);
  assert.deepEqual(pieces[1], [{ u: 1, v: .2 }, { u: .5, v: .2 }]);
  assert.equal(clipPolyline([{ u: 2, v: 2 }, { u: 3, v: 3 }]).length, 0);
  const square = clipPolygon([{ u: -1, v: -1 }, { u: .5, v: -1 }, { u: .5, v: .5 }, { u: -1, v: .5 }]);
  assert.ok(square.length >= 4 && square.every((p) => p.u >= 0 && p.u <= .5 && p.v >= 0 && p.v <= .5));
  assert.equal(simplify([{ u: 0, v: 0 }, { u: .5, v: .0001 }, { u: 1, v: 0 }], .01).length, 2);
});

test('multipolygon rings are joined from their ways', () => {
  const p = (lat, lon) => ({ lat, lon });
  const rings = joinRings([[p(0, 0), p(0, 1)], [p(1, 1), p(0, 1)], [p(1, 1), p(1, 0), p(0, 0)]]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
});

test('OSM elements become Topolab features in the right place', () => {
  const origin = TABOR;
  const geo = (e, n) => { const { lat, lon } = itmToWgs84(e, n); return { lat, lon }; };
  const elements = [
    { type: 'way', id: 1, tags: { highway: 'secondary' }, geometry: [geo(235000, 732300), geo(240000, 732300)] },
    { type: 'way', id: 2, tags: { highway: 'path' }, geometry: [geo(236000, 731000), geo(237000, 732000)] },
    { type: 'way', id: 3, tags: { highway: 'track' }, geometry: [geo(236000, 733000), geo(238000, 733000)] },
    { type: 'way', id: 4, tags: { waterway: 'stream' }, geometry: [geo(236500, 734000), geo(236500, 731000)] },
    { type: 'way', id: 5, tags: { landuse: 'forest' }, geometry: [geo(236000, 731000), geo(238000, 731000), geo(238000, 733000), geo(236000, 733000), geo(236000, 731000)] },
    { type: 'way', id: 6, tags: { building: 'yes' }, geometry: [geo(236000, 731000), geo(236100, 731100)] },
    { type: 'relation', id: 9, tags: { route: 'hiking', 'osmc:symbol': 'blue:white:blue_stripe' }, members: [{ type: 'way', ref: 2, role: '' }] },
  ];
  const features = osmToFeatures(elements, { origin, extent: 4000, cell: 1 / 95 });
  const types = features.map((f) => f.type);
  assert.deepEqual(types, ['plantedForest', 'road', 'markedTrail', 'dirtRoad', 'intermittentStream']);
  const road = features[1];
  assert.ok(Math.abs(road.points[0].u) < 1e-3 && Math.abs(road.points.at(-1).u - 1) < 1e-3, 'clipped to the map edges');
  assert.ok(Math.abs(road.points[0].v - .5) < 2e-3, 'northing 732300 is the middle row');
  assert.equal(features[2].color, 'blue');
  assert.equal(trailColor({ colour: 'Green' }), 'green');
  assert.match(overpassQuery(origin, 4000), /32\.6\d+,35\.3\d+,32\.7\d+,35\.4\d+/);
});

test('staggered race: first answer wins, failures start the next source at once', async () => {
  const { raceStaggered } = await import('../src/real-terrain.js');
  const wait = (ms, value, fail = false) => (signal) => new Promise((resolve, reject) => {
    const t = setTimeout(() => (fail ? reject(new Error(value)) : resolve(value)), ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });
  const started = Date.now();
  assert.equal(await raceStaggered([wait(500, 'slow'), wait(20, 'fast')], { stagger: [50] }), 'fast');
  assert.ok(Date.now() - started < 300);
  assert.equal(await raceStaggered([wait(5, 'x', true), wait(5, 'second')], { stagger: [10000] }), 'second');
  await assert.rejects(raceStaggered([wait(5, 'a', true), wait(5, 'b', true)], { stagger: [1] }), /b/);
});

test('place search results become ITM points with a fitting map size', async () => {
  const { parsePlaces, suggestSize } = await import('../src/real-terrain.js');
  const places = parsePlaces([
    { lat: '31.4523959', lon: '35.3848241', name: 'עין גדי', display_name: 'עין גדי, מועצה אזורית תמר, נפת באר שבע, ישראל', boundingbox: ['31.4495698', '31.4556439', '35.3791049', '35.3893316'] },
    { lat: '48.85', lon: '2.35', name: 'Paris', display_name: 'Paris, France' },
  ]);
  assert.equal(places.length, 1);
  assert.equal(places[0].name, 'עין גדי');
  assert.equal(places[0].detail, 'מועצה אזורית תמר, נפת באר שבע');
  assert.ok(Math.abs(places[0].e - 237000) < 2000 && Math.abs(places[0].n - 597000) < 2000, `${places[0].n}/${places[0].e}`);
  assert.equal(places[0].sizeKm, 4);
  assert.equal(suggestSize(['31.0', '31.04', '35.0', '35.04']), 6);
  assert.equal(suggestSize(['30.4', '30.7', '34.6', '35.0']), 8);
});
