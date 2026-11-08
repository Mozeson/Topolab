import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAM, blockCount, splitCourse, visibleIndices, groupAt, strays, roomCode } from '../src/team.js';

const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('block counts: everyone leads when possible, never more than two targets each', () => {
  assert.equal(blockCount(6, 3), 3);
  assert.equal(blockCount(3, 4), 3);   // a fourth player only follows
  assert.equal(blockCount(8, 4), 4);
  assert.equal(blockCount(9, 4), -1);  // too long for the team
  assert.equal(blockCount(5, 1), -1);
  assert.equal(blockCount(2, 1), 1);
});

test('the split is contiguous, 1–2 targets per block, one block per player, all covered', () => {
  for (let seed = 1; seed < 200; seed++) {
    const players = ['a', 'b', 'c', 'd'].slice(0, 1 + (seed % 4));
    const targets = 1 + (seed % (players.length * 2));
    const split = splitCourse(targets, players, seeded(seed));
    assert.ok(split, `${targets}/${players.length}`);
    assert.equal(split.owners.length, targets + 1);
    let at = 1;
    const seen = new Set();
    for (const b of split.blocks) {
      assert.equal(b.from, at);
      assert.ok(b.to - b.from + 1 >= 1 && b.to - b.from + 1 <= TEAM.maxPerPlayer);
      assert.ok(!seen.has(b.player), 'one block each');
      seen.add(b.player);
      for (let i = b.from; i <= b.to; i++) assert.equal(split.owners[i], b.player);
      at = b.to + 1;
    }
    assert.equal(at, targets + 1);
  }
  assert.equal(splitCourse(9, ['a', 'b', 'c', 'd']), null);
});

test('each player sees where their stretch starts and their own targets', () => {
  const split = { owners: [null, 'a', 'a', 'b', 'c', 'c'], blocks: [{ player: 'a', from: 1, to: 2 }, { player: 'b', from: 3, to: 3 }, { player: 'c', from: 4, to: 5 }] };
  assert.deepEqual(visibleIndices(split, 'a'), [0, 1, 2]);
  assert.deepEqual(visibleIndices(split, 'b'), [2, 3]);
  assert.deepEqual(visibleIndices(split, 'c'), [3, 4, 5]);
  assert.deepEqual(visibleIndices(split, 'd'), []);
});

test('the group counts at a control only together; strays are named', () => {
  const extent = 4000;
  const point = { u: .5, v: .5 };
  const near = (m) => ({ u: .5 + m / extent, v: .5 });
  const positions = new Map([['a', near(5)], ['b', near(30)], ['c', near(90)]]);
  const at = groupAt(point, positions, extent);
  assert.equal(at.all, false);
  assert.deepEqual(at.missing.map((m) => m.id), ['c']);
  positions.set('c', near(10));
  assert.equal(groupAt(point, positions, extent).all, true);
  positions.set('b', null);
  assert.equal(groupAt(point, positions, extent).all, false);
  const s = strays('a', new Map([['a', near(0)], ['b', near(100)], ['c', near(400)]]), extent);
  assert.deepEqual(s.map((x) => x.id), ['c']);
  assert.match(roomCode(seeded(3)), /^\d{4}$/);
});
