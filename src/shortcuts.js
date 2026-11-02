// Global keyboard shortcuts. Keys are matched by `event.code` (physical key), so they
// work the same with a Hebrew or English keyboard layout.
//
// The table is the single source of truth: it drives the key handler, the tooltips
// (via data-shortcut attributes) and the shortcut list in the help dialog.

export const SHORTCUTS = [
  { id: 'tool-raise', codes: ['KeyR'], label: 'R', description: 'כלי הגבהה' },
  { id: 'tool-lower', codes: ['KeyL'], label: 'L', description: 'כלי הנמכה' },
  { id: 'tool-smooth', codes: ['KeyS'], label: 'S', description: 'כלי החלקה' },
  { id: 'tool-smudge', codes: ['KeyM'], label: 'M', description: 'עיצוב: מריחה (גרירת השטח)' },
  { id: 'tool-pinch', codes: ['KeyP'], label: 'P', description: 'עיצוב: צביטה (Alt — הרחבה)' },
  { id: 'tool-flatten', codes: ['KeyE'], label: 'E', description: 'עיצוב: השטחה לגובה נקודת ההתחלה' },
  { id: 'tool-pan', codes: ['KeyH'], label: 'H', description: 'הזזת המפה' },
  { id: 'tool-features', codes: ['KeyF'], label: 'F', description: 'ציור תכסית' },
  { id: 'tool-course', codes: ['KeyC'], label: 'C', description: 'תכנון מסלול ניווט' },
  { id: 'tool-drop', codes: ['KeyD'], label: 'D', description: 'טיפה: לאן זורמים המים מנקודה' },
  { id: 'open-navigation', codes: ['KeyG'], label: 'G', description: 'יציאה לניווט' },
  { id: 'toggle-topo', codes: ['KeyT'], label: 'T', description: 'מעבר בין פיסול למפה טופוגרפית' },
  { id: 'toggle-rain', codes: ['KeyW'], label: 'W', description: 'הפעלה וניקוי של גשם' },
  { id: 'new-terrain', codes: ['KeyN'], label: 'N', description: 'תפריט שטח חדש' },
  { id: 'brush-smaller', codes: ['BracketLeft'], label: '[', description: 'הקטנת המברשת' },
  { id: 'brush-larger', codes: ['BracketRight'], label: ']', description: 'הגדלת המברשת' },
  { id: 'strength-down', codes: ['BracketLeft'], shift: true, label: 'Shift+[', description: 'הפחתת עוצמה' },
  { id: 'strength-up', codes: ['BracketRight'], shift: true, label: 'Shift+]', description: 'הגברת עוצמה' },
  { id: 'zoom-in', codes: ['Equal', 'NumpadAdd'], label: '+', description: 'התקרבות במפה' },
  { id: 'zoom-out', codes: ['Minus', 'NumpadSubtract'], label: '−', description: 'התרחקות במפה' },
  { id: 'zoom-reset', codes: ['Digit0', 'Numpad0'], label: '0', description: 'הצגת המפה כולה' },
  { id: 'undo', codes: ['KeyZ'], mod: true, label: 'Ctrl+Z', description: 'ביטול' },
  { id: 'redo', codes: ['KeyZ'], mod: true, shift: true, label: 'Ctrl+Shift+Z', description: 'חזרה' },
  { id: 'redo', codes: ['KeyY'], mod: true, label: 'Ctrl+Y', description: 'חזרה' },
  { id: 'help', codes: ['Slash'], shift: true, label: '?', description: 'עזרה וקיצורים' },
];

// Hold-to-use modifiers, documented next to the table above.
export const HOLD_HINTS = [
  { label: 'רווח (החזקה)', description: 'הזזת המפה זמנית' },
  { label: 'Alt (החזקה)', description: 'היפוך הגבהה/הנמכה בזמן ציור' },
  { label: 'Shift (החזקה)', description: 'החלקה זמנית בזמן ציור' },
  { label: 'Esc', description: 'ביטול פעולה / סגירת חלון' },
];

export function matchShortcut(event) {
  const mod = event.ctrlKey || event.metaKey;
  for (const shortcut of SHORTCUTS) {
    if (!shortcut.codes.includes(event.code)) continue;
    if (Boolean(shortcut.mod) !== mod) continue;
    if (Boolean(shortcut.shift) !== event.shiftKey) continue;
    if (event.altKey) continue;
    return shortcut.id;
  }
  return null;
}

export function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes(target.type);
  return false;
}

export function shortcutLabel(id) {
  return SHORTCUTS.find((shortcut) => shortcut.id === id)?.label || '';
}

export function initShortcuts(handlers) {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat && !/^(brush|strength|zoom)/.test(matchShortcut(event) || '')) return;
    if (isTypingTarget(event.target)) return;
    if (document.body.classList.contains('navigating')) return; // the game owns the keyboard
    if (document.querySelector('dialog[open]')) return;
    const id = matchShortcut(event);
    if (!id || !handlers[id]) return;
    if (handlers[id](event) === false) return;
    event.preventDefault();
  });
}
