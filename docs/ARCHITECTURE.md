# ארכיטקטורה

## מבט על

אפליקציית דפדפן סטטית שנבנית עם Vite, בלי framework. ספריות: `three` (תלת־ממד), `d3-contour` (קווי גובה), `jspdf` (ייצוא).
ממשק המשתמש הוא HTML סטטי (`index.html`) ש-`src/scene.js` מחבר לקוד.

```
index.html ── src/style.css
     │
     └── src/scene.js  (נקודת הכניסה: מצב, ציור המפה, סצנת Three.js, חיבור הממשק)
           ├── brush.js            מתמטיקת המברשת (טהור, עם בדיקות)
           ├── terrain-grid.js     רזולוציית הרשת לכל גודל מפה, רדיוס מברשת בתאים, דגימה מחדש (טהור, עם בדיקות)
           ├── history.js          ביטול/חזרה (טהור, עם בדיקות)
           ├── persistence.js      שמירה אוטומטית (קידוד טהור + localStorage)
           ├── shortcuts.js        טבלת קיצורים + handler גלובלי
           ├── terrain-generator.js  מפה אקראית לפי seed (טהור, עם בדיקות)
           ├── erosion.js          סחיפה ופריצת שקעים: מפות אקראיות שמתנקזות כמו נוף אמיתי (טהור, עם בדיקות)
           ├── hydrology.js        מודל המים: priority-flood, D8/MFD, אגמים לפי כמות גשם (טהור, עם בדיקות)
           ├── course.js           מסלול ניווט: מודל, מחולל, ניקוד, ציור (טהור, עם בדיקות)
           ├── nav-game.js         משחק הניווט: תדריך, HUD, דגלים/שמיים/שיחים, גמלים, לילה, תוצאות (docs/NAVIGATION.md)
           ├── drone.js            רחפן ו-FPV: גובה, סוללה, פיזיקה (טהור, עם בדיקות)
           ├── camels.js           גמלים: ציון עמק, עדרים, רעייה ומרדף (טהור, עם בדיקות)
           ├── sky.js              דמדומים ולילה: ירח לפי החודש העברי, שמש, כוכבים, אור (טהור, עם בדיקות)
           ├── wind.js             רוח: כיוון, משבים, השפעה על ההליכה (טהור, עם בדיקות)
           ├── effort.js           מאמץ: עייפות ונשימה (טהור, עם בדיקות)
           ├── field-models.js     מודלים בקוד: עצים, שיחים, סלעים, עשב, גמל, ידיים, אבק, נדנוד ברוח
           ├── field-audio.js      צלילי שטח מסונתזים: צעדים, נשימות, רוח
           ├── cave.js             בלופר המערה: מיקום בגיא (טהור, עם בדיקה)
           ├── field-engine.js     מנוע v2 במשחק: חומרים מצולמים, שמיים אמיתיים ו-IBL, עיבוד תמונה
           ├── netivot.js          בלופר המערה: המערה, המנהרה, והכביש בשמיים עם השלט
           ├── team.js             ניווט קבוצתי: חלוקת הציר, כולם בנקודה, מי התרחק (טהור; גם בשרת)
           ├── multiplayer.js      חלון "קבוצה" ו־WebSocket לחדרים. docs/MULTIPLAYER.md
           ├── ghosts.js           ג״ג: הקו סביב המסלול והרוחות (טהור, עם בדיקות)
           ├── itm.js              רשת ישראל (ITM) ↔ WGS84 (טהור, עם בדיקות)
           ├── real-terrain.js     שטח אמיתי: אריחי גובה, OSM → תכסית, דאטום. docs/REAL-TERRAIN.md
           ├── rain.js             סימולטור הגשם: נחלים, אגמים, יציאות, אנימציה (2D + 3D). docs/RAIN.md
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
| `N`, `WORLD_SIZE` | גודל הרשת לפי `gridResolution(mapSize, localSpacing)`: ‏1 ק"מ → 201/101 (5/10 מ׳), 4 → 96, 6 → 144, 8 → 192 |
| `state.localSpacing` | מרווח הדגימה במפה של 1 ק"מ (5 או 10) |
| `state.tool` | `'raise' \| 'lower' \| 'smooth' \| 'pan' \| 'features' \| 'course'` |
| `state.course`, `state.coursePlace`, `state.navigating` | מסלול הניווט, מה שלחיצה מציבה, והאם המשחק פעיל |
| `state.strokeTool` | הכלי בפועל במשיכה הנוכחית (אחרי Alt/Shift) |
| `state.tempPan` | רווח מוחזק |
| `state.brush`, `state.strength` | קוטר המברשת **במטרים** ועוצמה (מטר לשנייה). הרדיוס בתאים מחושב ב-`brushRadiusCells()` |
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

- **לפני** כל שינוי שאפשר לבטל: `pushUndo()`. הפונקציה שומרת snapshot (`currentSnapshot()`: גבהים, `mapSize`, `localSpacing`) ומתזמנת שמירה אוטומטית.
- משיכת מברשת שלמה היא צעד אחד בהיסטוריה (`pushUndo` ב-`pointerdown`).
- בסוף משיכה, `stopDrawing()` קורא ל-`scheduleSave()`.

## חיווט הממשק

| נושא | פונקציות ב-`scene.js` |
|---|---|
| כלים | `setTool(tool)` (מצב + צד־אפקטים), `syncToolUI()` (רק תצוגה) |
| מברשת | `setBrushSize(m)`, `setStrength(v)` (מעדכנים את הסליידר, את ה-output ואת השמירה) |
| גודל מפה ופירוט | `setMapSize(km, restoredHeights?, localSpacing?)`, `syncDetailControls()` (גבולות המברשת, בורר הפירוט, שדה הגאיות) |
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

- `npm test`: בדיקות `node:test` בתיקייה `tests/`. הן מכסות את המודולים הטהורים: `terrain-generator`, `terrain-grid`, `course`, `hydrology`, `history`, `brush`, `persistence`, `shortcuts`.
- `scripts/verify-content.mjs`: בדיקה ויזואלית ב-Chrome headless (רינדור, שגיאות, צילומי מסך). הפלט נכתב ל-`verification-shots/`; צריך למחוק אותו לפני commit.
- `window.__APP_STATS__()` חושף מצב לבדיקות אוטומטיות בדפדפן (Playwright). `?fresh` מונע טעינה של שמירה קודמת.

**שרת:** `server/server.js` (Node + ws) מגיש את `dist/` ומנהל את חדרי הניווט הקבוצתי ב־`/ws`. רץ ב־Railway דרך ה־`Dockerfile`. פרטים ב־docs/MULTIPLAYER.md.
