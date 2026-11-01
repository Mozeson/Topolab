export function initPanelSplitter(onResize) {
  const divider = document.getElementById('panelSplitter');
  const workspace = document.querySelector('.workspace');
  const desktop = matchMedia('(min-width: 900px) and (pointer: fine)');
  let ratio = 42;
  let dragging = false;
  let pending = false;
  try { const saved = Number(localStorage.getItem('topolab-scene-share')); if (saved >= 25 && saved <= 70) ratio = saved; } catch {}
  function update(next) {
    ratio = Math.max(25, Math.min(70, next));
    workspace.style.setProperty('--scene-share', ratio + 'fr');
    workspace.style.setProperty('--map-share', (100-ratio) + 'fr');
    divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
    divider.setAttribute('aria-valuetext', 'תלת־ממד ' + Math.round(ratio) + '%, מפה ' + Math.round(100-ratio) + '%');
    if (!pending) { pending = true; requestAnimationFrame(() => { pending=false; onResize(); }); }
  }
  function save() { try { localStorage.setItem('topolab-scene-share', String(ratio)); } catch {} }
  function end(event) {
    dragging=false; document.body.classList.remove('resizing-panels');
    if (event && divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    save();
  }
  divider.addEventListener('pointerdown', event => {
    if (!desktop.matches || event.button !== 0) return;
    dragging=true; divider.setPointerCapture(event.pointerId); document.body.classList.add('resizing-panels'); event.preventDefault();
  });
  divider.addEventListener('pointermove', event => {
    if (!dragging) return;
    const rect=workspace.getBoundingClientRect(); update((event.clientX-rect.left)/rect.width*100);
  });
  divider.addEventListener('pointerup',end); divider.addEventListener('pointercancel',end);
  divider.addEventListener('lostpointercapture',()=>{dragging=false;document.body.classList.remove('resizing-panels');});
  divider.addEventListener('dblclick',()=>{update(42);save();});
  divider.addEventListener('keydown',event=>{
    if (!desktop.matches) return;
    if(event.key==='ArrowLeft') update(ratio-2);
    else if(event.key==='ArrowRight') update(ratio+2);
    else if(event.key==='Home') update(25);
    else if(event.key==='End') update(70);
    else return;
    event.preventDefault(); save();
  });
  desktop.addEventListener('change',()=>{end();onResize();});
  update(ratio);
}
