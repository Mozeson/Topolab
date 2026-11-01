import * as THREE from 'three';

export function createSheepGame(api) {
  const $ = id => document.getElementById(id);
  const sheep = { placed: false, placing: false, hidden: false, found: false, u: .65, v: .5 };
  let model;
  let clicks = 0;
  let lastClick = 0;
  function message(text) { $('sheepStatus').textContent = text; }
  function refresh() {
    $('placeSheepBtn').textContent = sheep.placing ? 'ביטול הצבה' : sheep.placed ? 'הזזת הכבשה' : 'הצבת כבשה';
    $('hideSheepBtn').disabled = !sheep.placed;
    $('hideSheepBtn').textContent = sheep.hidden ? 'גילוי במפה' : 'הסתרה במפה';
    $('hideSheepBtn').setAttribute('aria-pressed', String(sheep.hidden));
    $('findSheepBtn').disabled = !sheep.placed;
    $('removeSheepBtn').disabled = !sheep.placed;
    update3D(); api.redraw();
  }
  function reveal() {
    const now = performance.now();
    clicks = now - lastClick < 1800 ? clicks + 1 : 1;
    lastClick = now;
    if (clicks < 5) return;
    clicks = 0;
    $('sheepControls').hidden = !$('sheepControls').hidden;
    if ($('sheepControls').hidden) sheep.placing = false;
    else message('מצאתם את ההפתעה! הציבו כבשה על אחת הכיפות.');
    refresh();
  }
  $('sheepSecret').addEventListener('click', reveal);
  $('sheepSecret').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reveal(); }
  });
  $('placeSheepBtn').addEventListener('click', () => {
    api.stop(); api.cancelObserverPlacement();
    sheep.placing = !sheep.placing;
    message(sheep.placing ? 'לחצו במפה במקום שבו הכבשה תחכה.' : 'ההצבה בוטלה.'); refresh();
  });
  $('hideSheepBtn').addEventListener('click', () => {
    sheep.hidden = !sheep.hidden;
    message(sheep.hidden ? 'הכבשה מוסתרת במפה, אך נשארת בשטח. הציבו אדם וחפשו אותה.' : 'מיקום הכבשה גלוי במפה.'); refresh();
  });
  $('removeSheepBtn').addEventListener('click', () => {
    Object.assign(sheep, { placed: false, placing: false, found: false, hidden: false });
    message('הכבשה הוסרה. אפשר להציב אותה שוב.'); refresh();
  });
  $('findSheepBtn').addEventListener('click', checkFound);
  function checkFound() {
    const observer = api.observer();
    if (!sheep.placed) return false;
    if (!observer.placed || !observer.firstPerson) { message('עברו למבט האדם כדי לבדוק את ההגעה.'); return false; }
    const distance = Math.hypot(observer.u - sheep.u, observer.v - sheep.v) * api.extent();
    if (distance > 50) { message('עדיין לא הגעתם. המשיכו לחפש ולהזיז את האדם; צריך להגיע עד 50 מ׳ מהכבשה.'); return false; }
    const camera = api.camera(), terrain = api.terrain();
    if (camera && terrain && model) {
      const target = model.position.clone().add(new THREE.Vector3(0, .065, 0));
      const direction = target.sub(camera.position);
      const distance3D = direction.length();
      terrain.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(camera.position, direction.normalize(), .001, Math.max(.001, distance3D - .01));
      if (ray.intersectObject(terrain).length) { message('אתם קרובים, אבל פני השטח עדיין מסתירים את הכבשה. נסו להתקרב מהצד השני.'); return false; }
    }
    sheep.found = true; sheep.hidden = false;
    message('מצאתם את הכבשה! 🐑 הגעתם עד 50 מ׳ ויש קו ראייה אליה.'); refresh(); return true;
  }
  function place(u, v) {
    if (!sheep.placing) return false;
    Object.assign(sheep, {u, v, placed: true, placing: false, hidden: false, found: false});
    message('הכבשה הוצבה. הסתירו אותה במפה, הציבו אדם ונסו להגיע אליה.'); refresh(); return true;
  }
  function makeModel() {
    const group = new THREE.Group();
    const wool = new THREE.MeshStandardMaterial({color: 0xfff9e9, roughness: 1});
    const dark = new THREE.MeshStandardMaterial({color: 0x343b36, roughness: 1});
    function part(x,y,z,sx,sy,sz,material) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), material);
      mesh.position.set(x,y,z); mesh.scale.set(sx,sy,sz); group.add(mesh);
    }
    part(0,.065,0,.075,.05,.045,wool);
    part(.065,.075,0,.03,.035,.027,dark);
    part(.065,.095,.032,.025,.009,.012,dark);
    part(.065,.095,-.032,.025,.009,.012,dark);
    for (const x of [-.04,.035]) for (const z of [-.026,.026]) part(x,.025,z,.009,.025,.009,dark);
    part(.087,.088,.018,.005,.005,.005,wool);
    part(.087,.088,-.018,.005,.005,.005,wool);
    return group;
  }
  function update3D() {
    const scene = api.scene();
    if (!scene) return;
    if (!model && sheep.placed) { model = makeModel(); scene.add(model); }
    if (!model) return;
    model.visible = sheep.placed;
    if (sheep.placed) model.position.set((sheep.u-.5)*api.worldSize(), api.height(sheep.u,sheep.v)*api.verticalScale(), (sheep.v-.5)*api.worldSize());
    api.invalidate();
  }
  function draw(ctx, canvas, dpr) {
    if (!sheep.placed || sheep.hidden) return;
    const x=sheep.u*canvas.width, y=sheep.v*canvas.height;
    ctx.save(); ctx.beginPath(); ctx.arc(x,y,15*dpr,0,Math.PI*2);
    ctx.fillStyle = sheep.found ? '#bde5b5' : '#fffdf4'; ctx.fill();
    ctx.strokeStyle='#426246'; ctx.lineWidth=1.5*dpr; ctx.stroke();
    ctx.font=(21*dpr)+'px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle='#24382b'; ctx.fillText('🐑',x,y+1*dpr); ctx.restore();
  }
  // Preserve physical location relative to the center when the terrain extent changes.
  function resize(oldSize,newSize) {
    if (!sheep.placed) return;
    sheep.u=.5+(sheep.u-.5)*oldSize/newSize; sheep.v=.5+(sheep.v-.5)*oldSize/newSize;
    if (sheep.u<0 || sheep.u>1 || sheep.v<0 || sheep.v>1) { sheep.placed=false; message('הכבשה נמצאת מחוץ למפה שהוקטנה. הציבו אותה מחדש.'); }
    refresh();
  }
  refresh();
  return { place, draw, update3D, resize, cancelPlacement(){sheep.placing=false;refresh();}, get placing(){return sheep.placing;} };
}
