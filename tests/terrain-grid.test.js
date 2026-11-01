import test from 'node:test';
import assert from 'node:assert/strict';
import { gridResolution, brushRadiusCells, sculpt, resampleForMapSize } from '../src/terrain-grid.js';
import { generateTerrain } from '../src/terrain-generator.js';

test('local grids have exact 5m and 10m spacing; regional grids are unchanged', () => {
  assert.equal(gridResolution(1, 5), 201);
  assert.equal(gridResolution(1, 10), 101);
  assert.equal(gridResolution(4), 96);
  assert.equal(gridResolution(6), 144);
  assert.equal(gridResolution(8), 192);
});
test('resolution changes preserve a tilted plane and original input', () => {
  const source = Float32Array.from({length:101*101}, (_, i) => (i%101)*.1 + Math.floor(i/101)*.2);
  const copy = source.slice();
  const fine = resampleForMapSize(source,101,1,201,1);
  for(let y=0;y<201;y++) for(let x=0;x<201;x++) {
    assert.ok(Math.abs(fine[y*201+x] - (x*.05+y*.1)) < 1e-5);
  }
  assert.deepEqual(source,copy);
  assert.deepEqual(resampleForMapSize(fine,201,1,101,1),source);
});
test('extent changes crop around the center and pad new areas with zero', () => {
  const source = new Float32Array(101*101).fill(7);
  const cropped = resampleForMapSize(source,101,4,201,1);
  assert.ok(cropped.every(h=>h===7));
  const expanded = resampleForMapSize(source,101,1,101,4);
  assert.equal(expanded[50*101+50],7);
  assert.equal(expanded[0],0);
});
test('100m brush has identical physical shape at both local resolutions', () => {
  const low = new Float32Array(101*101), high = new Float32Array(201*201);
  sculpt(low,101,50,50,brushRadiusCells(100,1000,101),-20);
  sculpt(high,201,100,100,brushRadiusCells(100,1000,201),-20);
  for(let y=0;y<101;y++) for(let x=0;x<101;x++) assert.equal(low[y*101+x], high[y*2*201+x*2]);
  assert.equal(low[50*101+50],-20);
  assert.equal(low[50*101+55],0);
  assert.ok(low.some(h=>h<0));
});
test('local generation is seeded, bounded, and agrees at shared physical samples', () => {
  const settings={seed:923,extentMeters:1000,gullyWidth:80};
  const low=generateTerrain(101,settings),high=generateTerrain(201,settings);
  assert.deepEqual(high,generateTerrain(201,settings));
  assert.ok(high.every(h=>Number.isFinite(h)&&h>=-100&&h<=200));
  for(let y=0;y<101;y++) for(let x=0;x<101;x++) assert.equal(low[y*101+x],high[y*2*201+x*2]);
  assert.notDeepEqual(low,generateTerrain(101,{...settings,gullyWidth:160}));
  assert.deepEqual(generateTerrain(101,{...settings,valleys:0}),generateTerrain(101,{...settings,valleys:0,gullyWidth:160}));
});
