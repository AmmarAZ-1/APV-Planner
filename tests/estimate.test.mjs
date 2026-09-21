import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateApCount } from '../src/estimate.js';
import { buildScene, DEFAULT_PARAMS } from '../src/propagation.js';
import { apartment, largeHouse, sampleProject } from './fixtures.mjs';

const P = { ...DEFAULT_PARAMS };
const run = (p) => estimateApCount(buildScene(p, P), P, 0.95);

test('estimate: small apartment needs 1 AP', () => {
  const e = run(apartment());
  assert.ok(Math.abs(e.totalArea - 56) < 1, `area ${e.totalArea}`);
  assert.equal(e.estimate, 1);
});

test('estimate: large 3-storey house needs several APs', () => {
  const e = run(largeHouse());
  assert.ok(Math.abs(e.totalArea - 720) < 1, `area ${e.totalArea}`);
  // the area ratio assumes zero overlap, so it's a lower bound that stage 4 revises upward
  assert.ok(e.estimate >= 2 && e.estimate <= 8, `estimate ${e.estimate}`);
  const e5 = estimateApCount(buildScene(largeHouse(), { ...P, pl0: 46.4 }), { ...P, pl0: 46.4 }, 0.95);
  assert.ok(e5.estimate > e.estimate, '5 GHz needs more APs than 2.4 GHz');
  // best probe for a 3-storey building should sit on the middle floor
  assert.equal(e.best.floorIndex, 1);
});

test('estimate: sample 2-storey house', async () => {
  const e = run(await sampleProject());
  assert.ok(e.estimate >= 1 && e.estimate <= 3);
});
