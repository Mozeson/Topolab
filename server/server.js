// Topolab's server: serves the built site (dist/) and runs team-navigation rooms over a
// WebSocket at /ws. Rooms live in memory (a restart ends them). The server is the referee:
// it splits the course (src/team.js), checks that the whole group reached each control,
// passes the lead on, and keeps the team clock. Clients send their positions ~10×/s.
//
//   PORT  port to listen on (Railway sets it; default 8080)
//   DIST  folder of the built site (default ../dist)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TEAM, splitCourse, groupAt, strays, roomCode } from '../src/team.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.env.DIST || path.join(here, '..', 'dist'));
const PORT = Number(process.env.PORT) || 8080;
const TICK_MS = 100;
const ROOM_IDLE_MS = 3 * 3600e3;

// ——— Static files ———
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.hdr': 'image/vnd.radiance', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm',
};

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  let file = path.join(DIST, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  fs.stat(file, (error, stat) => {
    if (!error && stat.isDirectory()) file = path.join(file, 'index.html');
    else if (error) file = path.join(DIST, 'index.html'); // unknown paths: the app
    fs.stat(file, (error2, stat2) => {
      if (error2) { res.writeHead(404).end('Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      const rel = path.relative(DIST, file).split(path.sep).join('/');
      const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': stat2.size };
      // Built scripts and styles carry a content hash: cache for good. The page is always revalidated.
      if (/^assets\/[^/]+\.(m?js|css)$/.test(rel)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      else if (ext === '.html') headers['Cache-Control'] = 'no-cache';
      else headers['Cache-Control'] = 'public, max-age=3600';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  serveStatic(req, res);
});

// ——— Rooms ———
const rooms = new Map();
let nextId = 1;

const cleanName = (name) => String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'מנווט';
const send = (ws, message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };

function roomView(room) {
  return {
    code: room.code,
    host: room.host,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready })),
  };
}

function broadcast(room, message, except = null) {
  const text = JSON.stringify(message);
  for (const p of room.players.values()) if (p.id !== except && p.ws.readyState === 1) p.ws.send(text);
}

function announce(room) {
  broadcast(room, { t: 'room', room: roomView(room) });
}

function newRoom() {
  let code;
  do code = roomCode(); while (rooms.has(code));
  const room = { code, host: null, phase: 'lobby', players: new Map(), setup: null, split: null, next: 1, startAt: 0, penalty: 0, strays: '', touched: Date.now() };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, ws, name) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const player = { id: `p${nextId++}`, name: cleanName(name), color: TEAM.colors.find((c) => !used.has(c)) || TEAM.colors[0], ws, pos: null, ready: false };
  room.players.set(player.id, player);
  if (!room.host) room.host = player.id;
  ws.room = room;
  ws.player = player;
  send(ws, { t: 'joined', you: player.id, room: roomView(room) });
  announce(room);
}

function removePlayer(ws) {
  const room = ws.room;
  const player = ws.player;
  if (!room || !player) return;
  ws.room = null;
  ws.player = null;
  room.players.delete(player.id);
  if (!room.players.size) { rooms.delete(room.code); return; }
  if (room.host === player.id) room.host = room.players.keys().next().value;
  broadcast(room, { t: 'left', id: player.id, name: player.name });
  announce(room);
  // A runner who left must not hold the group back; a briefing may now be complete.
  if (room.phase === 'briefing') maybeStart(room);
}

function positions(room) {
  return new Map([...room.players.values()].map((p) => [p.id, p.pos]));
}

function maybeStart(room) {
  if (room.phase !== 'briefing' || ![...room.players.values()].every((p) => p.ready)) return;
  room.phase = 'running';
  room.startAt = Date.now();
  room.next = 1;
  room.penalty = 0;
  broadcast(room, { t: 'start', next: 1, leader: room.split.owners[1] });
  announce(room);
}

function onMessage(ws, message) {
  const room = ws.room;
  const me = ws.player;
  if (room) room.touched = Date.now();
  switch (message.t) {
    case 'create': {
      if (room) removePlayer(ws);
      addPlayer(newRoom(), ws, message.name);
      break;
    }
    case 'join': {
      const target = rooms.get(String(message.code || '').trim());
      if (!target) { send(ws, { t: 'error', code: 'no-room', text: 'אין חדר עם הקוד הזה.' }); return; }
      if (target.phase !== 'lobby') { send(ws, { t: 'error', code: 'started', text: 'המשחק בחדר הזה כבר התחיל.' }); return; }
      if (target.players.size >= TEAM.maxPlayers) { send(ws, { t: 'error', code: 'full', text: `החדר מלא (${TEAM.maxPlayers} משתתפים).` }); return; }
      if (room) removePlayer(ws);
      addPlayer(target, ws, message.name);
      break;
    }
    case 'leave': removePlayer(ws); break;
    case 'setup': {
      // The host sends the map and the course: split it and brief everyone.
      if (!room || room.host !== me.id || room.phase !== 'lobby') return;
      const points = Array.isArray(message.points) ? message.points.slice(0, 40) : [];
      const extent = Number(message.extent);
      if (points.length < 2 || !(extent > 0) || typeof message.project !== 'string') { send(ws, { t: 'error', code: 'bad-setup', text: 'אין מסלול לשלוח.' }); return; }
      const ids = [...room.players.keys()];
      const split = splitCourse(points.length - 1, ids);
      if (!split) {
        send(ws, { t: 'error', code: 'too-long', text: `המסלול ארוך מדי לקבוצה: עד ${ids.length * TEAM.maxPerPlayer} נקודות (כולל הסיום) ל־${ids.length} משתתפים.` });
        return;
      }
      room.setup = { project: message.project, points: points.map((p) => ({ u: +p.u, v: +p.v, kind: p.kind, number: p.number })), extent, options: message.options || {} };
      room.split = split;
      room.phase = 'briefing';
      for (const p of room.players.values()) { p.ready = false; p.pos = null; }
      broadcast(room, { t: 'setup', ...room.setup, split });
      announce(room);
      break;
    }
    case 'ready': {
      if (!room || room.phase !== 'briefing') return;
      me.ready = true;
      if (message.pos) me.pos = { u: +message.pos.u, v: +message.pos.v, h: +message.pos.h || 0 };
      announce(room);
      maybeStart(room);
      break;
    }
    case 'pos': {
      if (!room || !me) return;
      const u = Number(message.u);
      const v = Number(message.v);
      if (Number.isFinite(u) && Number.isFinite(v)) me.pos = { u, v, h: Number(message.h) || 0 };
      break;
    }
    case 'shout': {
      if (!room || !me?.pos) return;
      broadcast(room, { t: 'shout', id: me.id, u: me.pos.u, v: me.pos.v }, me.id);
      break;
    }
    case 'penalty': {
      if (!room || room.phase !== 'running') return;
      const seconds = Math.max(0, Math.min(120, Number(message.seconds) || 0));
      room.penalty += seconds;
      broadcast(room, { t: 'penalty', id: me.id, seconds, total: room.penalty, reason: String(message.reason || '').slice(0, 20) });
      break;
    }
    case 'again': {
      // After the finish the host takes the room back to the lobby for another course.
      if (!room || room.host !== me.id) return;
      room.phase = 'lobby';
      room.setup = null;
      room.split = null;
      for (const p of room.players.values()) { p.ready = false; p.pos = null; }
      announce(room);
      break;
    }
    default: break;
  }
}

// Every tick: share positions, and referee the running rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.touched > ROOM_IDLE_MS) { for (const p of room.players.values()) p.ws.close(); rooms.delete(room.code); continue; }
    if (room.phase !== 'running' && room.phase !== 'briefing') continue;
    const list = [...room.players.values()].filter((p) => p.pos).map((p) => ({ id: p.id, u: p.pos.u, v: p.pos.v, h: p.pos.h }));
    if (list.length) broadcast(room, { t: 'pos', list });
    if (room.phase !== 'running') continue;
    const { points, extent } = room.setup;
    const pos = positions(room);
    const target = points[room.next];
    const leader = room.split.owners[room.next];
    if (groupAt(target, pos, extent).all) {
      room.next++;
      if (room.next >= points.length) {
        room.phase = 'finished';
        const elapsed = (now - room.startAt) / 1000;
        broadcast(room, { t: 'finish', elapsed, penalty: room.penalty, total: elapsed + room.penalty });
        announce(room);
        continue;
      }
      broadcast(room, { t: 'next', next: room.next, leader: room.split.owners[room.next], elapsed: (now - room.startAt) / 1000 });
    } else {
      // Who is waiting for whom at the leader's target, and who has strayed from the leader.
      const lost = strays(leader, pos, extent).map((s) => ({ id: s.id, d: Math.round(s.d) }));
      const key = lost.map((s) => s.id).join(',');
      if (key !== room.strays || (lost.length && now % 2000 < TICK_MS)) {
        room.strays = key;
        broadcast(room, { t: 'strays', leader, list: lost });
      }
    }
  }
}, TICK_MS);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 12 * 1024 * 1024 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message && typeof message.t === 'string') onMessage(ws, message);
  });
  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`Topolab on :${PORT} (site: ${DIST})`));
