// Route every strictly positive downhill slope; flat cells and real sinks retain water.
export function computeFlowModel(size, heights) {
  const count = size * size;
  const receivers = new Int32Array(count);
  const accumulation = new Float32Array(count);
  accumulation.fill(1);
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      let receiver = index;
      let bestSlope = 0;
      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        const next = ny * size + nx;
        const drop = heights[index] - heights[next];
        const slope = drop / Math.hypot(dx, dy);
        if (slope > bestSlope) {
          bestSlope = slope;
          receiver = next;
        }
      }
      receivers[index] = receiver;
    }
  }
  const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => heights[b] - heights[a]);
  for (const index of order) {
    const receiver = receivers[index];
    if (receiver !== index) accumulation[receiver] += accumulation[index];
  }
  const sinks = [];
  let flowingCells = 0;
  const flowAmounts = [];
  for (let index = 0; index < count; index++) {
    if (receivers[index] === index) sinks.push(index);
    else {
      flowingCells++;
      flowAmounts.push(accumulation[index]);
    }
  }
  flowAmounts.sort((a, b) => a - b);
  const percentileIndex = Math.floor(flowAmounts.length * .90);
  const flowThreshold = Math.max(4, size * .06, flowAmounts[percentileIndex] || 4);
  return { size, receivers, accumulation, sinks, flowingCells, flowThreshold };
}
