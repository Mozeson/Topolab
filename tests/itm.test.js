import test from 'node:test';
import assert from 'node:assert/strict';
import { itmToWgs84, wgs84ToItm, isItm } from '../src/itm.js';

// Reference values from pyproj (EPSG:2039 → EPSG:4326, with the datum shift).
const REF = [
  [219529.584, 626907.39, 31.734763, 35.2052138],
  [237400, 732300, 32.6850261, 35.3957688],   // Mount Tabor
  [222286, 631556, 31.7766827, 35.234314],    // Jerusalem
  [250000, 580000, 31.311315, 35.5252977],
  [200000, 600000, 31.4919312, 34.9996624],
  [170000, 750000, 32.8436581, 34.676171],
];
const metres = (dLat, dLon, lat) => Math.hypot(dLat * 111320, dLon * 111320 * Math.cos(lat * Math.PI / 180));

test('ITM → WGS84 matches pyproj within two metres', () => {
  for (const [e, n, lat, lon] of REF) {
    const p = itmToWgs84(e, n);
    assert.ok(metres(p.lat - lat, p.lon - lon, lat) < 2, `${e}/${n}: off by ${metres(p.lat - lat, p.lon - lon, lat).toFixed(2)} m`);
  }
});

test('WGS84 → ITM round-trips to the centimetre', () => {
  for (const [e, n] of REF) {
    const { lat, lon } = itmToWgs84(e, n);
    const back = wgs84ToItm(lat, lon);
    assert.ok(Math.hypot(back.e - e, back.n - n) < .02, `${e}/${n}`);
  }
  assert.equal(isItm(237400, 732300), true);
  assert.equal(isItm(200000, 600000), true);
  assert.equal(isItm(35, 32), false);
});
