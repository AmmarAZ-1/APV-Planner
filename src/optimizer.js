// Stage 4: greedy incremental AP placement (maximum-coverage, submodular objective).
//
// Coverage f(S) = number of indoor cells whose best-server RSSI from AP set S is ≥ threshold.
// f is monotone submodular (adding an AP never removes coverage, and an AP's marginal gain can
// only shrink as S grows), so greedy selection is within (1 − 1/e) of the optimal N-AP layout
// (Nemhauser, Wolsey & Fisher 1978) at O(N · candidates · cells) cost instead of the
// combinatorial search over all position tuples.

import { cellX, cellY, pathLoss } from './propagation.js';

export const DEFAULT_OPT = {
  targetFraction: 0.95, // stop once this share of the floor area is covered
  minGainPct: 3, // stop when the next AP would add fewer percentage points than this
  maxAps: 8,
  fixedCount: null, // place exactly this many (overrides target / min-gain stopping)
  backhaul: 'wired', // 'wired' | 'mesh'
  meshMinDbm: -65, // mesh: minimum AP↔AP link RSSI to at least one placed AP
  rootAtOnt: false, // AP1 is the router at the ONT instead of the best-coverage spot
  ont: null, // { floorIndex, x, y } building-wide meters
  candidateSpacing: 1.0, // meters between candidate AP positions
};

/** Indoor receiver cells across all floors. */
function receivers(scene, params) {
  const { grid } = scene;
  const out = [];
  scene.floors.forEach((fl, f) => {
    const inside = grid.floors[f].inside;
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      if (inside[j * grid.nx + i]) out.push({ x: cellX(grid, i), y: cellY(grid, j), z: fl.z0 + params.rxHeight, f });
    }
  });
  return out;
}

/** Candidate AP positions: indoor cells subsampled to roughly `spacing` meters. */
function candidates(scene, params, spacing) {
  const { grid } = scene;
  const step = Math.max(1, Math.round(spacing / grid.cell));
  const out = [];
  scene.floors.forEach((fl, f) => {
    const inside = grid.floors[f].inside;
    for (let j = Math.floor(step / 2); j < grid.ny; j += step) for (let i = Math.floor(step / 2); i < grid.nx; i += step) {
      if (inside[j * grid.nx + i]) out.push({ x: cellX(grid, i), y: cellY(grid, j), z: fl.z0 + params.apHeight, f });
    }
  });
  return out;
}

/**
 * @param onProgress (fraction, message) => void
 * @returns result { aps, steps, stopReason, fraction, perFloor, flagged, candidates, cells }
 */
export function greedyPlacement(scene, params, options = {}, onProgress = () => {}) {
  const opt = { ...DEFAULT_OPT, ...options };
  const rx = receivers(scene, params);
  let cand = candidates(scene, params, opt.candidateSpacing);
  // keep the RSSI matrix within ~25 M entries (100 MB) by coarsening the candidate grid
  let spacing = opt.candidateSpacing;
  while (cand.length * rx.length > 25e6) { spacing *= 1.5; cand = candidates(scene, params, spacing); }
  const R = rx.length, C = cand.length;
  if (!R || !C) return { aps: [], steps: [], stopReason: 'No indoor area to cover. Trace closed exterior walls first.', fraction: 0 };

  // Rooted mesh / "router at ONT": the ONT becomes candidate 0 and AP1 is forced there.
  let forcedFirst = -1;
  if (opt.rootAtOnt && opt.ont) {
    cand.unshift({ x: opt.ont.x, y: opt.ont.y, z: scene.floors[opt.ont.floorIndex].z0 + params.apHeight, f: opt.ont.floorIndex, ont: true });
    forcedFirst = 0;
  }
  const Cn = cand.length;

  // RSSI matrix: candidates × receivers
  const M = new Float32Array(Cn * R);
  const tx = params.txPowerDbm;
  for (let c = 0; c < Cn; c++) {
    const T = cand[c];
    const row = c * R;
    for (let r = 0; r < R; r++) M[row + r] = tx - pathLoss(scene, params, T, rx[r]);
    if (c % 25 === 0) onProgress((0.9 * c) / Cn, `Path loss ${c}/${Cn} candidate positions × ${R} cells`);
  }

  const thr = params.thresholdDbm;
  const covered = new Uint8Array(R);
  const best = new Float32Array(R).fill(-Infinity); // best-server RSSI so far
  let coveredCount = 0;
  const placed = []; // candidate indices
  const steps = [];
  const linkOk = new Uint8Array(Cn); // mesh: candidate has a good link to some placed AP
  const linkRssi = new Float32Array(Cn).fill(-Infinity);
  const linkParent = new Int32Array(Cn).fill(-1);
  const limit = opt.fixedCount ?? opt.maxAps;
  let stopReason = '';
  let flagged = null;

  const gainOf = (c) => {
    let g = 0, score = 0;
    const row = c * R;
    for (let r = 0; r < R; r++) {
      const v = M[row + r];
      if (!covered[r] && v >= thr) g++;
      if (v > best[r]) score += Math.min(v, thr + 10) - Math.max(best[r], thr - 30); // tie-break: signal improvement
    }
    return { g, score };
  };

  while (placed.length < limit) {
    const k = placed.length;
    let pick = -1, pickGain = -1, pickScore = -Infinity;
    let freeBest = -1; // best gain ignoring the mesh constraint (to report what it costs)
    if (k === 0 && forcedFirst >= 0) {
      pick = forcedFirst;
      pickGain = gainOf(pick).g;
    } else {
      for (let c = 0; c < Cn; c++) {
        if (placed.includes(c)) continue;
        const { g, score } = gainOf(c);
        if (g > freeBest) freeBest = g;
        if (opt.backhaul === 'mesh' && k > 0 && !linkOk[c]) continue;
        if (g > pickGain || (g === pickGain && score > pickScore)) { pick = c; pickGain = g; pickScore = score; }
      }
    }
    const gainPct = (pickGain / R) * 100;
    const fracNow = coveredCount / R;

    if (pick < 0 && opt.backhaul !== 'mesh') { stopReason = 'No candidate positions left.'; break; }
    if (pick < 0 || (opt.backhaul === 'mesh' && k > 0 && pickGain <= 0 && freeBest > 0)) {
      flagged = {
        apNumber: k + 1,
        message: `AP${k + 1} can't be placed under the mesh constraint: no position with a ≥ ${opt.meshMinDbm} dBm link to an existing AP adds coverage (an unconstrained AP here would add ${fmt((freeBest / R) * 100)} pp).`,
      };
      stopReason = flagged.message;
      break;
    }
    if (opt.fixedCount == null && k > 0) {
      if (fracNow >= opt.targetFraction) { stopReason = `Target reached: ${fmt(fracNow * 100)}% ≥ ${fmt(opt.targetFraction * 100)}% of floor area covered.`; break; }
      if (gainPct < opt.minGainPct) {
        stopReason = `AP${k + 1} would add only ${fmt(gainPct)} pp (< ${opt.minGainPct} pp minimum gain), so it was not added.`;
        steps.push({ rejected: true, apNumber: k + 1, gainPct, ...pos(cand[pick]) });
        break;
      }
    }
    if (pickGain <= 0 && k > 0) { stopReason = `Every indoor cell a new AP could reach is already covered (${fmt(fracNow * 100)}%).`; break; }

    // commit
    placed.push(pick);
    const row = pick * R;
    for (let r = 0; r < R; r++) {
      const v = M[row + r];
      if (v > best[r]) best[r] = v;
      if (!covered[r] && v >= thr) { covered[r] = 1; coveredCount++; }
    }
    const step = { apNumber: k + 1, gainPct, cumulativePct: (coveredCount / R) * 100, ...pos(cand[pick]), atOnt: !!cand[pick].ont };
    if (opt.backhaul === 'mesh' && k > 0) {
      step.linkDbm = linkRssi[pick];
      step.linkTo = placed.indexOf(linkParent[pick]) + 1;
      if (freeBest > pickGain) step.meshCostPct = ((freeBest - pickGain) / R) * 100;
    }
    steps.push(step);
    onProgress(0.9 + (0.1 * placed.length) / limit, `Placed AP${k + 1}`);

    // mesh: refresh which candidates can hear the placed set well enough
    if (opt.backhaul === 'mesh') {
      const P = cand[pick];
      for (let c = 0; c < Cn; c++) {
        const v = tx - pathLoss(scene, params, P, cand[c]);
        if (v > linkRssi[c]) { linkRssi[c] = v; linkParent[c] = pick; }
        if (v >= opt.meshMinDbm) linkOk[c] = 1;
      }
    }
  }
  if (!stopReason) {
    stopReason = opt.fixedCount != null
      ? `Placed the requested ${opt.fixedCount} AP${opt.fixedCount === 1 ? '' : 's'}.`
      : `Reached the maximum of ${opt.maxAps} APs.`;
  }

  const perFloor = scene.floors.map(() => ({ cells: 0, covered: 0 }));
  rx.forEach((p, r) => { perFloor[p.f].cells++; if (covered[r]) perFloor[p.f].covered++; });
  onProgress(1, 'Done');
  return {
    aps: placed.map((c) => pos(cand[c])),
    steps,
    stopReason,
    flagged,
    fraction: coveredCount / R,
    perFloor: perFloor.map((p) => ({ ...p, fraction: p.cells ? p.covered / p.cells : 0 })),
    candidates: Cn,
    cells: R,
    candidateSpacing: spacing,
  };
}

function pos(c) {
  return { floorIndex: c.f, x: c.x, y: c.y };
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}
