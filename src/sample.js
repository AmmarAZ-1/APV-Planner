// A synthetic two-storey, ~12 m × 9 m brick house with a concrete stair core.
// Used to demo and test the tool: it can be loaded fully traced, or as plan images
// only (with a 5 m scale bar printed on them) to practise the tracing workflow.

export const SAMPLE_PPM = 60; // pixels per meter of the generated plan images
const IMG_W_M = 14.5, IMG_H_M = 11.8;

/** Build a straight wall with openings given as [fromDist, toDist, material] along it. */
function run(x1, y1, x2, y2, mat, openings = []) {
  const L = Math.hypot(x2 - x1, y2 - y1);
  const P = (d) => [x1 + ((x2 - x1) * d) / L, y1 + ((y2 - y1) * d) / L];
  const out = [];
  let cur = 0;
  for (const [a, b, m] of [...openings].sort((p, q) => p[0] - q[0])) {
    if (a > cur) out.push([...P(cur), ...P(a), mat]);
    out.push([...P(a), ...P(b), m]);
    cur = b;
  }
  if (cur < L) out.push([...P(cur), ...P(L), mat]);
  return out;
}

export function sampleHouse() {
  const B = 'brick', D = 'drywall', C = 'concrete', G = 'glass', W = 'wood_door';
  const ground = [
    ...run(1, 1, 13, 1, B, [[1, 3, G], [8, 10, G]]),
    ...run(13, 1, 13, 10, B, [[1.5, 3, G]]),
    ...run(13, 10, 1, 10, B, [[6, 7, W], [9, 11, G]]),
    ...run(1, 10, 1, 1, B, [[2, 4, G]]),
    ...run(7, 1, 7, 10, D, [[5, 5.9, W]]),
    ...run(1, 6, 7, 6, D, [[2.2, 3.1, W]]),
    ...run(7, 5, 13, 5, D, [[3, 3.9, W]]),
    ...run(10, 5, 10, 10, C, [[3, 3.9, W]]),
  ];
  const upper = [
    ...run(1, 1, 13, 1, B, [[1.5, 3, G], [8, 9.5, G]]),
    ...run(13, 1, 13, 10, B, [[1.5, 3, G], [7, 8, G]]),
    ...run(13, 10, 1, 10, B, [[8, 10, G]]),
    ...run(1, 10, 1, 1, B, [[2, 3.5, G], [6, 7.5, G]]),
    ...run(6.5, 1, 6.5, 10, D, [[3, 3.9, W], [5.5, 6.4, W]]),
    ...run(1, 5.5, 6.5, 5.5, D),
    ...run(6.5, 4.5, 13, 4.5, D, [[1, 1.9, W]]),
    ...run(10, 4.5, 10, 10, C, [[0.5, 1.4, W]]),
    ...run(10, 7.5, 13, 7.5, D, [[1, 1.9, W]]),
  ];
  return {
    name: 'Sample 2-storey house',
    floors: [
      {
        label: 'Ground floor', storeyHeight: 2.7, walls: ground,
        rooms: [['Living', 4, 3.5], ['Study', 4, 8], ['Kitchen', 10, 3], ['Hall', 8.5, 7.5], ['Utility / stairs', 11.5, 7.5]],
      },
      {
        label: 'First floor', storeyHeight: 2.7, walls: upper,
        rooms: [['Bedroom 1', 3.7, 3.2], ['Bedroom 2', 3.7, 7.8], ['Bedroom 3', 9.7, 2.7], ['Landing', 8.2, 7.3], ['Bath', 11.5, 6], ['Stairs', 11.5, 8.8]],
      },
    ],
    ont: { floorIndex: 0, x: 12.3, y: 9.3 },
  };
}

const THICK = { brick: 0.3, concrete: 0.25, drywall: 0.12, wood_door: 0.05, glass: 0.06, other: 0.15 };

/** Draw a floor as an architectural-looking plan image. Returns a PNG Blob. */
export function renderPlanImage(floor, title) {
  const ppm = SAMPLE_PPM;
  const c = document.createElement('canvas');
  c.width = Math.round(IMG_W_M * ppm);
  c.height = Math.round(IMG_H_M * ppm);
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf7';
  g.fillRect(0, 0, c.width, c.height);
  g.lineCap = 'butt';
  for (const [x1, y1, x2, y2, m] of floor.walls) {
    const X1 = x1 * ppm, Y1 = y1 * ppm, X2 = x2 * ppm, Y2 = y2 * ppm;
    if (m === 'wood_door') {
      // door leaf + swing arc
      const L = Math.hypot(X2 - X1, Y2 - Y1);
      const ang = Math.atan2(Y2 - Y1, X2 - X1);
      g.strokeStyle = '#555'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(X1, Y1, L, ang, ang + Math.PI / 2); g.stroke();
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(X1, Y1); g.lineTo(X1 + Math.cos(ang + Math.PI / 2) * L, Y1 + Math.sin(ang + Math.PI / 2) * L); g.stroke();
      continue;
    }
    if (m === 'glass') {
      const nx = -(Y2 - Y1), ny = X2 - X1, n = Math.hypot(nx, ny);
      const o = 0.07 * ppm;
      g.strokeStyle = '#333'; g.lineWidth = 1.5;
      for (const s of [-1, 0, 1]) {
        g.beginPath();
        g.moveTo(X1 + (nx / n) * o * s, Y1 + (ny / n) * o * s);
        g.lineTo(X2 + (nx / n) * o * s, Y2 + (ny / n) * o * s);
        g.stroke();
      }
      continue;
    }
    g.strokeStyle = m === 'concrete' ? '#444' : '#222';
    g.lineWidth = THICK[m] * ppm;
    g.lineCap = 'square';
    g.beginPath(); g.moveTo(X1, Y1); g.lineTo(X2, Y2); g.stroke();
    if (m === 'concrete') {
      g.strokeStyle = '#999'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X1, Y1); g.lineTo(X2, Y2); g.stroke();
    }
  }
  g.fillStyle = '#555';
  g.font = `${Math.round(0.32 * ppm)}px Georgia, serif`;
  g.textAlign = 'center';
  for (const [name, x, y] of floor.rooms || []) g.fillText(name.toUpperCase(), x * ppm, y * ppm);
  g.textAlign = 'left';
  g.font = `bold ${Math.round(0.36 * ppm)}px Georgia, serif`;
  g.fillText(title, 1 * ppm, 0.6 * ppm);
  // 5 m scale bar
  const sy = 11.0 * ppm;
  g.strokeStyle = '#222'; g.lineWidth = 2;
  g.beginPath();
  g.moveTo(1 * ppm, sy); g.lineTo(6 * ppm, sy);
  for (let i = 0; i <= 5; i++) { g.moveTo((1 + i) * ppm, sy - 6); g.lineTo((1 + i) * ppm, sy + 6); }
  g.stroke();
  g.font = `${Math.round(0.28 * ppm)}px Georgia, serif`;
  g.fillStyle = '#222';
  g.fillText('0', 0.93 * ppm, sy + 0.45 * ppm);
  g.fillText('5 m', 5.8 * ppm, sy + 0.45 * ppm);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
