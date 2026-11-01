// Undo / redo history for terrain edits.
// Each entry is a full snapshot ({ heights: Float32Array, mapSize }) — cheap enough
// at our grid sizes (max 192² floats ≈ 147 KB) and immune to drift bugs.
export function createHistory({ limit = 60, onChange = () => {} } = {}) {
  const undoStack = [];
  const redoStack = [];

  const snapshot = (entry) => ({ heights: new Float32Array(entry.heights), mapSize: entry.mapSize });

  function push(current) {
    undoStack.push(snapshot(current));
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
    onChange();
  }

  // `current` is the live state, saved to the opposite stack so the step can be reversed.
  function undo(current) {
    const previous = undoStack.pop();
    if (!previous) return null;
    redoStack.push(snapshot(current));
    onChange();
    return previous;
  }

  function redo(current) {
    const next = redoStack.pop();
    if (!next) return null;
    undoStack.push(snapshot(current));
    onChange();
    return next;
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    onChange();
  }

  return {
    push,
    undo,
    redo,
    clear,
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get size() { return { undo: undoStack.length, redo: redoStack.length }; },
  };
}
