import { jsPDF } from 'jspdf';

// A4 portrait at 300 DPI. jsPDF places the sheet in millimetres; all drawing is rasterized.
const FULL_WIDTH = 2480;
const FULL_HEIGHT = 3508;
const PREVIEW_WIDTH = 1050;
const PREVIEW_HEIGHT = 1485;
const FONT_STACK = "Heebo, 'Noto Sans Hebrew', Arial, sans-serif";
const MAX_MAP_MM = 180;

export const DEFAULT_PDF_OPTIONS = Object.freeze({
  mapStyle: 'shaded',
  tintOpacity: 0.55,
  showGrid: true,
  showCoordinates: true,
  showLegend: true,
  showNorth: true,
  showScale: true,
  showFeatures: true,
  include3d: false,
  threeDView: 'isometric',
});

function normalizeOptions(options = {}) {
  return { ...DEFAULT_PDF_OPTIONS, ...options };
}

function distanceLabel(meters) {
  return meters >= 1000 ? `${+(meters / 1000).toFixed(1)} ק״מ` : `${Math.round(meters)} מ׳`;
}

function mapStyleLabel(style) {
  if (style === 'contours') return 'קווי גובה בלבד';
  if (style === 'hypsometric') return 'צביעה היפסומטרית';
  return 'צביעה היפסומטרית והצללת תבליט';
}

function viewLabel(view) {
  if (view === 'current') return 'הזווית הנוכחית';
  if (view === 'top') return 'מבט מלמעלה';
  return 'מבט אלכסוני';
}

function prepareContext(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

function createPage(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawTitle(ctx, width, mm, title, subtitle) {
  const ink = '#25352e';
  const soft = '#5c6f66';
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  ctx.font = `700 ${Math.round(mm(6.6))}px ${FONT_STACK}`;
  ctx.fillText(title, width / 2, Math.round(mm(16.5)));
  ctx.font = `400 ${Math.round(mm(3.3))}px ${FONT_STACK}`;
  ctx.fillStyle = soft;
  ctx.fillText(subtitle, width / 2, Math.round(mm(23.5)));
}

function drawMapSheet(ctx, data, rawOptions, width, height) {
  const options = normalizeOptions(rawOptions);
  const { sizeKm, interval, scale, stats, colorStops, colorMin, colorMax, mapBlock } = data;
  const mm = (value) => value * width / 210;
  const margin = Math.round(mm(14));
  const extentMeters = sizeKm * 1000;
  const refMm = (sizeKm * 1e6) / scale;
  const drawnMm = Math.min(MAX_MAP_MM, refMm);
  const zoom = drawnMm / refMm;
  const mapSide = Math.round(mm(drawnMm));
  const mapX = Math.round((width - mapSide) / 2);
  const mapY = Math.round(mm(44));
  const sheetDpr = mapSide / 800;
  const ink = '#25352e';
  const soft = '#5c6f66';

  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, width, height);
  const date = new Date().toLocaleDateString('he-IL');
  drawTitle(
    ctx,
    width,
    mm,
    'מעבדת פני שטח — מפה טופוגרפית',
    `קנה מידה 1:${scale.toLocaleString('en-US')} · מרווח קווי גובה ${interval} מ׳ · ${mapStyleLabel(options.mapStyle)} · ${date}`,
  );

  ctx.save();
  ctx.translate(mapX, mapY);
  mapBlock(ctx, mapSide, mapSide, sheetDpr, options);
  ctx.restore();

  const infoY = mapY + mapSide + Math.round(mm(11));

  if (options.showScale) {
    const segmentMeters = extentMeters / 4;
    const barPx = mapSide / 4;
    const barHeight = Math.round(mm(2));
    const barX = margin;
    for (let i = 0; i < 2; i++) {
      ctx.fillStyle = i % 2 ? '#fdfcf8' : ink;
      ctx.fillRect(barX + (i * barPx) / 2, infoY, barPx / 2, barHeight);
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, mm(.35));
    ctx.strokeRect(barX, infoY, barPx, barHeight);
    ctx.fillStyle = ink;
    ctx.font = `500 ${Math.round(mm(2.9))}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.fillText('0', barX, infoY + barHeight + Math.round(mm(4.6)));
    ctx.textAlign = 'center';
    ctx.fillText(distanceLabel(segmentMeters / 2), barX + barPx / 2, infoY - Math.round(mm(1.6)));
    ctx.textAlign = 'right';
    ctx.fillText(distanceLabel(segmentMeters), barX + barPx, infoY + barHeight + Math.round(mm(4.6)));
  }

  if (options.showLegend) {
    const legendW = Math.round(mm(60));
    const legendH = Math.round(mm(3.6));
    const legendX = Math.round((width - legendW) / 2);
    for (let index = 0; index < colorStops.length; index++) {
      const [elevation, color] = colorStops[index];
      const nextElevation = colorStops[index + 1]?.[0] ?? colorMax;
      const start = Math.max(0, Math.min(1, (elevation - colorMin) / (colorMax - colorMin)));
      const end = Math.max(start, Math.min(1, (nextElevation - colorMin) / (colorMax - colorMin)));
      ctx.fillStyle = `rgb(${color.join(',')})`;
      ctx.fillRect(legendX + legendW * start, infoY, Math.max(1, legendW * (end - start)), legendH);
    }
    ctx.strokeStyle = 'rgba(37,53,46,.4)';
    ctx.lineWidth = Math.max(1, mm(.22));
    ctx.strokeRect(legendX, infoY, legendW, legendH);
    ctx.fillStyle = soft;
    ctx.font = `500 ${Math.round(mm(2.7))}px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(stats.max)} מ׳`, legendX + legendW, infoY + legendH + Math.round(mm(4.4)));
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(stats.min)} מ׳`, legendX, infoY + legendH + Math.round(mm(4.4)));
    ctx.textAlign = 'center';
    ctx.fillText('גובה', width / 2, infoY + legendH + Math.round(mm(4.4)));
  }

  if (options.showNorth) {
    const northX = width - margin - Math.round(mm(6));
    const northY = infoY + Math.round(mm(1.6));
    const northR = Math.round(mm(5.4));
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, mm(.3));
    ctx.beginPath();
    ctx.arc(northX, northY, northR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.moveTo(northX, northY - northR * .72);
    ctx.lineTo(northX - northR * .3, northY + northR * .42);
    ctx.lineTo(northX, northY + northR * .12);
    ctx.lineTo(northX + northR * .3, northY + northR * .42);
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 ${Math.round(mm(3.4))}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText('צ', northX, northY + northR + Math.round(mm(4.4)));
  }

  ctx.fillStyle = soft;
  ctx.font = `400 ${Math.round(mm(2.75))}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.fillText(
    `קווי גובה מחברים נקודות בעלות אותו גובה · גודל הציור: ${Math.round(zoom * 100)}% ביחס ל־1:${scale.toLocaleString('en-US')} · להדפסה מדויקת: גודל אמיתי 100%`,
    width / 2,
    height - Math.round(mm(9)),
  );
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load the 3D preview image.'));
    image.src = source;
  });
}

async function draw3dSheet(ctx, data, rawOptions, width, height) {
  const options = normalizeOptions(rawOptions);
  const mm = (value) => value * width / 210;
  const ink = '#25352e';
  const soft = '#5c6f66';
  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, width, height);
  drawTitle(
    ctx,
    width,
    mm,
    'מעבדת פני שטח — מודל תלת־ממדי',
    `${viewLabel(options.threeDView)} · מפה ${data.sizeKm}×${data.sizeKm} ק״מ · הגזמה אנכית ×${data.exaggeration.toFixed(1)}`,
  );

  const frameX = Math.round(mm(14));
  const frameY = Math.round(mm(39));
  const frameW = width - frameX * 2;
  const frameH = Math.round(mm(168));
  roundedRect(ctx, frameX, frameY, frameW, frameH, Math.round(mm(3)));
  ctx.fillStyle = '#e4e9df';
  ctx.fill();
  ctx.save();
  roundedRect(ctx, frameX, frameY, frameW, frameH, Math.round(mm(3)));
  ctx.clip();
  if (data.threeDImage) {
    const image = await loadImage(data.threeDImage);
    const ratio = Math.min(frameW / image.naturalWidth, frameH / image.naturalHeight);
    const drawW = image.naturalWidth * ratio;
    const drawH = image.naturalHeight * ratio;
    ctx.drawImage(image, frameX + (frameW - drawW) / 2, frameY + (frameH - drawH) / 2, drawW, drawH);
  }
  ctx.restore();
  ctx.strokeStyle = '#c8d0c3';
  ctx.lineWidth = Math.max(1, mm(.3));
  roundedRect(ctx, frameX, frameY, frameW, frameH, Math.round(mm(3)));
  ctx.stroke();

  const statsY = frameY + frameH + Math.round(mm(13));
  const gap = Math.round(mm(4));
  const cardW = (frameW - gap * 2) / 3;
  const cards = [
    ['הגובה הנמוך ביותר', `${Math.round(data.stats.min)} מ׳`],
    ['הגובה הגבוה ביותר', `${Math.round(data.stats.max)} מ׳`],
    ['שטח המפה', `${data.sizeKm}×${data.sizeKm} ק״מ`],
  ];
  cards.forEach(([label, value], index) => {
    const x = frameX + index * (cardW + gap);
    roundedRect(ctx, x, statsY, cardW, Math.round(mm(24)), Math.round(mm(2.2)));
    ctx.fillStyle = index === 1 ? '#e9dcc8' : '#edf1e9';
    ctx.fill();
    ctx.fillStyle = soft;
    ctx.textAlign = 'center';
    ctx.font = `500 ${Math.round(mm(2.9))}px ${FONT_STACK}`;
    ctx.fillText(label, x + cardW / 2, statsY + Math.round(mm(8)));
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(mm(5.2))}px ${FONT_STACK}`;
    ctx.fillText(value, x + cardW / 2, statsY + Math.round(mm(17)));
  });

  ctx.fillStyle = soft;
  ctx.font = `400 ${Math.round(mm(2.9))}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.fillText('המודל מציג את אותם נתוני גובה כמו המפה הטופוגרפית שבעמוד הראשון.', width / 2, height - Math.round(mm(13)));
  ctx.fillText('ההגזמה האנכית משפרת את קריאות התבליט בתצוגה ואינה משנה את הגבהים המספריים.', width / 2, height - Math.round(mm(8)));
}

async function renderPages(data, rawOptions, width, height) {
  const options = normalizeOptions(rawOptions);
  const mapPage = createPage(width, height);
  drawMapSheet(prepareContext(mapPage), data, options, width, height);
  const pages = [{ kind: 'map', canvas: mapPage }];
  if (options.include3d && data.threeDImage) {
    const modelPage = createPage(width, height);
    await draw3dSheet(prepareContext(modelPage), data, options, width, height);
    pages.push({ kind: '3d', canvas: modelPage });
  }
  return pages;
}

export async function renderTopographicPreview(data, options = {}) {
  const pages = await renderPages(data, options, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  return pages.map(({ kind, canvas }) => ({ kind, dataUrl: canvas.toDataURL('image/jpeg', .9) }));
}

export async function exportTopographicPdf(data, options = {}) {
  const pages = await renderPages(data, options, FULL_WIDTH, FULL_HEIGHT);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  pdf.setProperties({
    title: 'TopoLab — מפה טופוגרפית',
    subject: 'מפה טופוגרפית ומודל פני שטח',
    creator: 'TopoLab',
  });
  pages.forEach(({ canvas }, index) => {
    if (index) pdf.addPage('a4', 'portrait');
    pdf.addImage(canvas.toDataURL('image/jpeg', .95), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
  });
  const fileName = `topolab-map-${new Date().toISOString().slice(0, 10)}.pdf`;
  pdf.save(fileName);
  return { fileName, pageCount: pages.length };
}
