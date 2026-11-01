# ארכיטקטורה

## מבט על

אפליקציית דפדפן סטטית שנבנית עם Vite, בלי framework. ספריות: `three` (תלת־ממד), `d3-contour` (קווי גובה), `jspdf` (ייצוא).
ממשק המשתמש הוא HTML סטטי (`index.html`) ש-`src/scene.js` מחבר לקוד.

```
index.html ── src/style.css
     │
     └── src/scene.js  (נקודת הכניסה: מצב, ציור המפה, סצנת Three.js, חיבור הממשק)
           ├── brush.js            מתמטיקת המברשת (טהור, עם בדיקות)
           ├── history.js          ביטול/חזרה (טהור, עם בדיקות)
           ├── persistence.js      שמירה אוטומטית (קידוד טהור + localStorage)
           ├── shortcuts.js        טבלת קיצורים + handler גלובלי
           ├── terrain-generator.js  מפה אקראית לפי seed (טהור, עם בדיקות)
           ├── hydrology.js        מודל זרימה (טהור, עם בדיקות)
           ├── rain.js             הדמיית גשם (2D + 3D), משתמש ב-hydrology
           ├── map-features.js     שבילים/דרכים/נחלים: ציור, אימות שיפוע, 3D, serialize/load
           ├── sheep.js            ביצת פסחא: "חפשו את הכבשה"
           ├── nav.js              ניווט מקלדת וג'ויסטיקים בתלת־ממד
           ├── splitter.js         גרירת הרוחב בין הפאנלים
           ├── pdf-preview.js      חלון תצוגה מקדימה ל-PDF
           └── print.js            יצירת ה-PDF
```

## המצב (state)

כל המצב חי ב-`scene.js`:

| משתנה | תוכן |
|---|---|
| `heights: Float32Array(N*N)` | הגובה במטרים לכל תא ברשת. הטווח: `MIN_HEIGHT..MAX_HEIGHT` (‎-100..200) |
| `N`, `WORLD_SIZE` | גודל הרשת לפי `MAP_GRID_SIZES` (4 ק"מ → 96, 6 → 144, 8 → 192) |
| `state.tool` | `'raise' \| 'lower' \| 'smooth' \| 'pan' \| 'features'` |
| `state.strokeTool` | הכלי בפועל במשיכה הנוכחית (אחרי Alt/Shift) |
| `state.tempPan` | רווח מוחזק |
| `state.brush`, `state.strength` | גודל המברשת (אחוז מרוחב המפה) ועוצמה (מטר לשנייה) |
| `state.topo`, `state.interval`, `state.scale`, `state.exaggeration` | הגדרות תצוגה |
| `state.mapView` | זום והזזה של המפה הדו־ממדית (תצוגה בלבד) |
| `state.observer`, `state.exercise` | תצפית ותרגיל |
| `history` | מופע של `createHistory()` |

> ריכוז המצב באובייקט יחיד ופיצול `scene.js` מתוכננים לשלב 5 (ראו ROADMAP).

## זרימת עדכון

```
pointer / מקלדת
   └─► applyBrush(gx, gy, seconds, tool)        ← brush.js
          └─► scheduleUpdate()                   (מאחד עדכונים ל-requestAnimationFrame אחד)
                 ├─► updateReadouts()            שיא, התקדמות התרגיל
                 ├─► updateTerrain()             גיאומטריה וצבעים בתלת־ממד, skirt, תכסית, גשם, טבעת המברשת
                 └─► drawMap()                   raster/קווי גובה, גשם, תכסית, כבשה, אדם, מברשת
```

- **לפני** כל שינוי שאפשר לבטל: `pushUndo()`. הפונקציה שומרת snapshot ומתזמנת שמירה אוטומטית.
- משיכת מברשת שלמה היא צעד אחד בהיסטוריה (`pushUndo` ב-`pointerdown`).
- בסוף משיכה, `stopDrawing()` קורא ל-`scheduleSave()`.

## חיווט הממשק

| נושא | פונקציות ב-`scene.js` |
|---|---|
| כלים | `setTool(tool)` (מצב + צד־אפקטים), `syncToolUI()` (רק תצוגה) |
| מברשת | `setBrushSize(v)`, `setStrength(v)` (מעדכנים את הסליידר, את ה-output ואת השמירה) |
| תצוגה | `setTopo(bool)` |
| היסטוריה | `pushUndo()`, `undo()`, `redo()`, `restoreSnapshot()`, `updateHistoryButtons()` |
| הודעות | `showToast(msg, true)` לשגיאה, `showToast(msg, { action: { label, run } })` עם כפתור |
| תפריט שטח חדש | `toggleNewTerrainMenu()`, `closePopovers()` |
| שמירה | `scheduleSave()`, `collectProject()`, `restoreProject(saved)`, `startFresh()` |
| משוב בזמן עבודה | `updatePointReadout(pointer, event)`, `hideCursorReadout()`, `updateBrushRing()` |

`map-features.js` מקבל callbacks: `prepareDrawing(type)` מעביר את הכלי ל-`features` בלי להפעיל מחדש, ו-`changed()` מתזמן שמירה.
המודול מייצא `activate`, `serialize`, `load`, `clearAll` ואת ה-getters `active`, `activeType`, `drafting`.

## מדריכים

### הוספת כלי

1. **HTML:** כפתור ב-`.tool-rail` עם `class="rail-tool"`, `data-tool="<name>"`, `aria-pressed="false"` ו-`data-shortcut="tool-<name>"`.
2. **מצב:** הוספה ל-`TOOL_LABELS` ב-`scene.js`. אם זה כלי פיסול, מוסיפים גם ל-`SCULPT_TOOLS` ב-`brush.js` ומממשים ב-`applyBrush()`.
3. **אפשרויות:** אם לכלי יש הגדרות משלו, מוסיפים `div.options-group` ב-`#optionsBar` ומציגים או מסתירים אותו ב-`syncToolUI()`.
4. **לחיצה על המפה:** ב-handler של `pointerdown` ב-`scene.js`, לפני הבלוק של כלי הפיסול.
5. **קיצור:** שורה ב-`SHORTCUTS` ו-handler ב-`initShortcuts({...})`.
6. **תיעוד:** הטבלה ב-`docs/UI-GUIDE.md`.

### הוספת הגדרה שנשמרת

`collectProject().settings` ← שדה חדש. ב-`restoreProject()` קוראים אותו **עם בדיקת תקינות** (הנתונים מגיעים מ-localStorage).
אם מבנה הנתונים משתנה בצורה שלא תואמת לאחור, מעלים את `VERSION` ואת `STORAGE_KEY` ב-`persistence.js`.

### הוספת פעולה הורסת

```js
pushUndo();
/* ...שינוי heights... */
scheduleUpdate();
showToast('תיאור קצר.', { action: { label: 'ביטול', run: undo } });
```

## בדיקות

- `npm test`: בדיקות `node:test` בתיקייה `tests/`. הן מכסות את המודולים הטהורים: `terrain-generator`, `hydrology`, `history`, `brush`, `persistence`, `shortcuts`.
- `scripts/verify-content.mjs`: בדיקה ויזואלית ב-Chrome headless (רינדור, שגיאות, צילומי מסך). הפלט נכתב ל-`verification-shots/`; צריך למחוק אותו לפני commit.
- `window.__APP_STATS__()` חושף מצב לבדיקות אוטומטיות בדפדפן (Playwright). `?fresh` מונע טעינה של שמירה קודמת.
