// Autosave of the user's work to localStorage.
// Heights are quantised to centimetres in an Int16Array (range ±327 m covers -100..200 m)
// and base64-encoded: a 192×192 map costs ~98 KB of storage. Taller real relief (heights are
// relative to the map's datum, see scene.js) is stored in decimetres instead (`heightStep`).

export const STORAGE_KEY = 'topolab-autosave-v1';
const VERSION = 1;

export function heightStepFor(heights) {
  let far = 0;
  for (const h of heights) far = Math.max(far, Math.abs(h));
  return far > 327 ? .1 : .01;
}

export function encodeHeights(heights, step = .01) {
  const ints = new Int16Array(heights.length);
  for (let i = 0; i < heights.length; i++) ints[i] = Math.max(-32768, Math.min(32767, Math.round(heights[i] / step)));
  const bytes = new Uint8Array(ints.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function decodeHeights(encoded, expectedLength, step = .01) {
  const binary = atob(encoded);
  if (binary.length !== expectedLength * 2) throw new Error('Saved terrain has an unexpected size.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ints = new Int16Array(bytes.buffer);
  const heights = new Float32Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) heights[i] = step === .01 ? ints[i] / 100 : ints[i] * step;
  return heights;
}

export function serializeProject({ heights, mapSize, settings = {}, features = [], course = null, waypoints = [] }) {
  return JSON.stringify({
    version: VERSION,
    savedAt: new Date().toISOString(),
    mapSize,
    gridLength: heights.length,
    heightStep: heightStepFor(heights),
    heights: encodeHeights(heights, heightStepFor(heights)),
    settings,
    features,
    course,
    waypoints,
  });
}

export function parseProject(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== VERSION) throw new Error('Unsupported save version.');
  const step = data.heightStep === .1 ? .1 : .01;
  return { ...data, heights: decodeHeights(data.heights, data.gridLength, step) };
}

function storage() {
  try { return window.localStorage; } catch { return null; }
}

export function loadProject() {
  const store = storage();
  if (!store) return null;
  try {
    const text = store.getItem(STORAGE_KEY);
    return text ? parseProject(text) : null;
  } catch (error) {
    console.warn('Ignoring unreadable autosave', error);
    return null;
  }
}

export function clearProject() {
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

// Debounced writer: call `schedule()` after every change; `collect()` builds the payload lazily.
export function createAutosave(collect, { delay = 800, onSaved = () => {} } = {}) {
  let timer = null;
  let enabled = true;
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!enabled) return;
    const payload = collect();
    if (!payload) return;
    try {
      storage()?.setItem(STORAGE_KEY, serializeProject(payload));
      onSaved();
    } catch (error) {
      console.warn('Autosave failed', error);
    }
  }
  function schedule() {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }
  addEventListener('pagehide', () => { if (timer) flush(); });
  return {
    schedule,
    flush,
    set enabled(value) { enabled = value; if (!value) clearTimeout(timer); },
    get enabled() { return enabled; },
  };
}
