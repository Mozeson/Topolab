import * as THREE from 'three';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function hash01(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function createRainSimulation(api) {
  let model = null;
  let particles = [];
  let phase = 'idle';
  let active = false;
  let frameId = 0;
  let lastTime = 0;
  let fallProgress = 0;
  let lastMapDraw = 0;
  let points = null;
  let pointsGeometry = null;
  const pointsMaterial = new THREE.PointsMaterial({
    color: 0x43b9ea,
    size: .11,
    transparent: true,
    opacity: .92,
    depthWrite: false,
    sizeAttenuation: true,
  });

  function updateUI(message = '') {
    const button = document.getElementById('rainBtn');
    const overlay = document.getElementById('rainStatusOverlay');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.querySelector('span').textContent = active ? 'ניקוי מים' : 'הפעלת גשם';
    overlay.hidden = !active;
    if (message) overlay.textContent = message;
  }

  function computeModel() {
    const size = api.gridSize();
    const heights = api.heights();
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
          if (slope > bestSlope + .02) {
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
    const percentileIndex = Math.floor(flowAmounts.length * .97);
    const flowThreshold = Math.max(12, size * .25, flowAmounts[percentileIndex] || 12);
    model = { size, receivers, accumulation, sinks, flowingCells, flowThreshold };
  }

  function seedParticles() {
    const size = model.size;
    const targetCount = clamp(Math.round(size * 1.8), 150, 320);
    particles = [];
    for (let i = 0; i < targetCount; i++) {
      const x = Math.min(size - 1, Math.floor(hash01(i * 97 + 17) * size));
      const y = Math.min(size - 1, Math.floor(hash01(i * 131 + 53) * size));
      const index = y * size + x;
      particles.push({
        current: index,
        next: model.receivers[index],
        progress: 0,
        settled: false,
        steps: 0,
        fallOffset: 1.4 + hash01(i * 173 + 71) * 2.5,
        fallDelay: hash01(i * 211 + 29) * .45,
      });
    }
  }

  function ensurePoints() {
    const scene = api.scene();
    if (!scene) return;
    if (points) scene.remove(points);
    pointsGeometry?.dispose();
    pointsGeometry = new THREE.BufferGeometry();
    pointsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(particles.length * 3), 3));
    points = new THREE.Points(pointsGeometry, pointsMaterial);
    points.frustumCulled = false;
    scene.add(points);
  }

  function particlePosition(particle) {
    const size = model.size;
    const currentX = particle.current % size;
    const currentY = Math.floor(particle.current / size);
    const nextX = particle.next % size;
    const nextY = Math.floor(particle.next / size);
    const t = phase === 'falling' ? 0 : particle.progress;
    return {
      u: (currentX + (nextX - currentX) * t) / (size - 1),
      v: (currentY + (nextY - currentY) * t) / (size - 1),
    };
  }

  function update3D() {
    if (!pointsGeometry) return;
    const positions = pointsGeometry.attributes.position.array;
    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      const position = particlePosition(particle);
      const ground = api.height(position.u, position.v) * api.verticalScale();
      const delayedFall = clamp((fallProgress - particle.fallDelay) / (1 - particle.fallDelay), 0, 1);
      positions[i * 3] = (position.u - .5) * api.worldSize();
      positions[i * 3 + 1] = ground + (phase === 'falling' ? (1 - delayedFall) * particle.fallOffset + .04 : .04);
      positions[i * 3 + 2] = (position.v - .5) * api.worldSize();
    }
    pointsGeometry.attributes.position.needsUpdate = true;
    api.invalidate();
  }

  function settleMessage() {
    const meaningfulSinks = model.sinks.filter((index) => model.accumulation[index] >= Math.max(5, model.size / 10));
    if (!model.flowingCells) return 'השטח שטוח: המים נשארו במקום שבו ירדו.';
    return `המים התנקזו אל ${meaningfulSinks.length || model.sinks.length} נקודות נמוכות מקומיות.`;
  }

  function tick(now) {
    if (!active) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, .08) : 0;
    lastTime = now;
    if (phase === 'falling') {
      fallProgress += dt / 1.8;
      if (fallProgress >= 1) {
        fallProgress = 1;
        phase = 'flowing';
        updateUI('המים זורמים בכל תא אל השכן הנמוך ביותר…');
      }
    } else if (phase === 'flowing') {
      let unsettled = 0;
      for (const particle of particles) {
        if (particle.settled) continue;
        unsettled++;
        particle.progress += dt * 7;
        while (particle.progress >= 1 && !particle.settled) {
          particle.progress -= 1;
          particle.current = particle.next;
          particle.steps++;
          particle.next = model.receivers[particle.current];
          if (particle.next === particle.current || particle.steps > model.size * 3) {
            particle.progress = 0;
            particle.settled = true;
          }
        }
      }
      if (!unsettled) {
        phase = 'settled';
        updateUI(settleMessage());
      }
    }
    update3D();
    if (now - lastMapDraw >= 50 || phase === 'settled') {
      lastMapDraw = now;
      api.redraw();
    }
    if (phase !== 'settled') frameId = requestAnimationFrame(tick);
  }

  function start() {
    computeModel();
    seedParticles();
    ensurePoints();
    active = true;
    phase = 'falling';
    fallProgress = 0;
    lastTime = 0;
    lastMapDraw = 0;
    updateUI('גשם יורד על פני השטח…');
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(tick);
    api.redraw();
  }

  function stop() {
    active = false;
    phase = 'idle';
    cancelAnimationFrame(frameId);
    const scene = api.scene();
    if (points && scene) scene.remove(points);
    pointsGeometry?.dispose();
    pointsGeometry = null;
    points = null;
    particles = [];
    model = null;
    updateUI();
    api.redraw();
    api.invalidate();
  }

  function toggle() {
    if (active) stop();
    else start();
  }

  function draw2D(ctx, canvas, dpr) {
    if (!active || !model) return;
    const threshold = model.flowThreshold;
    ctx.save();
    ctx.lineCap = 'round';
    for (let index = 0; index < model.receivers.length; index++) {
      const receiver = model.receivers[index];
      const amount = model.accumulation[index];
      if (receiver === index || amount < threshold) continue;
      const x = index % model.size;
      const y = Math.floor(index / model.size);
      const nx = receiver % model.size;
      const ny = Math.floor(receiver / model.size);
      ctx.beginPath();
      ctx.moveTo(x / (model.size - 1) * canvas.width, y / (model.size - 1) * canvas.height);
      ctx.lineTo(nx / (model.size - 1) * canvas.width, ny / (model.size - 1) * canvas.height);
      ctx.lineWidth = clamp((1 + Math.log2(amount / threshold + 1)) * dpr, 1.2 * dpr, 5 * dpr);
      ctx.strokeStyle = `rgba(35,142,192,${clamp(.18 + amount / (threshold * 35), .2, .72)})`;
      ctx.stroke();
    }
    for (const index of model.sinks) {
      const amount = model.accumulation[index];
      if (amount < threshold * 1.5) continue;
      const x = index % model.size;
      const y = Math.floor(index / model.size);
      const radius = clamp(Math.sqrt(amount / Math.PI) * .55 * dpr, 2.5 * dpr, 12 * dpr);
      ctx.beginPath();
      ctx.arc(x / (model.size - 1) * canvas.width, y / (model.size - 1) * canvas.height, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(45,157,204,.42)';
      ctx.fill();
    }
    for (const particle of particles) {
      const position = particlePosition(particle);
      ctx.beginPath();
      ctx.arc(position.u * canvas.width, position.v * canvas.height, (particle.settled ? 3.1 : 2.25) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = particle.settled ? 'rgba(21,105,161,.88)' : 'rgba(42,157,207,.84)';
      ctx.fill();
    }
    ctx.restore();
  }

  function stats() {
    return {
      active,
      phase,
      particleCount: particles.length,
      sinkCount: model?.sinks.length || 0,
      flowingCells: model?.flowingCells || 0,
    };
  }

  document.getElementById('rainBtn').addEventListener('click', toggle);
  updateUI();

  return { start, stop, toggle, draw2D, update3D, stats, get active() { return active; } };
}
