// Keyboard and on-screen joystick navigation for the 3D view.
// Returns normalized axes per frame; scene.js applies them to OrbitControls or the observer.
export function initNavigation(keyTarget, moveStick, auxStick) {
  const keys = new Set();
  const clampAxis = (v) => Math.max(-1, Math.min(1, v));

  if (keyTarget) {
    const handled = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ']);
    keyTarget.addEventListener('keydown', (event) => {
      if (!handled.has(event.key)) return;
      event.preventDefault();
      keys.add(event.key);
    });
    keyTarget.addEventListener('keyup', (event) => keys.delete(event.key));
    keyTarget.addEventListener('blur', () => keys.clear());
  }

  function bindStick(stick) {
    if (!stick) return { x: 0, y: 0 };
    const base = stick.querySelector('.joystick-base');
    const nub = stick.querySelector('.joystick-nub');
    const stickState = { x: 0, y: 0 };
    let pointerId = null;
    const setNub = (x, y) => {
      const travel = base.clientWidth * .32;
      nub.style.transform = `translate(-50%, -50%) translate(${x * travel}px, ${-y * travel}px)`;
    };
    const update = (event) => {
      const rect = base.getBoundingClientRect();
      let x = ((event.clientX - rect.left) / rect.width - .5) * 2;
      let y = -((event.clientY - rect.top) / rect.height - .5) * 2;
      const length = Math.hypot(x, y);
      if (length > 1) { x /= length; y /= length; }
      if (length < .14) { x = 0; y = 0; }
      stickState.x = x;
      stickState.y = y;
      setNub(x, y);
    };
    const reset = () => {
      pointerId = null;
      stickState.x = 0;
      stickState.y = 0;
      setNub(0, 0);
    };
    stick.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      event.preventDefault();
      pointerId = event.pointerId;
      stick.setPointerCapture(event.pointerId);
      update(event);
    });
    stick.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      update(event);
    });
    const release = (event) => {
      if (event.pointerId === pointerId) reset();
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
    return stickState;
  }

  const move = bindStick(moveStick);
  const aux = bindStick(auxStick);

  return {
    // x — right positive, y — up/forward positive, aux — up positive.
    frame() {
      let x = move.x;
      let y = move.y;
      let auxY = aux.y;
      if (keys.has('ArrowLeft')) x -= 1;
      if (keys.has('ArrowRight')) x += 1;
      if (keys.has('ArrowUp')) y += 1;
      if (keys.has('ArrowDown')) y -= 1;
      if (keys.has('PageUp')) auxY += 1;
      if (keys.has('PageDown')) auxY -= 1;
      x = clampAxis(x);
      y = clampAxis(y);
      auxY = clampAxis(auxY);
      return {
        x, y, aux: auxY, active: x !== 0 || y !== 0 || auxY !== 0,
        // Raw stick positions (no keyboard mixed in) for the navigation game's
        // twin-stick layout: left = move, right = look.
        sticks: { move: { x: move.x, y: move.y }, look: { x: aux.x, y: aux.y } },
      };
    },
  };
}
