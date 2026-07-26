import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COURSES, NTP_HOLES, courseForDay } = require('../courses.js');

const DAYS = [1, 2, 3];

test('COURSES has exactly the three tournament days, each with 18 holes', () => {
  assert.deepEqual(Object.keys(COURSES).map(Number).sort(), DAYS);
  DAYS.forEach(day => assert.equal(COURSES[day].holes.length, 18));
});

test('each course\'s stroke index column is a permutation of 1-18', () => {
  DAYS.forEach(day => {
    const sis = COURSES[day].holes.map(h => h.si).sort((a, b) => a - b);
    assert.deepEqual(sis, Array.from({ length: 18 }, (_, i) => i + 1));
  });
});

// Cross-checks the transcription against the card's own printed OUT/IN/TOT
// figures -- catches a mis-keyed row without relying on the same numbers
// twice (issue #122 implementation plan).
test('front/back nine par and distance sums match the card\'s printed OUT/IN totals', () => {
  DAYS.forEach(day => {
    const c = COURSES[day];
    const out = c.holes.slice(0, 9), inn = c.holes.slice(9, 18);
    const sum = (arr, key) => arr.reduce((s, h) => s + h[key], 0);
    assert.equal(sum(out, 'par'), c.out.par, `${c.name} OUT par`);
    assert.equal(sum(out, 'dist'), c.out.dist, `${c.name} OUT dist`);
    assert.equal(sum(inn, 'par'), c.in.par, `${c.name} IN par`);
    assert.equal(sum(inn, 'dist'), c.in.dist, `${c.name} IN dist`);
  });
});

test('printed TOTAL equals OUT + IN for every course', () => {
  DAYS.forEach(day => {
    const c = COURSES[day];
    assert.equal(c.out.par + c.in.par, c.total.par);
    assert.equal(c.out.dist + c.in.dist, c.total.dist);
  });
});

test('every course totals to par 72 over 18 holes (per the source cards)', () => {
  DAYS.forEach(day => assert.equal(COURSES[day].total.par, 72));
});

test('NTP_HOLES entries are valid hole numbers (1-18) and land on par 3s', () => {
  DAYS.forEach(day => {
    const holes = NTP_HOLES[day];
    assert.equal(holes.length, 2);
    holes.forEach(h => {
      assert.ok(h >= 1 && h <= 18);
      assert.equal(COURSES[day].holes[h - 1].par, 3, `day ${day} NTP hole ${h} should be a par 3`);
    });
  });
});

test('hole numbers within each course run 1-18 in order', () => {
  DAYS.forEach(day => {
    assert.deepEqual(COURSES[day].holes.map(h => h.hole), Array.from({ length: 18 }, (_, i) => i + 1));
  });
});

test('courseForDay returns the matching course, and null for an unknown day', () => {
  assert.equal(courseForDay(1).name, 'Murray');
  assert.equal(courseForDay(2).name, 'Black Bull');
  assert.equal(courseForDay(3).name, 'Lake');
  assert.equal(courseForDay(4), null);
});
