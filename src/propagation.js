// Multi-wall-and-floor indoor path loss model (Motley–Keenan / COST 231 multi-wall family).
//
//   PL(d) = PL0 + 10·n·log10(d/d0)
//         + Σ attenuationDb of every wall crossed by the horizontal projection of T→R,
//           taken on each floor over the part of the path that lies inside that floor's storey
//         + floorPenetrationDb × (number of floor slabs between T and R)
//   RSSI  = TxPower − PL(d)
//
// Pure functions only (no DOM), so this runs in the page, in a Web Worker and under node --test.
// All geometry is in building-wide meters: floor-local coordinates minus the floor's origin.

export const BAND_PL0 = { '2.4': 40.0, '5': 46.4, '6': 47.9 }; // free-space loss at 1 m (dB)

export const DEFAULT_PARAMS = {
  txPowerDbm: 20, // AP EIRP (dBm)
  pl0: 40, // reference loss at d0 (dB); 40 dB = free space at 1 m, 2.4 GHz
  d0: 1, // reference distance (m)
  n: 3, // path loss exponent
  floorDb: 15, // loss per floor slab crossed (dB)
  cellSize: 0.5, // grid resolution (m)
  apHeight: 2.0, // AP height above its floor (m)
  rxHeight: 1.0, // client device height above its floor (m)
  thresholdDbm: -67, // coverage threshold
};

/**
 * Flatten a project into typed arrays for fast path-loss evaluation, and lay a grid over it.
 * @returns scene { floors: [{ z0, z1, walls: Float64Array, db: Float64Array, count }], grid }
 */
export function buildScene(project, params = DEFAULT_PARAMS) {
  const floors = [];
  let z = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of project.floors) {
    const n = f.walls.length;
    const walls = new Float64Array(n * 4);
    const db = new Float64Array(n);
    f.walls.forEach((w, i) => {
      const x1 = w.x1 - f.origin.x, y1 = w.y1 - f.origin.y, x2 = w.x2 - f.origin.x, y2 = w.y2 - f.origin.y;
      walls.set([x1, y1, x2, y2], i * 4);
      db[i] = w.attenuationDb;
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
    });
    floors.push({ id: f.id, label: f.label, z0: z, z1: z + f.storeyHeight, walls, db, count: n, origin: { ...f.origin } });
    z += f.storeyHeight;
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 10; maxY = 10; }
  const cell = params.cellSize;
  // one-cell margin so the flood fill can walk around the outside of the building
  const x0 = Math.floor(minX / cell) * cell - cell;
  const y0 = Math.floor(minY / cell) * cell - cell;
  const nx = Math.ceil((maxX - x0) / cell) + 1;
  const ny = Math.ceil((maxY - y0) / cell) + 1;
  const grid = { x0, y0, nx, ny, cell, floors: floors.map((fl) => interiorMask(fl, x0, y0, nx, ny, cell)) };
  return { floors, grid };
}

/** Cell-center coordinate helpers. */
export const cellX = (grid, i) => grid.x0 + (i + 0.5) * grid.cell;
export const cellY = (grid, j) => grid.y0 + (j + 0.5) * grid.cell;

/**
 * Which grid cells are inside the building on this floor: flood-fill from the grid border,
 * never stepping across a wall; everything not reached is indoors. If the exterior wall has a
 * gap the fill leaks inside; then fall back to the walls' bounding box and flag it.
 */
function interiorMask(fl, x0, y0, nx, ny, cell) {
  const inside = new Uint8Array(nx * ny);
  if (!fl.count) return { inside, insideCount: 0, leaky: false, empty: true };
  const outside = new Uint8Array(nx * ny);
  const stack = [];
  for (let i = 0; i < nx; i++) { stack.push(i, 0, i, ny - 1); }
  for (let j = 0; j < ny; j++) { stack.push(0, j, nx - 1, j); }
  for (let k = 0; k < stack.length; k += 2) outside[stack[k + 1] * nx + stack[k]] = 1;
  const W = fl.walls;
  const blocked = (ax, ay, bx, by) => {
    for (let w = 0; w < fl.count; w++) {
      if (crosses(ax, ay, bx, by, W[w * 4], W[w * 4 + 1], W[w * 4 + 2], W[w * 4 + 3])) return true;
    }
    return false;
  };
  while (stack.length) {
    const j = stack.pop(), i = stack.pop();
    const ax = x0 + (i + 0.5) * cell, ay = y0 + (j + 0.5) * cell;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || outside[nj * nx + ni]) continue;
      if (blocked(ax, ay, ax + di * cell, ay + dj * cell)) continue;
      outside[nj * nx + ni] = 1;
      stack.push(ni, nj);
    }
  }
  let insideCount = 0;
  for (let k = 0; k < inside.length; k++) if (!outside[k]) { inside[k] = 1; insideCount++; }
  let leaky = false;
  if (insideCount === 0) {
    // exterior not closed: treat the bounding box of this floor's walls as indoors
    leaky = true;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let w = 0; w < fl.count; w++) {
      a = Math.min(a, W[w * 4], W[w * 4 + 2]); c = Math.max(c, W[w * 4], W[w * 4 + 2]);
      b = Math.min(b, W[w * 4 + 1], W[w * 4 + 3]); d = Math.max(d, W[w * 4 + 1], W[w * 4 + 3]);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell;
      if (x >= a && x <= c && y >= b && y <= d) { inside[j * nx + i] = 1; insideCount++; }
    }
  }
  return { inside, insideCount, leaky, empty: false };
}

/** Segment P→Q crosses wall A→B (open in t along the path, half-open [0,1) along the wall). */
function crosses(px, py, qx, qy, ax, ay, bx, by) {
  const rx = qx - px, ry = qy - py, sx = bx - ax, sy = by - ay;
  const den = rx * sy - ry * sx;
  if (den > -1e-12 && den < 1e-12) return false;
  const wx = ax - px, wy = ay - py;
  const t = (wx * sy - wy * sx) / den;
  if (t <= 1e-9 || t >= 1 - 1e-9) return false;
  const u = (wx * ry - wy * rx) / den;
  return u >= 0 && u < 1;
}

/** Sum of wall losses crossed by the 2D segment P→Q on one floor. */
function wallLossOnFloor(fl, px, py, qx, qy) {
  const W = fl.walls, D = fl.db;
  const minX = Math.min(px, qx), maxX = Math.max(px, qx), minY = Math.min(py, qy), maxY = Math.max(py, qy);
  let loss = 0;
  for (let w = 0; w < fl.count; w++) {
    const o = w * 4;
    const ax = W[o], ay = W[o + 1], bx = W[o + 2], by = W[o + 3];
    // cheap bounding-box rejection before the exact test
    if ((ax < minX && bx < minX) || (ax > maxX && bx > maxX) || (ay < minY && by < minY) || (ay > maxY && by > maxY)) continue;
    if (crosses(px, py, qx, qy, ax, ay, bx, by)) loss += D[w];
  }
  return loss;
}

/**
 * Path loss (dB) between T and R. Points: { x, y, z, f } with f = floor index, z absolute height.
 * Returns { total, distance, walls, floors } when `detail` is set, else just the total.
 */
export function pathLoss(scene, params, T, R, detail = false) {
  const dx = R.x - T.x, dy = R.y - T.y, dz = R.z - T.z;
  const d = Math.max(params.d0, Math.sqrt(dx * dx + dy * dy + dz * dz));
  const distLoss = params.pl0 + 10 * params.n * Math.log10(d / params.d0);
  let walls = 0;
  if (T.f === R.f) {
    walls = wallLossOnFloor(scene.floors[T.f], T.x, T.y, R.x, R.y);
  } else {
    // walk the floors between T and R, clipping the 3D path to each storey's z-range
    const lo = Math.min(T.f, R.f), hi = Math.max(T.f, R.f);
    for (let k = lo; k <= hi; k++) {
      const fl = scene.floors[k];
      let ta = (fl.z0 - T.z) / dz, tb = (fl.z1 - T.z) / dz;
      if (ta > tb) [ta, tb] = [tb, ta];
      ta = Math.max(0, ta); tb = Math.min(1, tb);
      if (tb <= ta) continue;
      walls += wallLossOnFloor(fl, T.x + dx * ta, T.y + dy * ta, T.x + dx * tb, T.y + dy * tb);
    }
  }
  const floors = Math.abs(R.f - T.f) * params.floorDb;
  const total = distLoss + walls + floors;
  return detail ? { total, distance: d, distLoss, walls, floors } : total;
}

export function rssi(scene, params, T, R) {
  return params.txPowerDbm - pathLoss(scene, params, T, R);
}

/** Transmitter point for an AP stored as { floorIndex, x, y } in building-wide meters. */
export function apPoint(scene, params, ap) {
  return { x: ap.x, y: ap.y, z: scene.floors[ap.floorIndex].z0 + params.apHeight, f: ap.floorIndex };
}

/**
 * Best-server RSSI for every grid cell on every floor.
 * @param aps [{ floorIndex, x, y }] building-wide meters
 * @returns Float32Array[] one per floor, length nx*ny (−Infinity where no AP)
 */
export function computeCoverage(scene, params, aps) {
  const { grid } = scene;
  const tx = aps.map((ap) => apPoint(scene, params, ap));
  return scene.floors.map((fl, f) => {
    const out = new Float32Array(grid.nx * grid.ny).fill(-Infinity);
    const R = { x: 0, y: 0, z: fl.z0 + params.rxHeight, f };
    for (let j = 0; j < grid.ny; j++) {
      R.y = cellY(grid, j);
      for (let i = 0; i < grid.nx; i++) {
        R.x = cellX(grid, i);
        let best = -Infinity;
        for (const T of tx) {
          const v = params.txPowerDbm - pathLoss(scene, params, T, R);
          if (v > best) best = v;
        }
        out[j * grid.nx + i] = best;
      }
    }
    return out;
  });
}

/** Coverage statistics over indoor cells. */
export function coverageStats(scene, maps, threshold) {
  const { grid } = scene;
  const cellArea = grid.cell * grid.cell;
  const perFloor = scene.floors.map((fl, f) => {
    const mask = grid.floors[f];
    let n = 0, ok = 0;
    for (let k = 0; k < mask.inside.length; k++) {
      if (!mask.inside[k]) continue;
      n++;
      if (maps[f][k] >= threshold) ok++;
    }
    return { cells: n, covered: ok, area: n * cellArea, coveredArea: ok * cellArea, fraction: n ? ok / n : 0 };
  });
  const cells = perFloor.reduce((s, p) => s + p.cells, 0);
  const covered = perFloor.reduce((s, p) => s + p.covered, 0);
  return { perFloor, area: cells * cellArea, coveredArea: covered * cellArea, fraction: cells ? covered / cells : 0 };
}
