import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { nailLayers } from '../src/paint/layers.js';
const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const designs = JSON.parse(readFileSync(new URL('../data/designs.json', import.meta.url), 'utf8')).designs;

test('a plain polish is solid on every nail', () => {
  for (let f = 0; f < 5; f++) {
    const L = nailLayers({ polish: 'cream-red' }, f, catalog);
    assert.equal(L.base.id, 'cream-red'); assert.equal(L.mode, 'solid'); assert.equal(L.over, null);
    assert.equal(L.base.finishData.id, 1);
  }
});

test('the accent nail gets its own polish and no french tip', () => {
  const d = { polish: 'cream-lilac', accent: { finger: 3, polish: 'glitter-gold' }, art: [{ kind: 'french', polish: 'cream-white' }] };
  assert.equal(nailLayers(d, 3, catalog).base.id, 'glitter-gold');
  assert.equal(nailLayers(d, 3, catalog).mode, 'solid');
  assert.equal(nailLayers(d, 2, catalog).base.id, 'cream-lilac');
  assert.equal(nailLayers(d, 2, catalog).mode, 'french');
});

test('objects go to the record, polish art becomes a layer', () => {
  const L = nailLayers({ polish: 'cream-pink', art: [{ kind: 'ombre', polish: 'cream-lilac' }, { kind: 'gems', count: 2 }] }, 0, catalog);
  assert.equal(L.mode, 'ombre'); assert.equal(L.over.id, 'cream-lilac');
  assert.deepEqual(L.objects, [{ kind: 'gems', count: 2 }]);
});

test('bare, top coat, and bad input', () => {
  assert.equal(nailLayers({ polish: null }, 0, catalog).base, null);
  assert.equal(nailLayers({ polish: 'cream-black', topCoat: 'matte' }, 0, catalog).topCoat, 'matte');
  assert.throws(() => nailLayers({ polish: 'nope' }, 0, catalog), /unknown polish/);
  assert.throws(() => nailLayers({ polish: 'cream-red', art: [{ kind: 'french', polish: 'cream-white' }, { kind: 'ombre', polish: 'cream-pink' }] }, 0, catalog), /not both/);
});

test('every test design resolves', () => {
  for (const [id, d] of Object.entries(designs)) for (let f = 0; f < 5; f++) assert.doesNotThrow(() => nailLayers(d, f, catalog), id);
});
