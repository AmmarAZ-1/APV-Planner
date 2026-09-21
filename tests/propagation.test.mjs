import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene, computeCoverage, coverageStats, DEFAULT_PARAMS, pathLoss } from '../src/propagation.js';
import { addWall, createFloor, createProject } from '../src/model.js';

const P = { ...DEFAULT_PARAMS };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** 10 m × 8 m box with one interior drywall at x = 5, stacked `floors` high. */
function house(floors = 1) {
  const p = createProject();
  p.floors = [];
  for (let k = 0; k < floors; k++) {
    const f = createFloor(`F${k}`);
    for (const [a, b, c, d] of [[0, 0, 10, 0], [10, 0, 10, 8], [10, 8, 0, 8], [0, 8, 0, 0]]) addWall(p, f, a, b, c, d, 'brick');
    addWall(p, f, 5, 0, 5, 8, 'drywall');
    p.floors.push(f);
  }
  return p;
}

test('log-distance term: PL0 at d0, +10n dB per decade', () => {
  const s = buildScene(house(), P);
  near(pathLoss(s, P, { x: 1, y: 1, z: 1, f: 0 }, { x: 2, y: 1, z: 1, f: 0 }), 40);
  near(pathLoss(s, P, { x: 1, y: 1, z: 1, f: 0 }, { x: 1, y: 1, z: 1, f: 0 }), 40); // clamped to d0
  near(pathLoss(s, P, { x: 1, y: 1, z: 1, f: 0 }, { x: 1, y: 11, z: 1, f: 0 }) - 0, 40 + 30 + 8); // crosses brick at y=8
});

test('wall term: crossing the drywall adds exactly its attenuation', () => {
  const s = buildScene(house(), P);
  const a = pathLoss(s, P, { x: 1, y: 4, z: 1, f: 0 }, { x: 4, y: 4, z: 1, f: 0 }, true);
  const b = pathLoss(s, P, { x: 1, y: 4, z: 1, f: 0 }, { x: 7, y: 4, z: 1, f: 0 }, true);
  near(a.walls, 0);
  near(b.walls, 3.5);
});

test('floor term: one slab per floor crossed; walls counted on the floors the path passes through', () => {
  const p = house(3);
  const s = buildScene(p, P);
  const T = { x: 2, y: 4, z: 2, f: 0 };
  const up1 = pathLoss(s, P, T, { x: 2, y: 4, z: 2.7 + 1, f: 1 }, true);
  const up2 = pathLoss(s, P, T, { x: 2, y: 4, z: 5.4 + 1, f: 2 }, true);
  near(up1.floors, 15);
  near(up2.floors, 30);
  near(up1.walls, 0);
  // diagonal path to the other side of the drywall one floor up crosses x = 5 in some storey
  const diag = pathLoss(s, P, T, { x: 8, y: 4, z: 3.7, f: 1 }, true);
  near(diag.walls, 3.5);
});

test('coverage: same floor > adjacent floor > distant floor', () => {
  const p = house(3);
  const s = buildScene(p, P);
  const maps = computeCoverage(s, P, [{ floorIndex: 0, x: 2.5, y: 4 }]);
  const avg = (m, f) => {
    const inside = s.grid.floors[f].inside;
    let sum = 0, n = 0;
    for (let k = 0; k < m.length; k++) if (inside[k]) { sum += m[k]; n++; }
    return sum / n;
  };
  const [a0, a1, a2] = [0, 1, 2].map((f) => avg(maps[f], f));
  assert.ok(a0 > a1 && a1 > a2, `${a0} > ${a1} > ${a2}`);
  assert.ok(a0 - a1 > 12, 'first slab costs roughly its 15 dB');
});

test('interior mask: flood fill finds the indoor area of a closed plan', () => {
  const s = buildScene(house(), P);
  const st = coverageStats(s, computeCoverage(s, P, [{ floorIndex: 0, x: 5, y: 4 }]), -200);
  near(st.area, 80, 1e-6); // 10 × 8 m at 0.5 m cells, all indoor cells covered at −200 dBm
  assert.equal(st.fraction, 1);
});
