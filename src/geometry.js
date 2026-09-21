// Pure 2D geometry helpers. All coordinates in meters unless noted.

export const EPS = 1e-9;

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Closest point on segment AB to P.
 * @returns {{d:number,t:number,x:number,y:number}} distance, parameter along AB (0..1), point
 */
export function closestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 < EPS ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { d: Math.hypot(px - x, py - y), t, x, y };
}

/**
 * Does segment PQ cross wall segment AB?
 * Path parameter t is open (0,1) so an endpoint lying exactly on a wall does not count.
 * Wall parameter u is half-open [0,1) so a path through a shared corner of two
 * chained walls is counted once, not twice.
 */
export function segmentsCross(px, py, qx, qy, ax, ay, bx, by) {
  const rx = qx - px, ry = qy - py;
  const sx = bx - ax, sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return false; // parallel or collinear: grazing, not a penetration
  const wx = ax - px, wy = ay - py;
  const t = (wx * sy - wy * sx) / denom;
  const u = (wx * ry - wy * rx) / denom;
  return t > EPS && t < 1 - EPS && u >= 0 && u < 1;
}

/** Constrain point (x,y) relative to origin (ox,oy) to the nearest 45° direction. */
export function constrainAngle(ox, oy, x, y) {
  const dx = x - ox, dy = y - oy;
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: ox + Math.cos(ang) * len, y: oy + Math.sin(ang) * len };
}
