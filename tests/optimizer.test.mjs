import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greedyPlacement } from '../src/optimizer.js';
import { buildScene, DEFAULT_PARAMS } from '../src/propagation.js';
import { apartment, largeHouse, sampleProject } from './fixtures.mjs';

const P = { ...DEFAULT_PARAMS };

function run(project, opts = {}, params = P) {
  return greedyPlacement(buildScene(project, params), params, opts);
}

test('apartment: one AP is enough', () => {
  const r = run(apartment());
  assert.equal(r.aps.length, 1);
  assert.ok(r.fraction >= 0.95);
});

test('large 3-storey house: several APs, diminishing marginal gains', () => {
  const r = run(largeHouse(), {}, { ...P, pl0: 46.4 }); // 5 GHz
  const gains = r.steps.filter((s) => !s.rejected).map((s) => s.gainPct);
  console.log('large house 5 GHz:', r.aps.length, 'APs', gains.map((g) => g.toFixed(1)).join(' / '), '→', (r.fraction * 100).toFixed(1) + '%', '|', r.stopReason);
  assert.ok(r.aps.length >= 3, `got ${r.aps.length}`);
  for (let i = 1; i < gains.length; i++) assert.ok(gains[i] <= gains[i - 1] + 1e-9, 'gains must not increase (submodularity)');
  const floorsUsed = new Set(r.aps.map((a) => a.floorIndex));
  assert.ok(floorsUsed.size >= 2, 'APs spread over floors');
});

test('large house at 2.4 GHz: greedy revises the area estimate upward', () => {
  const r = run(largeHouse());
  console.log('large house 2.4 GHz:', r.aps.length, 'APs', r.steps.map((s) => (s.rejected ? 'x' : '') + s.gainPct.toFixed(1)).join(' / '), '|', r.stopReason);
  assert.ok(r.aps.length >= 2);
});

test('fixed count places exactly N', () => {
  const r = run(largeHouse(), { fixedCount: 4 });
  assert.equal(r.aps.length, 4);
});

test('mesh mode: every AP after the first has a link ≥ the minimum', () => {
  const r = run(largeHouse(), { backhaul: 'mesh', meshMinDbm: -65 }, { ...P, pl0: 46.4 });
  for (const s of r.steps.filter((x) => !x.rejected && x.apNumber > 1)) assert.ok(s.linkDbm >= -65, `link ${s.linkDbm}`);
});

test('mesh mode flags an AP that cannot be placed', () => {
  // impossible link budget: nothing can hear AP1 at −10 dBm
  const r = run(largeHouse(), { backhaul: 'mesh', meshMinDbm: -10 }, { ...P, pl0: 46.4 });
  assert.equal(r.aps.length, 1);
  assert.ok(r.flagged && r.flagged.apNumber === 2);
});

test('root at ONT pins AP1 to the ONT position', async () => {
  const p = await sampleProject();
  const ont = { floorIndex: 0, x: 12.3, y: 9.3 };
  const r = run(p, { rootAtOnt: true, ont, backhaul: 'mesh' });
  assert.deepEqual([r.aps[0].floorIndex, r.aps[0].x, r.aps[0].y], [0, 12.3, 9.3]);
});
