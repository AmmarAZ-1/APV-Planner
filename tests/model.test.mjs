import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentsCross, closestOnSegment } from '../src/geometry.js';
import {
  addWall, createFloor, createProject, floorZ, fromModelJSON, rescaleFloor, toModelJSON,
} from '../src/model.js';

test('segmentsCross: proper crossing, miss, and shared corners counted once', () => {
  assert.equal(segmentsCross(0, 0, 2, 0, 1, -1, 1, 1), true);
  assert.equal(segmentsCross(0, 0, 0.5, 0, 1, -1, 1, 1), false);
  // path through the shared corner (1,0) of two chained walls: (1,-1)->(1,0) and (1,0)->(1,1)
  const a = segmentsCross(0, 0, 2, 0, 1, -1, 1, 0);
  const b = segmentsCross(0, 0, 2, 0, 1, 0, 1, 1);
  assert.equal(Number(a) + Number(b), 1);
  // collinear grazing is not a penetration
  assert.equal(segmentsCross(0, 0, 2, 0, 0.5, 0, 1.5, 0), false);
});

test('closestOnSegment clamps to endpoints', () => {
  const c = closestOnSegment(5, 1, 0, 0, 2, 0);
  assert.equal(c.t, 1);
  assert.ok(Math.abs(c.d - Math.hypot(3, 1)) < 1e-12);
});

test('floorZ stacks storey heights', () => {
  const p = createProject();
  p.floors.push(createFloor('F1'), createFloor('F2'));
  p.floors[0].storeyHeight = 3;
  assert.equal(floorZ(p, 0), 0);
  assert.equal(floorZ(p, 1), 3);
  assert.equal(floorZ(p, 2), 5.7);
});

test('rescaleFloor keeps geometry glued to the image', () => {
  const p = createProject();
  const f = p.floors[0];
  addWall(p, f, 1, 2, 3, 4, 'brick');
  p.ont = { floorId: f.id, x: 2, y: 2 };
  rescaleFloor(p, f, 0.5);
  assert.deepEqual([f.walls[0].x1, f.walls[0].y2, p.ont.x], [0.5, 2, 1]);
});

test('model JSON round-trips walls, materials and ONT', () => {
  const p = createProject();
  p.floors.push(createFloor('Upstairs'));
  addWall(p, p.floors[0], 0, 0, 5, 0, 'concrete');
  addWall(p, p.floors[1], 0, 0, 0, 4, 'other', 11);
  p.ont = { floorId: p.floors[1].id, x: 1, y: 1 };
  const json = JSON.parse(JSON.stringify(toModelJSON(p)));
  assert.equal(json.floors[1].zHeight, 2.7);
  assert.deepEqual(json.ont, { floorIndex: 1, x: 1, y: 1, z: 2.7 });
  const { project } = fromModelJSON(json);
  assert.equal(project.floors[0].walls[0].attenuationDb, p.materials.concrete);
  assert.equal(project.floors[1].walls[0].attenuationDb, 11);
  assert.equal(project.ont.floorId, project.floors[1].id);
});
