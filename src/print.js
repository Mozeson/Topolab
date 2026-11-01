import { jsPDF } from 'jspdf';

// A4 portrait at 300 DPI. jsPDF places the sheet in millimetres; all layout here is in px.
const SHEET_W = 2480;
const SHEET_H = 3508;
const MM_TO_PX = SHEET_W / 210;
const MARGIN = Math.round(14 * MM_TO_PX);
const FONT_STACK = "Heebo, 'Noto Sans Hebrew', Arial, sans-serif";
const MAX_MAP_MM = 180;

function distanceLabel(meters) {
  return meters >= 1000 ? `${+(meters / 1000).toFixed(1)} ק״מ` : `${Math.round(meters)} מ׳`;
}

function drawSheet(ctx, data) {
  const { sizeKm, interval, scale, stats, colorStops, colorMin, colorMax, mapBlock } = data;
  const extentMeters = sizeKm * 1000;
  const refMm = (sizeKm * 1e6) / scale; // true paper size of the map at the chosen scale
  const drawnMm = Math.min(MAX_MAP_MM, refMm);
  const zoom = drawnMm / refMm;
  const mapSide = Math.round(drawnMm * MM_TO_PX);
  const mapX = Math.round((SHEET_W - mapSide) / 2);
  const mapY = Math.round(44 * MM_TO_PX);
  // Match print sizes to screen sizes: an ~800 css px screen map ≈ the printed size.
  const sheetDpr = mapSide / 800;
  const ink = '#25352e';
  const soft = '#5c6f66';

  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);
  ctx.direction = 'rtl';

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  ctx.font = `700 ${Math.round(6.6 * MM_TO_PX)}px ${FONT_STACK}`;
  ctx.fillText('מעבדת פני שטח — מפה טופוגרפית', SHEET_W / 2, Math.round(16.5 * MM_TO_PX));
  ctx.font = `400 ${Math.round(3.3 * MM_TO_PX)}px ${FONT_STACK}`;
  ctx.fillStyle = soft;
  const date = new Date().toLocaleDateString('he-IL');
  ctx.fillText(
    `קנה מידה 1:${scale.toLocaleString('en-US')} · מרווח קווי גובה ${interval} מ׳ · מפה ${sizeKm}×${sizeKm} ק״מ · ${date}`,
    SHEET_W / 2, Math.round(23.5 * MM_TO_PX),
  );

  ctx.save();
  ctx.translate(mapX, mapY);
  mapBlock(ctx, mapSide, mapSide, sheetDpr);
  ctx.restore();

  const infoY = mapY + mapSide + Math.round(11 * MM_TO_PX);

  // Scale bar: one quarter of the map, labeled in round meters — at 100% size,
  // each centimeter on paper represents scale/100 meters (250 m at 1:25,000).
  const segmentMeters = extentMeters / 4;
  const barPx = mapSide / 4;
  const barHeight = Math.round(2 * MM_TO_PX);
  const barX = MARGIN;
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = i % 2 ? '#fdfcf8' : ink;
    ctx.fillRect(barX + (i * barPx) / 2, infoY, barPx / 2, barHeight);
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, .35 * MM_TO_PX);
  ctx.strokeRect(barX, infoY, barPx, barHeight);
  ctx.fillStyle = ink;
  ctx.font = `500 ${Math.round(2.9 * MM_TO_PX)}px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.fillText('0', barX, infoY + barHeight + Math.round(4.6 * MM_TO_PX));
  ctx.textAlign = 'center';
  ctx.fillText(distanceLabel(segmentMeters / 2), barX + barPx / 2, infoY - Math.round(1.6 * MM_TO_PX));
  ctx.textAlign = 'right';
  ctx.fillText(distanceLabel(segmentMeters), barX + barPx, infoY + barHeight + Math.round(4.6 * MM_TO_PX));

  // Elevation legend: the app's colour ramp between the terrain's actual min and max.
  const legendW = Math.round(60 * MM_TO_PX);
  const legendH = Math.round(3.6 * MM_TO_PX);
  const legendX = Math.round((SHEET_W - legendW) / 2);
  const gradient = ctx.createLinearGradient(legendX, 0, legendX + legendW, 0);
  for (const [h, c] of colorStops) gradient.addColorStop((h - colorMin) / (colorMax - colorMin), `rgb(${c.join(',')})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(legendX, infoY, legendW, legendH);
  ctx.strokeStyle = 'rgba(37,53,46,.4)';
  ctx.lineWidth = Math.max(1, .22 * MM_TO_PX);
  ctx.strokeRect(legendX, infoY, legendW, legendH);
  ctx.fillStyle = soft;
  ctx.font = `500 ${Math.round(2.7 * MM_TO_PX)}px ${FONT_STACK}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(stats.max)} מ׳`, legendX + legendW, infoY + legendH + Math.round(4.4 * MM_TO_PX));
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(stats.min)} מ׳`, legendX, infoY + legendH + Math.round(4.4 * MM_TO_PX));
  ctx.textAlign = 'center';
  ctx.fillText('גובה', SHEET_W / 2, infoY + legendH + Math.round(4.4 * MM_TO_PX));

  // North arrow.
  const northX = SHEET_W - MARGIN - Math.round(6 * MM_TO_PX);
  const northY = infoY + Math.round(1.6 * MM_TO_PX);
  const northR = Math.round(5.4 * MM_TO_PX);
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, .3 * MM_TO_PX);
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
  ctx.font = `600 ${Math.round(3.4 * MM_TO_PX)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.fillText('צ', northX, northY + northR + Math.round(4.4 * MM_TO_PX));

  ctx.fillStyle = soft;
  ctx.font = `400 ${Math.round(2.9 * MM_TO_PX)}px ${FONT_STACK}`;
  ctx.fillText(
    `קווי גובה מחברים נקודות בעלות אותו גובה · גודל הציור: ${Math.round(zoom * 100)}% ביחס ל־1:${scale.toLocaleString('en-US')} · להדפסה מדויקת: גודל אמיתי 100% · נוצר באמצעות מעבדת פני שטח`,
    SHEET_W / 2, SHEET_H - Math.round(9 * MM_TO_PX),
  );
}

export async function exportTopographicPdf(data) {
  const sheet = document.createElement('canvas');
  sheet.width = SHEET_W;
  sheet.height = SHEET_H;
  drawSheet(sheet.getContext('2d'), data);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  pdf.addImage(sheet.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297);
  pdf.save(`topolab-map-${new Date().toISOString().slice(0, 10)}.pdf`);
}
