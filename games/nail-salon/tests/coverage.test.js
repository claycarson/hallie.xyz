import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outline } from '../src/hand/outline.js';
import { TouchGrid } from '../src/paint/coverage.js';

const stampsAlong = (x, y0, y1, r, step = 0.03) => {
  const a = [];
  for (let y = y0; y <= y1; y += step) a.push(x, y, 0, 1, r, 0.5, 0, 0);
  return { s: Float32Array.from(a), n: a.length / 8 };
};

test('the grid holds only points inside the outline', () => {
  const o = outline('round', 1.4), g = new TouchGrid(40).setOutline(o.points, o.length);
  assert.ok(g.xs.length > 1000);
  assert.equal(g.share, 0);
});

test('one wide stroke down the middle touches more than half, a short one does not', () => {
  const o = outline('round', 1.4);
  const g = new TouchGrid(40).setOutline(o.points, o.length);
  const short = stampsAlong(0, 0.2, 0.5, 0.3);
  g.mark(short.s, short.n, 8);
  assert.ok(g.share > 0.05 && g.share < 0.5, `short stroke ${g.share}`);
  g.reset();
  const long = stampsAlong(0, 0.0, 1.4, 0.3);
  g.mark(long.s, long.n, 8);
  assert.ok(g.share > 0.5 && g.share < 0.9, `wide stroke ${g.share}`);
});

test('marking twice counts once', () => {
  const o = outline('square', 1.2), g = new TouchGrid(30).setOutline(o.points, o.length);
  const st = stampsAlong(0.2, 0.1, 1.0, 0.25);
  g.mark(st.s, st.n, 8); const once = g.share;
  g.mark(st.s, st.n, 8);
  assert.equal(g.share, once);
});
