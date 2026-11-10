import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { outline, sdPolygon } from '../src/hand/outline.js';
import { StrokeEngine, STAMP_FLOATS } from '../src/paint/stroke.js';

const brush = JSON.parse(readFileSync(new URL('../data/tuning.json', import.meta.url), 'utf8')).brush;
const pts = outline('round', 1.03).points;
const make = () => { const e = new StrokeEngine(brush, (x, y) => sdPolygon(pts, x, y)); e.nailLength = 1.03; return e; };
const stamp = (e, i) => Array.from(e.stamps.subarray(i * STAMP_FLOATS, (i + 1) * STAMP_FLOATS));

test('stamps are spaced a quarter radius apart whatever the sample rate', () => {
  const coarse = make(); coarse.begin(0, 0.1, 0); coarse.move(0, 0.9, 800);
  const fine = make(); fine.begin(0, 0.1, 0); for (let i = 1; i <= 80; i++) fine.move(0, 0.1 + 0.01 * i, i * 10);
  assert.equal(coarse.count, fine.count);
  assert.equal(coarse.count, 1 + Math.floor(0.8 / (brush.spacing * brush.radius) + 1e-9));
});

test('a fast stroke lays less polish than a slow one', () => {
  const slow = make(); slow.begin(0, 0.1, 0); slow.move(0, 0.9, 800);
  const fast = make(); fast.begin(0, 0.1, 0); fast.move(0, 0.9, 100);
  assert.ok(Math.abs(stamp(slow, 3)[5] - brush.centreAlpha) < 0.01);
  assert.ok(Math.abs(stamp(fast, 3)[5] - brush.centreAlpha * brush.speedMin) < 0.01);
});

test('the brush drains over five nail lengths but never runs fully dry', () => {
  const e = make(); e.begin(0, 0.1, 0);
  for (let i = 0; i < 12; i++) { e.move(0, i % 2 ? 0.1 : 0.9, (i + 1) * 800); e.reset(); }
  assert.equal(e.load, 0);
  e.move(0, 0.5, 20000);
  assert.ok(Math.abs(stamp(e, 0)[5] - brush.centreAlpha * brush.loadFloor) < 0.01);
  e.dip(); assert.equal(e.load, 1);
});

test('fold wall flag and forgiving start', () => {
  const e = make(); e.begin(0.7, 0.5, 0);                  // well outside: a spill
  assert.equal(stamp(e, 0)[6], 0);
  const s = make(); s.begin(0.55, 0.5, 0);                 // 0.05 outside: snapped inside
  assert.equal(stamp(s, 0)[6], 1);
  assert.ok(sdPolygon(pts, stamp(s, 0)[0], stamp(s, 0)[1]) <= 0);
});

test('tilt: upright is narrower than flat, finger is 1', () => {
  const e = make();
  assert.equal(e.tiltFactor(null), 1);
  assert.ok(Math.abs(e.tiltFactor(80 * Math.PI / 180) - brush.tiltUpright) < 1e-9);
  assert.ok(Math.abs(e.tiltFactor(20 * Math.PI / 180) - brush.tiltFlat) < 1e-9);
});
