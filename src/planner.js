// "Plan APs" tab: Stage 3 AP-count estimate and Stage 4 greedy layout optimizer.

import { estimateApCount } from './estimate.js';
import { buildScene } from './propagation.js';
import { uid } from './model.js';

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DEFAULT_PLAN = {
  targetPct: 95, // target share of floor area at or above the threshold
  countMode: 'auto', // 'estimate' | 'manual' | 'auto'
  manualCount: 2,
  backhaul: 'wired', // 'wired' | 'mesh'
  meshMinDbm: -65,
  rootAtOnt: false,
  minGainPct: 3,
  maxAps: 8,
  candidateSpacing: 1.0,
  result: null, // last optimizer result (persisted so the readout survives reloads)
};

export function ensurePlanState(project) {
  project.plan = { ...DEFAULT_PLAN, ...(project.plan || {}) };
}

export function createPlanner(app) {
  let cache = { version: -1, result: null };
  let running = null; // { worker, fraction, message }

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
      </section>
      ${renderOptimizer(est)}`;
  }

  function renderOptimizer(est) {
    const plan = app.project.plan;
    const floors = app.project.floors;
    const count = chosenCount();
    const r = plan.result;
    const mesh = plan.backhaul === 'mesh';
    const maxGain = r ? Math.max(1, ...r.steps.map((s) => s.gainPct)) : 1;
    return `
      <section>
        <h2>Step 2 · Optimize the layout</h2>
        <p class="muted tiny">Greedy placement: each AP goes where it adds the most still-uncovered area. ${count
          ? `Placing exactly <b>${count}</b> AP${count === 1 ? '' : 's'}.`
          : `Stops at ${plan.targetPct}% coverage, when the next AP adds < ${plan.minGainPct} pp, or at ${plan.maxAps} APs.`}</p>
        <div class="seg" role="radiogroup" aria-label="Backhaul">
          <label><input type="radio" name="backhaul" value="wired" ${!mesh ? 'checked' : ''}/><span>Wired to ONT</span></label>
          <label><input type="radio" name="backhaul" value="mesh" ${mesh ? 'checked' : ''}/><span>Wireless mesh</span></label>
        </div>
        ${mesh ? `<label class="field"><span>Min AP↔AP link (dBm)</span><input type="number" step="1" data-plan="meshMinDbm" value="${plan.meshMinDbm}" /></label>` : ''}
        <label class="row"><input type="checkbox" id="optRootAtOnt" ${plan.rootAtOnt ? 'checked' : ''} ${app.project.ont ? '' : 'disabled'}/>
          AP1 is the router at the ONT${app.project.ont ? '' : ' (place the ONT first)'}</label>
        <label class="field"><span>Min marginal gain (pp)</span><input type="number" step="0.5" min="0" data-plan="minGainPct" value="${plan.minGainPct}" ${count ? 'disabled' : ''}/></label>
        <label class="field"><span>Max APs</span><input type="number" step="1" min="1" max="20" data-plan="maxAps" value="${plan.maxAps}" ${count ? 'disabled' : ''}/></label>
        <label class="field"><span>Candidate spacing (m)</span><input type="number" step="0.25" min="0.25" data-plan="candidateSpacing" value="${plan.candidateSpacing}" /></label>
        ${running
          ? `<div class="progress"><span style="width:${(running.fraction * 100).toFixed(0)}%"></span></div><p class="muted tiny" id="optMsg">${esc(running.message || 'Starting…')}</p>
             <button class="small" id="btnCancelOpt">Cancel</button>`
          : `<button class="primary" id="btnRunOpt" ${est ? '' : 'disabled'}>▶ Run optimizer</button>`}
      </section>
      ${r ? `
      <section>
        <h2>Result</h2>
        <div class="big-stat"><b>${r.aps.length}</b> AP${r.aps.length === 1 ? '' : 's'} · <b>${fmt(r.fraction * 100, 1)}%</b> of floor area ≥ ${r.thresholdDbm} dBm</div>
        <p class="tiny ${r.flagged ? 'warn-text' : 'muted'}">${esc(r.stopReason)}</p>
        <table class="steps">
          <thead><tr><th>AP</th><th>Floor · position</th><th>Marginal gain</th></tr></thead>
          <tbody>
          ${r.steps.map((st) => `
            <tr class="${st.rejected ? 'rejected' : 'clickable'}" data-floor-index="${st.floorIndex}">
              <td><b>${st.rejected ? '—' : 'AP' + st.apNumber}</b></td>
              <td>${esc(floors[st.floorIndex]?.label ?? '?')}<br/><span class="mono muted">${fmt(st.x, 1)}, ${fmt(st.y, 1)} m${st.atOnt ? ' · ONT' : ''}</span>
                ${st.linkDbm != null ? `<br/><span class="mono muted">link ${fmt(st.linkDbm, 0)} dBm → AP${st.linkTo}</span>` : ''}
                ${st.rejected ? `<br/><span class="muted">AP${st.apNumber} candidate (not added)</span>` : ''}</td>
              <td><div class="gainbar"><span style="width:${(st.gainPct / maxGain) * 100}%"></span></div>
                <span class="mono">+${fmt(st.gainPct, 1)} pp</span>${st.cumulativePct != null ? `<span class="mono muted"> → ${fmt(st.cumulativePct, 1)}%</span>` : ''}
                ${st.meshCostPct ? `<br/><span class="muted">mesh link cost ${fmt(st.meshCostPct, 1)} pp</span>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <table><thead><tr><th>Floor</th><th>Covered</th></tr></thead><tbody>
          ${r.perFloor.map((pf, i) => `<tr class="clickable" data-floor-index="${i}"><td>${esc(floors[i]?.label ?? '?')}</td>
            <td><div class="meter"><span style="width:${(pf.fraction * 100).toFixed(1)}%"></span></div><span class="mono">${fmt(pf.fraction * 100, 0)}%</span></td></tr>`).join('')}
        </tbody></table>
        <p class="muted tiny">${r.candidates} candidate positions (every ${fmt(r.candidateSpacing, 2)} m) × ${r.cells} indoor cells, ${fmt(r.ms / 1000, 1)} s.
          The APs are now on the plan and the heatmap shows the combined best-server signal. Click a floor to view it; drag APs to fine-tune.</p>
      </section>` : ''}`;
  }

  function runOptimizer() {
    const est = estimate();
    if (!est || running) return;
    const plan = app.project.plan;
    const p = app.project.params;
    const floors = app.project.floors;
    const ont = app.project.ont;
    const ontIdx = ont ? floors.findIndex((f) => f.id === ont.floorId) : -1;
    const options = {
      targetFraction: plan.targetPct / 100,
      minGainPct: plan.minGainPct,
      maxAps: plan.maxAps,
      fixedCount: chosenCount(),
      backhaul: plan.backhaul,
      meshMinDbm: plan.meshMinDbm,
      rootAtOnt: plan.rootAtOnt && ontIdx >= 0,
      ont: ontIdx >= 0 ? { floorIndex: ontIdx, x: ont.x - floors[ontIdx].origin.x, y: ont.y - floors[ontIdx].origin.y } : null,
      candidateSpacing: plan.candidateSpacing,
    };
    const worker = new Worker(new URL('./optimizer.worker.js', import.meta.url), { type: 'module' });
    const t0 = performance.now();
    running = { worker, fraction: 0, message: 'Building scene…' };
    app.refreshPanel();
    const stop = () => { worker.terminate(); running = null; };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        running.fraction = m.fraction;
        running.message = m.message;
        const bar = document.querySelector('.progress span');
        if (bar) bar.style.width = `${(m.fraction * 100).toFixed(0)}%`;
        const msg = document.getElementById('optMsg');
        if (msg) msg.textContent = m.message;
      } else if (m.type === 'result') {
        stop();
        applyResult({ ...m.result, ms: performance.now() - t0, thresholdDbm: p.thresholdDbm });
      } else {
        stop();
        app.toast(`Optimizer failed: ${m.message}`);
        app.refreshPanel();
      }
    };
    worker.onerror = (e) => { stop(); app.toast(`Optimizer failed: ${e.message}`); app.refreshPanel(); };
    worker.postMessage({ project: JSON.parse(JSON.stringify(app.project)), params: p, options });
  }

  function applyResult(result) {
    const floors = app.project.floors;
    app.checkpoint();
    app.project.plan.result = result;
    app.project.aps = result.aps.map((a) => {
      const f = floors[a.floorIndex];
      return { id: uid('ap'), floorId: f.id, x: a.x + f.origin.x, y: a.y + f.origin.y };
    });
    app.ui.showHeatmap = true;
    app.changed();
    app.toast(`${result.aps.length} AP${result.aps.length === 1 ? '' : 's'} placed, ${fmt(result.fraction * 100, 1)}% coverage`);
  }

  function onPanelEvent(e) {
    const t = e.target;
    if (e.type === 'click') {
      if (t.id === 'btnRunOpt') { runOptimizer(); return; }
      if (t.id === 'btnCancelOpt') { running?.worker.terminate(); running = null; app.refreshPanel(); return; }
      const row = t.closest('[data-floor-index]');
      if (row) { const f = app.project.floors[+row.dataset.floorIndex]; if (f) app.setActiveFloor(f.id); return; }
    }
    if (e.type === 'change' && t.name === 'backhaul') { app.project.plan.backhaul = t.value; app.changed(); return; }
    if (e.type === 'change' && t.id === 'optRootAtOnt') { app.project.plan.rootAtOnt = t.checked; app.changed(); return; }
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
