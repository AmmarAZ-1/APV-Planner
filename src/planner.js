// "Plan APs" tab: Stage 3 AP-count estimate.

import { estimateApCount } from './estimate.js';
import { buildScene } from './propagation.js';
import { uid } from './model.js';

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DEFAULT_PLAN = {
  targetPct: 95, // target share of floor area at or above the threshold
  countMode: 'auto', // 'estimate' | 'manual' | 'auto'
  manualCount: 2,
};

export function ensurePlanState(project) {
  project.plan = { ...DEFAULT_PLAN, ...(project.plan || {}) };
}

export function createPlanner(app) {
  let cache = { version: -1, result: null };

  function estimate() {
    if (cache.version === app.modelVersion) return cache.result;
    const p = app.project.params;
    const scene = buildScene(app.project, p);
    const result = scene.grid.floors.some((m) => m.insideCount)
      ? estimateApCount(scene, p, app.project.plan.targetPct / 100)
      : null;
    cache = { version: app.modelVersion, result };
    return result;
  }

  /** The AP count the optimizer should use, or null for "decide automatically". */
  function chosenCount() {
    const plan = app.project.plan;
    if (plan.countMode === 'manual') return Math.max(1, Math.round(plan.manualCount));
    if (plan.countMode === 'estimate') return estimate()?.estimate ?? null;
    return null;
  }

  function renderPanel(el) {
    const plan = app.project.plan;
    const p = app.project.params;
    const floors = app.project.floors;
    const est = estimate();
    el.innerHTML = `
      <section>
        <h2>Step 1 · How many APs?</h2>
        <label class="field"><span>Coverage threshold (dBm)</span><input type="number" step="1" data-param="thresholdDbm" value="${p.thresholdDbm}" /></label>
        <label class="field"><span>Target coverage (% of floor area)</span><input type="number" step="1" min="1" max="100" data-plan="targetPct" value="${plan.targetPct}" /></label>
        ${est ? `
          <table class="kv">
            <tr><td>Total floor area</td><td class="mono">${fmt(est.totalArea, 0)} m²</td></tr>
            <tr><td>Best single AP covers</td><td class="mono">${fmt(est.maxSingleArea, 0)} m² (${fmt((est.maxSingleArea / est.totalArea) * 100, 0)}%)</td></tr>
            <tr><td>…placed at</td><td>${esc(floors[est.best.floorIndex].label)} <span class="mono">(${fmt(est.best.x, 1)}, ${fmt(est.best.y, 1)})</span></td></tr>
          </table>
          <p class="formula mono">⌈ ${plan.targetPct / 100} × ${fmt(est.totalArea, 0)} ÷ ${fmt(est.maxSingleArea, 0)} ⌉ = <b>${est.estimate}</b> AP${est.estimate === 1 ? '' : 's'}</p>
          <details class="tiny"><summary>Probe positions (${est.probes.length})</summary>
            <table><thead><tr><th>Floor</th><th>x, y (m)</th><th>Covers</th></tr></thead><tbody>
              ${est.probes.map((pr) => `<tr ${pr === est.best ? 'class="selected"' : ''}><td>${esc(floors[pr.floorIndex].label)}</td><td class="mono">${fmt(pr.x)}, ${fmt(pr.y)}</td><td class="mono">${fmt(pr.coveredArea, 0)} m²</td></tr>`).join('')}
            </tbody></table>
            <p class="muted">Each floor's indoor centroid and its four quadrant centroids, evaluated with the full wall-and-floor model.</p>
          </details>
          <div class="row"><button class="small" id="btnShowBestProbe">Show best single-AP spot on the heatmap</button></div>
        ` : '<p class="muted tiny">Trace at least one floor with a closed exterior wall to get an estimate.</p>'}

        <h2 style="margin-top:12px">AP count to use</h2>
        <label class="row"><input type="radio" name="countMode" value="estimate" ${plan.countMode === 'estimate' ? 'checked' : ''}/> Accept the estimate${est ? ` (${est.estimate})` : ''}</label>
        <label class="row"><input type="radio" name="countMode" value="manual" ${plan.countMode === 'manual' ? 'checked' : ''}/> Set manually
          <input type="number" min="1" max="20" step="1" data-plan="manualCount" value="${plan.manualCount}" ${plan.countMode === 'manual' ? '' : 'disabled'}/></label>
        <label class="row"><input type="radio" name="countMode" value="auto" ${plan.countMode === 'auto' ? 'checked' : ''}/> Let the optimizer decide</label>
      </section>`;
  }

  function onPanelEvent(e) {
    const t = e.target;
    if (e.type === 'click' && t.id === 'btnShowBestProbe') {
      const est = estimate();
      if (!est) return;
      const f = app.project.floors[est.best.floorIndex];
      app.checkpoint();
      app.project.aps = [{ id: uid('ap'), floorId: f.id, x: est.best.x + f.origin.x, y: est.best.y + f.origin.y }];
      app.changed();
      app.setActiveFloor(f.id);
      return;
    }
    if (e.type !== 'change') return;
    if (t.name === 'countMode') { app.project.plan.countMode = t.value; app.changed(); return; }
    const v = parseFloat(t.value);
    if (!Number.isFinite(v)) return;
    if (t.dataset.plan) {
      app.project.plan[t.dataset.plan] = t.dataset.plan === 'targetPct' ? Math.min(100, Math.max(1, v)) : v;
      app.changed();
    } else if (t.dataset.param) {
      app.checkpoint();
      app.project.params[t.dataset.param] = v;
      app.changed();
    }
  }

  return { renderPanel, onPanelEvent, estimate, chosenCount };
}
