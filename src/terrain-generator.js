// Smooth, seeded value noise; sampling uses map coordinates rather than grid indices.
function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const smooth = t => t * t * t * (t * (t * 6 - 15) + 10);
  const hash = (a, b) => {
    let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const u = smooth(x - ix), v = smooth(y - iy);
  const a = hash(ix, iy), b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export function generateTerrain(size, { seed = 1, relief = 120, variation = 60, detail = 35, valleys = 40, extentMeters = 4000, gullyWidth = 80 } = {}) {
  const heights = new Float32Array(size * size);
  const variety = variation / 100, roughness = detail / 100;
  const frequency = 2 + variety * 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1), v = y / (size - 1);
      const wx = u * frequency + 2 * noise(u * 2, v * 2, seed ^ 12345);
      const wy = v * frequency + 2 * noise(u * 2, v * 2, seed ^ 54321);
      let elevation = 0, amplitude = 1, total = 0;
      for (let octave = 0; octave < 5; octave++) {
        const scale = 2 ** octave;
        elevation += amplitude * noise(wx * scale, wy * scale, seed + octave * 1013);
        total += amplitude;
        amplitude *= .12 + roughness * .48;
      }
      elevation /= total;
      // Connected low bands meander through the warped field, with independently
      // adjustable incision. Rain subsequently follows the actual resulting relief.
      const channel = Math.exp(-(((noise(wx * .8, wy * .8, seed ^ 7919) - .5) / .075) ** 2));
      // Local mode adds seeded meandering cuts in physical map units.
      // These are editable landforms, not a claimed hydrological drainage network.
      let localCuts = 0;
      if (extentMeters === 1000) {
        const width = Math.max(4 * extentMeters / (size - 1), gullyWidth);
        const sigma = width / 2.355;
        const count = 1 + Math.floor(noise(.2, .8, seed ^ 1931) * 3) + Math.floor(variety * 2);
        const angle = noise(.4, .6, seed ^ 9173) * Math.PI;
        const across = ((u - .5) * Math.cos(angle) + (v - .5) * Math.sin(angle) + .5) * extentMeters;
        const along = -(u - .5) * Math.sin(angle) + (v - .5) * Math.cos(angle) + .5;
        for (let k = 0; k < count; k++) {
          const phase = noise(k + .3, .7, seed ^ 8713) * Math.PI * 2;
          const center = ((k + 1) / (count + 1)) * extentMeters
            + extentMeters * .1 * Math.sin(along * Math.PI * 2 + phase)
            + extentMeters * .025 * Math.sin(along * Math.PI * 6 + phase);
          localCuts += Math.exp(-.5 * ((across - center) / sigma) ** 2);
        }
      }
      const mountainEnvelope = .55 + variety * noise(u * 3, v * 3, seed ^ 997);
      heights[y * size + x] = Math.max(-100, Math.min(200,
        relief * ((elevation - .25) * 1.5 * mountainEnvelope - valleys / 100 * (.55 * channel + .22 * localCuts))));
    }
  }
  return heights;
}
