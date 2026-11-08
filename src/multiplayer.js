// Team navigation, the browser side: the "קבוצה" dialog (create or join a room by its code,
// the lobby, the host's options), the WebSocket to server/server.js, and the hand-off to the
// field game (nav-game.js openTeam / teamMessage). See docs/MULTIPLAYER.md.
//
// The host's map and course go to everyone as a saved project (persistence.js). A guest's
// own work is left alone: their autosave is paused while they play (scene.js lock) and their
// map comes back when they leave the room.

const NAME_KEY = 'topolab-team-name';
const $ = (id) => document.getElementById(id);

export function createTeam(api) {
  // api: { getProject, coursePoints, extent, courseReady, applyProject, lock(on), restoreLocal,
  //        openSetup(info), navGame, toast, editCourse }
  let ws = null;
  let you = null;
  let room = null;
  let setup = null;     // the current round: { split, options, finished }
  let locked = false;   // a guest's autosave is paused
  const dialog = $('teamDialog');

  try { $('teamName').value = localStorage.getItem(NAME_KEY) || ''; } catch { /* storage unavailable */ }

  const isHost = () => room && room.host === you;
  const send = (message) => { if (ws?.readyState === 1) ws.send(JSON.stringify(message)); };

  function showError(text) {
    $('teamError').textContent = text || '';
    $('teamError').hidden = !text;
  }

  function myName() {
    const name = $('teamName').value.trim();
    try { localStorage.setItem(NAME_KEY, name); } catch { /* storage unavailable */ }
    return name;
  }

  function connect() {
    if (ws && ws.readyState <= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws = socket;
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('connect')), { once: true });
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        onMessage(message);
      });
      socket.addEventListener('close', () => {
        if (ws !== socket) return;
        ws = null;
        if (room) {
          api.toast('החיבור לחדר נותק.');
          endRoom();
        }
      });
    });
  }

  async function enter(message) {
    showError('');
    try { await connect(); } catch { showError('אין חיבור לשרת. נסו שוב בעוד רגע.'); return; }
    send(message);
  }

  $('teamCreateBtn').addEventListener('click', () => enter({ t: 'create', name: myName() }));
  $('teamJoinForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('teamCode').value.trim();
    if (!/^\d{4}$/.test(code)) { $('teamCode').focus(); return; }
    enter({ t: 'join', code, name: myName() });
  });
  $('closeTeamBtn').addEventListener('click', () => dialog.close());
  $('teamLeaveBtn').addEventListener('click', () => { send({ t: 'leave' }); endRoom(); });
  $('teamEditBtn').addEventListener('click', () => { dialog.close(); api.editCourse(); });
  $('teamStartBtn').addEventListener('click', () => {
    if (!isHost()) return;
    const problem = api.courseReady();
    if (problem) { showError(problem); return; }
    showError('');
    const options = {
      mapMode: document.querySelector('input[name="teamMapMode"]:checked')?.value || 'mine',
      camels: document.querySelector('input[name="teamCamels"]:checked')?.value || 'none',
      ghosts: document.querySelector('input[name="teamGhosts"]:checked')?.value || 'none',
    };
    if (room.phase === 'finished') send({ t: 'again' });
    send({ t: 'setup', project: api.getProject(), points: api.coursePoints(), extent: api.extent(), options });
  });

  function onMessage(message) {
    switch (message.t) {
      case 'joined':
        you = message.you;
        room = message.room;
        render();
        break;
      case 'room':
        room = message.room;
        render();
        break;
      case 'error':
        showError(message.text);
        break;
      case 'setup': {
        // A new round: guests take the host's map; everyone opens their own briefing.
        if (api.navGame.active) api.navGame.stop();
        setup = { split: message.split, options: message.options || {}, finished: false };
        if (!isHost()) {
          if (!locked) { api.lock(true); locked = true; }
          if (!api.applyProject(message.project)) { showError('לא הצלחנו לטעון את המפה של המנהל.'); return; }
        }
        dialog.open && dialog.close();
        api.openSetup({
          me: you,
          players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
          split: message.split,
          options: setup.options,
          send,
          ended: onFieldEnded,
        });
        break;
      }
      case 'finish':
        if (setup) setup.finished = true;
        api.navGame.teamMessage(message);
        break;
      case 'start': case 'next': case 'pos': case 'strays': case 'shout': case 'penalty': case 'left':
        api.navGame.teamMessage(message);
        break;
      default: break;
    }
  }

  // The player left the field: after the finish they stay in the room for another round;
  // walking out in the middle leaves the room (the group goes on without them).
  function onFieldEnded() {
    if (!room || setup?.finished) return;
    send({ t: 'leave' });
    endRoom();
    api.toast('יצאתם מהניווט הקבוצתי ומהחדר.');
  }

  function endRoom() {
    const wasLocked = locked;
    room = null;
    you = null;
    setup = null;
    locked = false;
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
    api.navGame.endTeam?.();
    if (wasLocked) { api.lock(false); api.restoreLocal(); }
    render();
  }

  function render() {
    const inRoom = Boolean(room);
    $('teamEntry').hidden = inRoom;
    $('teamLobby').hidden = !inRoom;
    $('teamBtn').classList.toggle('in-room', inRoom);
    $('teamBtnLabel').textContent = inRoom ? `קבוצה ${room.code}` : 'קבוצה';
    if (!inRoom) return;
    $('teamCodeLabel').textContent = room.code;
    $('teamRoster').innerHTML = room.players.map((p) => `<li style="--c:${p.color}"><i></i><b></b><small>${p.id === room.host ? '👑 מנהל' : ''}${p.id === you ? ' · אתם' : ''}${room.phase === 'briefing' && p.ready ? ' · מוכן ✓' : ''}</small></li>`).join('');
    // Names as text, never as markup.
    [...$('teamRoster').querySelectorAll('b')].forEach((b, i) => { b.textContent = room.players[i].name; });
    $('teamHostPanel').hidden = !isHost();
    $('teamGuestHint').hidden = isHost();
    if (isHost()) {
      const problem = api.courseReady();
      const n = room.players.length;
      $('teamCourseHint').textContent = problem
        || `הציר יתחלק בין ${n} ${n === 1 ? 'משתתף' : 'משתתפים'}: כל אחד לומד נקודה אחת או שתיים (כולל הסיום). מקסימום ${n * 2} נקודות.`;
      $('teamStartBtn').textContent = room.phase === 'finished' ? 'סיבוב נוסף ▶' : 'שליחה וחלוקה ▶';
      $('teamStartBtn').disabled = room.phase === 'briefing' || room.phase === 'running';
    }
    $('teamGuestHint').textContent = room.phase === 'lobby' || room.phase === 'finished'
      ? 'המנהל בונה מפה וציר. ברגע שישלח, יופיע התדריך שלכם.'
      : 'המשחק בעיצומו.';
  }

  return {
    open() {
      render();
      showError('');
      if (!dialog.open) dialog.showModal();
      if (!room) $('teamName').focus();
    },
    get inRoom() { return Boolean(room); },
  };
}
