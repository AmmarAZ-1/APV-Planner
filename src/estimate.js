// Stage 3: first-cut AP count from the house's area and how far one AP actually reaches in it.
//
//   estimate = ceil(targetFraction × totalArea / maxSingleApCoverageArea)
//
// maxSingleApCoverageArea is measured with the full propagation model at a handful of strong
// candidate positions (each floor's indoor centroid plus its four quadrant centroids), so it
// already reflects this house's wall density and slab losses, not a free-space radius.

import { cellX, cellY, computeCoverage, coverageStats } from './propagation.js';

/** Strong candidate AP positions: per floor, the indoor centroid and the centroids of its 4 quadrants. */
export function probePositions(scene) {
  const { grid } = scene;
  const out = [];
  scene.floors.forEach((fl, f) => {
    const inside = grid.floors[f].inside;
    const pts = [];
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      if (inside[j * grid.nx + i]) pts.push([cellX(grid, i), cellY(grid, j)]);
    }
    if (!pts.length) return;
    const centroid = (arr) => arr.reduce((a, p) => [a[0] + p[0] / arr.length, a[1] + p[1] / arr.length], [0, 0]);
    const [cx, cy] = centroid(pts);
    out.push({ floorIndex: f, x: cx, y: cy, kind: 'centroid' });
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const q = pts.filter(([x, y]) => (x - cx) * sx >= 0 && (y - cy) * sy >= 0);
      if (q.length) {
        const [qx, qy] = centroid(q);
        out.push({ floorIndex: f, x: qx, y: qy, kind: 'quadrant' });
      }
    }
  });
  // snap each probe to the nearest indoor cell centre (an L-shaped floor's centroid can be outdoors)
  return out.map((p) => snapIndoors(scene, p));
}

function snapIndoors(scene, p) {
  const { grid } = scene;
  const inside = grid.floors[p.floorIndex].inside;
  let best = null;
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
    if (!inside[j * grid.nx + i]) continue;
    const x = cellX(grid, i), y = cellY(grid, j);
    const d = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (!best || d < best.d) best = { d, x, y };
  }
  return best ? { ...p, x: best.x, y: best.y } : p;
}

/**
 * @returns {{ totalArea, maxSingleArea, best, probes, estimate, targetFraction }}
 */
export function estimateApCount(scene, params, targetFraction = 0.95) {
  const probes = probePositions(scene).map((ap) => {
    const maps = computeCoverage(scene, params, [ap]);
    const st = coverageStats(scene, maps, params.thresholdDbm);
    return { ...ap, coveredArea: st.coveredArea, fraction: st.fraction };
  });
  const cellArea = scene.grid.cell ** 2;
  const totalArea = scene.grid.floors.reduce((s, m) => s + m.insideCount * cellArea, 0);
  const best = probes.reduce((a, b) => (!a || b.coveredArea > a.coveredArea ? b : a), null);
  const maxSingleArea = best ? best.coveredArea : 0;
  const estimate = maxSingleArea > 0 ? Math.max(1, Math.ceil((targetFraction * totalArea) / maxSingleArea)) : null;
  return { totalArea, maxSingleArea, best, probes, estimate, targetFraction };
}
