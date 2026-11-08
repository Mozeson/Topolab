import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 2000);

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    inbox.push(m);
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (t, pred = () => true, ms = 4000) => new Promise((resolve, reject) => {
      const found = inbox.find((m) => m.t === t && pred(m));
      if (found) { inbox.splice(inbox.indexOf(found), 1); resolve(found); return; }
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms);
      waiters.push({ match: (m) => m.t === t && pred(m), resolve: (m) => { clearTimeout(timer); inbox.splice(inbox.indexOf(m), 1); resolve(m); } });
    }),
  };
}

test('a team room: create, join by code, split, leader, group arrival, finish', async (t) => {
  const server = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, PORT: String(PORT), DIST: 'dist' }, stdio: 'pipe' });
  t.after(() => server.kill());
  await new Promise((r) => server.stdout.once('data', r));

  const host = client();
  const guest = client();
  await Promise.all([host.open(), guest.open()]);
  host.send({ t: 'create', name: 'דנה' });
  const joined = await host.wait('joined');
  const code = joined.room.code;
  assert.match(code, /^\d{4}$/);

  guest.send({ t: 'join', code: '0000', name: 'x' });
  assert.equal((await guest.wait('error')).code, 'no-room');
  guest.send({ t: 'join', code, name: 'יוסי' });
  const g = await guest.wait('joined');
  assert.equal(g.room.players.length, 2);

  // Start, two controls and the finish: 3 targets for 2 players.
  const points = [{ u: .2, v: .2, kind: 'start' }, { u: .3, v: .2, kind: 'control', number: 1 }, { u: .4, v: .2, kind: 'control', number: 2 }, { u: .5, v: .2, kind: 'finish' }];
  host.send({ t: 'setup', project: '{"x":1}', points, extent: 4000, options: { mapMode: 'mine' } });
  const setupH = await host.wait('setup');
  const setupG = await guest.wait('setup');
  assert.equal(setupG.project, '{"x":1}');
  assert.deepEqual(setupH.split, setupG.split);
  assert.equal(setupG.split.owners.length, 4);
  assert.equal(new Set(setupG.split.blocks.map((b) => b.player)).size, 2);

  // Nobody starts until everyone is ready.
  const at = (p, dx = 0) => ({ u: p.u + dx / 4000, v: p.v });
  host.send({ t: 'ready', pos: at(points[0]) });
  await assert.rejects(host.wait('start', () => true, 400));
  guest.send({ t: 'ready', pos: at(points[0], 3) });
  const start = await host.wait('start');
  assert.equal(start.leader, setupH.split.owners[1]);

  // Only the leader at control 1: no advance. Then both: the lead passes on.
  host.send({ t: 'pos', ...at(points[1]) });
  guest.send({ t: 'pos', ...at(points[0]) });
  await assert.rejects(host.wait('next', () => true, 500));
  guest.send({ t: 'pos', ...at(points[1], 20) });
  const next = await host.wait('next');
  assert.equal(next.next, 2);
  assert.equal(next.leader, setupH.split.owners[2]);

  // A stray is reported, then the group finishes together.
  guest.send({ t: 'pos', ...at(points[1], -900) });
  host.send({ t: 'pos', ...at(points[2]) });
  const strays = await host.wait('strays', (m) => m.list.length > 0);
  assert.ok(strays.list[0].d > 150);
  guest.send({ t: 'shout' });
  assert.equal((await host.wait('shout')).id, g.you);
  guest.send({ t: 'penalty', seconds: 20, reason: 'camel' });
  assert.equal((await host.wait('penalty')).total, 20);
  guest.send({ t: 'pos', ...at(points[2]) });
  await host.wait('next', (m) => m.next === 3);
  host.send({ t: 'pos', ...at(points[3]) });
  guest.send({ t: 'pos', ...at(points[3], 5) });
  const finish = await guest.wait('finish');
  assert.equal(finish.penalty, 20);
  assert.ok(finish.total >= 20);

  // A full room refuses a fifth player; a started room refuses newcomers.
  const late = client();
  await late.open();
  late.send({ t: 'join', code, name: 'late' });
  assert.equal((await late.wait('error')).code, 'started');
  for (const c of [host, guest, late]) c.ws.close();
});
