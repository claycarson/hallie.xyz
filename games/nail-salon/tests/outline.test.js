import test from 'node:test';
import assert from 'node:assert/strict';
import { outline, blend, sdPolygon, area, SHAPES, N_POINTS } from '../src/hand/outline.js';

test('every shape gives 96 distinct points, counter-clockwise, at several lengths', () => {
  for (const shape of SHAPES) for (const L of [0.95, 1.03, 1.4, 1.88]) {
    const o = outline(shape, L);
    assert.equal(o.points.length, N_POINTS * 2);
    assert.ok(area(o.points) > 0.3, `${shape} ${L} area ${area(o.points)}`);
    for (let i = 0; i < N_POINTS; i++) {
      const j = (i + 1) % N_POINTS;
      const d = Math.hypot(o.points[2 * i] - o.points[2 * j], o.points[2 * i + 1] - o.points[2 * j + 1]);
      assert.ok(d > 1e-5, `${shape} ${L}: points ${i} and ${j} coincide`);
    }
    let top = -1; for (let i = 0; i < N_POINTS; i++) top = Math.max(top, o.points[2 * i + 1]);
    assert.ok(Math.abs(top - L) < 1e-6, `${shape} tip reaches the length`);
  }
});

test('signed distance: negative inside, positive outside, zero on the cuticle', () => {
  const o = outline('round', 1.03).points;
  assert.ok(sdPolygon(o, 0, 0.5) < -0.4);
  assert.ok(Math.abs(sdPolygon(o, 0.7, 0.5) - 0.2) < 0.02);
  assert.ok(Math.abs(sdPolygon(o, 0, 0)) < 1e-6);
  assert.ok(sdPolygon(o, 0, -0.1) > 0.09);
});

test('blending two shapes stays a valid outline', () => {
  const a = outline('round', 1.2).points, b = outline('square', 1.2).points, m = blend(a, b, 0.5);
  assert.ok(area(m) > Math.min(area(a), area(b)) - 1e-6 && area(m) < Math.max(area(a), area(b)) + 1e-6);
  assert.deepEqual(Array.from(blend(a, b, 0)), Array.from(a));
});
