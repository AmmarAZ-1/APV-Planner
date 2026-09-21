// Synthetic buildings for tests: a small apartment and a large three-storey house.
import { addWall, createFloor, createProject } from '../src/model.js';

function box(p, f, x0, y0, x1, y1, mat) {
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  for (let i = 0; i < 4; i++) addWall(p, f, ...pts[i], ...pts[i + 1], mat);
}

/** Room grid: exterior brick box split into cols × rows rooms by drywall, 0.9 m doors in every interior wall. */
function roomGrid(p, f, W, H, cols, rows, ext = 'brick', inner = 'drywall') {
  box(p, f, 0, 0, W, H, ext);
  for (let c = 1; c < cols; c++) {
    const x = (W * c) / cols;
    for (let r = 0; r < rows; r++) {
      const y0 = (H * r) / rows, y1 = (H * (r + 1)) / rows, ym = (y0 + y1) / 2;
      addWall(p, f, x, y0, x, ym - 0.45, inner);
      addWall(p, f, x, ym - 0.45, x, ym + 0.45, 'wood_door');
      addWall(p, f, x, ym + 0.45, x, y1, inner);
    }
  }
  for (let r = 1; r < rows; r++) {
    const y = (H * r) / rows;
    for (let c = 0; c < cols; c++) {
      const x0 = (W * c) / cols, x1 = (W * (c + 1)) / cols, xm = (x0 + x1) / 2;
      addWall(p, f, x0, y, xm - 0.45, y, inner);
      addWall(p, f, xm - 0.45, y, xm + 0.45, y, 'wood_door');
      addWall(p, f, xm + 0.45, y, x1, y, inner);
    }
  }
}

/** ~55 m² one-floor apartment: 8 × 7 m, four rooms. */
export function apartment() {
  const p = createProject();
  p.floors = [createFloor('Apartment')];
  roomGrid(p, p.floors[0], 8, 7, 2, 2, 'concrete');
  return p;
}

/** ~720 m² three-storey house: 20 × 12 m per floor, 4 × 3 rooms, concrete slabs. */
export function largeHouse() {
  const p = createProject();
  p.floors = ['Ground', 'First', 'Second'].map((l) => createFloor(l));
  for (const f of p.floors) roomGrid(p, f, 20, 12, 4, 3);
  return p;
}

/** The 2-storey sample house used in the app (12 × 9 m per floor). */
export async function sampleProject() {
  const { sampleHouse } = await import('../src/sample.js');
  const s = sampleHouse();
  const p = createProject();
  p.floors = s.floors.map((sf) => {
    const f = createFloor(sf.label);
    for (const [x1, y1, x2, y2, m] of sf.walls) addWall(p, f, x1, y1, x2, y2, m);
    return f;
  });
  return p;
}
