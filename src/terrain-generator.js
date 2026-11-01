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

export function generateTerrain(size, { seed = 1, relief = 120, variation = 60, detail = 35, valleys = 40 } = {}) {
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
      const mountainEnvelope = .55 + variety * noise(u * 3, v * 3, seed ^ 997);
      heights[y * size + x] = Math.max(-100, Math.min(200,
        relief * ((elevation - .25) * 1.5 * mountainEnvelope - valleys / 100 * .55 * channel)));
    }
  }
  return heights;
}
