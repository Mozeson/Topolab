const byId = (id) => document.getElementById(id);
const DEFAULT_PDF_OPTIONS = Object.freeze({
  mapStyle: 'shaded',
  tintOpacity: 0.85,
  showGrid: true,
  showCoordinates: true,
  showLegend: true,
  showNorth: true,
  showScale: true,
  showFeatures: true,
  include3d: false,
  threeDView: 'isometric',
});
let printerPromise = null;

function loadPrinter() {
  printerPromise ||= import('./print.js');
  return printerPromise;
}

export function createPdfPreviewController(api) {
  const dialog = byId('pdfPreviewDialog');
  const previewImage = byId('pdfPreviewImage');
  const loading = byId('pdfPreviewLoading');
  const status = byId('pdfExportStatus');
  const downloadButton = byId('downloadPdfBtn');
  const mapTab = byId('pdfMapPageBtn');
  const modelTab = byId('pdf3dPageBtn');
  const include3d = byId('pdfInclude3d');
  const threeDView = byId('pdf3dView');
  const opacity = byId('pdfTintOpacity');
  const opacityValue = byId('pdfTintOpacityValue');
  let baseData = null;
  let pages = [];
  let activePage = 0;
  let renderToken = 0;
  let renderTimer = null;
  let downloading = false;
  const captureCache = new Map();

  function readOptions() {
    return {
      ...DEFAULT_PDF_OPTIONS,
      mapStyle: dialog.querySelector('input[name="pdfMapStyle"]:checked')?.value || 'shaded',
      tintOpacity: Number(opacity.value) / 100,
      showGrid: byId('pdfShowGrid').checked,
      showCoordinates: byId('pdfShowCoordinates').checked,
      showLegend: byId('pdfShowLegend').checked,
      showNorth: byId('pdfShowNorth').checked,
      showScale: byId('pdfShowScale').checked,
      showFeatures: byId('pdfShowFeatures').checked,
      include3d: include3d.checked,
      threeDView: threeDView.value,
    };
  }

  function updateControls() {
    const options = readOptions();
    opacity.disabled = options.mapStyle === 'contours';
    opacityValue.textContent = `${opacity.value}%`;
    threeDView.disabled = !options.include3d;
    modelTab.hidden = !options.include3d;
    if (!options.include3d && activePage === 1) activePage = 0;
  }

  function showPage(index) {
    if (!pages.length) return;
    activePage = Math.max(0, Math.min(index, pages.length - 1));
    previewImage.src = pages[activePage].dataUrl;
    mapTab.classList.toggle('active', activePage === 0);
    mapTab.setAttribute('aria-selected', String(activePage === 0));
    modelTab.classList.toggle('active', activePage === 1);
    modelTab.setAttribute('aria-selected', String(activePage === 1));
    byId('pdfPreviewCaption').textContent = `עמוד ${activePage + 1} מתוך ${pages.length} · קנה המידה נשמר בהדפסה בגודל אמיתי 100%`;
  }

  async function dataWith3d(options) {
    if (!options.include3d) return baseData;
    if (!captureCache.has(options.threeDView)) {
      captureCache.set(options.threeDView, await api.capture3D(options.threeDView));
    }
    return { ...baseData, threeDImage: captureCache.get(options.threeDView) };
  }

  async function renderPreview() {
    if (!dialog.open || !baseData) return;
    const token = ++renderToken;
    const options = readOptions();
    loading.hidden = false;
    status.textContent = options.include3d ? 'מכין את שני עמודי המסמך…' : 'מעדכן את התצוגה המקדימה…';
    try {
      const renderData = await dataWith3d(options);
      const { renderTopographicPreview } = await loadPrinter();
      const nextPages = await renderTopographicPreview(renderData, options);
      if (token !== renderToken || !dialog.open) return;
      pages = nextPages;
      showPage(activePage);
      status.textContent = options.include3d ? 'המסמך מוכן: שני עמודים.' : 'המסמך מוכן: עמוד אחד.';
    } catch (error) {
      console.error('PDF preview failed', error);
      if (token !== renderToken) return;
      status.textContent = 'לא ניתן להכין את התצוגה המקדימה.';
      api.notify('הכנת התצוגה המקדימה נכשלה. נסו שוב.', true);
    } finally {
      if (token === renderToken) loading.hidden = true;
    }
  }

  function queueRender(delay = 120) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderPreview, delay);
  }

  async function open() {
    if (dialog.open) return;
    baseData = api.getData();
    pages = [];
    activePage = 0;
    captureCache.clear();
    status.textContent = 'מכין תצוגה מקדימה…';
    previewImage.removeAttribute('src');
    updateControls();
    dialog.showModal();
    await document.fonts?.ready;
    await renderPreview();
  }

  function close() {
    if (downloading) return;
    renderToken++;
    clearTimeout(renderTimer);
    if (dialog.open) dialog.close();
  }

  async function download() {
    if (downloading || !baseData) return;
    downloading = true;
    downloadButton.disabled = true;
    loading.hidden = false;
    status.textContent = 'יוצר PDF באיכות הדפסה…';
    try {
      const options = readOptions();
      const renderData = await dataWith3d(options);
      const { exportTopographicPdf } = await loadPrinter();
      const result = await exportTopographicPdf(renderData, options);
      status.textContent = `${result.pageCount === 2 ? 'שני העמודים הורדו' : 'המפה הורדה'} בהצלחה.`;
      api.notify('קובץ ה־PDF הורד בהצלחה.');
    } catch (error) {
      console.error('PDF export failed', error);
      status.textContent = 'הייצוא נכשל. אפשר לנסות שוב.';
      api.notify('הייצוא ל־PDF נכשל. נסו שוב.', true);
    } finally {
      downloading = false;
      downloadButton.disabled = false;
      loading.hidden = true;
    }
  }

  dialog.querySelectorAll('input[name="pdfMapStyle"], .pdf-layer-grid input').forEach((control) => {
    control.addEventListener('change', () => { updateControls(); queueRender(); });
  });
  opacity.addEventListener('input', () => { updateControls(); queueRender(180); });
  include3d.addEventListener('change', () => { updateControls(); queueRender(40); });
  threeDView.addEventListener('change', () => queueRender(40));
  mapTab.addEventListener('click', () => showPage(0));
  modelTab.addEventListener('click', () => showPage(1));
  byId('closePdfPreviewBtn').addEventListener('click', close);
  byId('cancelPdfPreviewBtn').addEventListener('click', close);
  downloadButton.addEventListener('click', download);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  return { open };
}
