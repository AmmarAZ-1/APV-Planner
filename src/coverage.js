// Stage 2 UI: AP marker(s), live coverage heatmap overlay and the Coverage panel.

import {
  apPoint, BAND_PL0, buildScene, computeCoverage, coverageStats, DEFAULT_PARAMS, pathLoss,
} from './propagation.js';
import { label } from './editor.js';
import { uid } from './model.js';

// RSSI colour ramp (dBm → rgb), the usual Wi-Fi survey palette
const STOPS = [
  [-40, [0, 104, 55]],
  [-50, [26, 152, 80]],
  [-60, [145, 207, 96]],
  [-67, [217, 239, 139]],
  [-72, [254, 224, 139]],
  [-77, [252, 141, 89]],
  [-82, [215, 48, 39]],
  [-90, [120, 20, 60]],
];

export function rssiColor(v) {
  if (v >= STOPS[0][0]) return STOPS[0][1];
  for (let k = 1; k < STOPS.length; k++) {
    const [v1, c1] = STOPS[k];
    if (v >= v1) {
      const [v0, c0] = STOPS[k - 1];
      const t = (v - v0) / (v1 - v0);
      return [0, 1, 2].map((i) => Math.round(c0[i] + (c1[i] - c0[i]) * t));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function ensureCoverageState(project) {
  project.params = { ...DEFAULT_PARAMS, band: '2.4', ...(project.params || {}) };
  project.aps = project.aps || [];
}

export function createCoverage(app, editor) {
  const cov = {
    scene: null,
    maps: null,
    stats: null,
    dirty: true,
    images: [], // per-floor offscreen canvas of the heatmap
  };

  const params = () => app.project.params;
  const floorIndexOf = (id) => app.project.floors.findIndex((f) => f.id === id);

  /** APs in building-wide coordinates with floor index. */
  function apsGlobal() {
    return app.project.aps
      .map((ap) => {
        const fi = floorIndexOf(ap.floorId);
        if (fi < 0) return null;
        const o = app.project.floors[fi].origin;
        return { id: ap.id, floorIndex: fi, x: ap.x - o.x, y: ap.y - o.y };
      })
      .filter(Boolean);
  }

  function invalidate() {
    cov.dirty = true;
    editor.requestRender();
  }

  function recompute() {
    if (!cov.dirty) return;
    cov.dirty = false;
    const p = params();
    cov.scene = buildScene(app.project, p);
    const aps = apsGlobal();
    if (!aps.length) { cov.maps = null; cov.stats = null; cov.images = []; return; }
    const t0 = performance.now();
    cov.maps = computeCoverage(cov.scene, p, aps);
    cov.ms = performance.now() - t0;
    cov.stats = coverageStats(cov.scene, cov.maps, p.thresholdDbm);
    cov.images = cov.maps.map((m, f) => heatImage(cov.scene, m, f));
    app.onCoverageUpdated?.();
  }

  function heatImage(scene, map, f) {
    const { nx, ny } = scene.grid;
    const inside = scene.grid.floors[f].inside;
    const c = document.createElement('canvas');
    c.width = nx; c.height = ny;
    const g = c.getContext('2d');
    const img = g.createImageData(nx, ny);
    const showOutside = app.ui.heatOutside;
    for (let k = 0; k < nx * ny; k++) {
      const v = map[k];
      if (!Number.isFinite(v) || (!inside[k] && !showOutside)) continue;
      const [r, gg, b] = rssiColor(v);
      img.data[k * 4] = r; img.data[k * 4 + 1] = gg; img.data[k * 4 + 2] = b;
      img.data[k * 4 + 3] = inside[k] ? 255 : 110;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // ---------- canvas layers ----------
  function heatLayer(ctx, ed) {
    if (!app.ui.showHeatmap || !app.project.aps.length) return;
    recompute();
    const f = app.project.floors.indexOf(ed.floor);
    const img = cov.images[f];
    if (!img) return;
    const { x0, y0, nx, ny, cell } = cov.scene.grid;
    const o = ed.floor.origin;
    const [sx, sy] = ed.toScreen(x0 + o.x, y0 + o.y);
    ctx.save();
    ctx.globalAlpha = app.ui.heatOpacity;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, nx * cell * ed.view.s, ny * cell * ed.view.s);
    ctx.restore();
  }

  function apLayer(ctx, ed) {
    const f = app.project.floors.indexOf(ed.floor);
    const o = ed.floor.origin;
    apsGlobal().forEach((ap, k) => {
      const [sx, sy] = ed.toScreen(ap.x + o.x, ap.y + o.y);
      const here = ap.floorIndex === f;
      ctx.globalAlpha = here ? 1 : 0.4;
      ctx.fillStyle = here ? '#2563eb' : '#64748b';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      for (const r of [16, 21]) { // radio waves
        ctx.strokeStyle = here ? 'rgba(37,99,235,0.8)' : 'rgba(100,116,139,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sx, sy, r, -Math.PI * 0.8, -Math.PI * 0.2); ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`AP${apsGlobal().length > 1 ? k + 1 : ''}`, sx, sy + 0.5);
      if (!here) label(ctx, sx, sy + 24, `on ${app.project.floors[ap.floorIndex].label}`, '#475569');
      ctx.globalAlpha = 1;
    });
  }
  editor.layers.push(heatLayer);
  editor.topLayers.push(apLayer);

  // ---------- interaction ----------
  function hitAp(raw) {
    const f = editor.floor;
    let best = null;
    for (const ap of app.project.aps) {
      if (ap.floorId !== f.id) continue;
      const d = Math.hypot(ap.x - raw.x, ap.y - raw.y) * editor.view.s;
      if (d < 14 && (!best || d < best.d)) best = { ap, d };
    }
    return best?.ap;
  }

  function dragAp(ap, checkpoint = true) {
    if (checkpoint) app.checkpoint();
    return {
      type: 'ap',
      move: (p) => { ap.x = p.x; ap.y = p.y; invalidate(); },
      up: () => app.changed(),
    };
  }

  /** Called by the editor before its own select-tool hit testing. */
  function onCanvasPick(raw) {
    const ap = hitAp(raw);
    return ap ? dragAp(ap) : null;
  }

  /** "ap" tool: place the AP (stage 2 uses a single AP; clicking again moves it). */
  function placeAp(raw) {
    const f = editor.floor;
    app.checkpoint();
    const existing = app.project.aps[0];
    if (existing) Object.assign(existing, { floorId: f.id, x: raw.x, y: raw.y });
    else app.project.aps.push({ id: uid('ap'), floorId: f.id, x: raw.x, y: raw.y });
    app.changed();
    return dragAp(app.project.aps[0], false);
  }

  /** HUD text for the cursor position: RSSI and the loss breakdown from the nearest AP. */
  function hoverInfo(raw) {
    if (!app.project.aps.length || !cov.scene) return '';
    recompute();
    const p = params();
    const f = app.project.floors.indexOf(editor.floor);
    const o = editor.floor.origin;
    const R = { x: raw.x - o.x, y: raw.y - o.y, z: cov.scene.floors[f].z0 + p.rxHeight, f };
    let best = null;
    apsGlobal().forEach((ap, k) => {
      const d = pathLoss(cov.scene, p, apPoint(cov.scene, p, ap), R, true);
      const v = p.txPowerDbm - d.total;
      if (!best || v > best.v) best = { v, d, k };
    });
    if (!best) return '';
    const b = best.d;
    return `RSSI ${fmt(best.v)} dBm  ·  ${fmt(b.distance, 2)} m → ${fmt(b.distLoss)} dB + walls ${fmt(b.walls)} dB + floors ${fmt(b.floors)} dB`;
  }

  // ---------- panel ----------
  function numField(key, labelText, step, extra = '') {
    return `<label class="field"><span>${labelText}</span><input type="number" step="${step}" data-param="${key}" value="${params()[key]}" ${extra}/></label>`;
  }

  function renderPanel(el) {
    recompute();
    const p = params();
    const floors = app.project.floors;
    const fi = floors.indexOf(editor.floor);
    const aps = apsGlobal();
    const s = cov.stats;
    const warnings = cov.scene ? cov.scene.grid.floors.map((m, i) =>
      m.empty ? `<li>${esc(floors[i].label)} has no walls, so it is excluded from the area.</li>`
        : m.leaky ? `<li>${esc(floors[i].label)}: the exterior wall isn't closed, so its bounding box is used as indoor area.</li>` : '').join('') : '';
    el.innerHTML = `
      <section>
        <div class="section-head"><h2>Access point</h2></div>
        ${aps.length ? `
          <p class="tiny">On <b>${esc(floors[aps[0].floorIndex].label)}</b> at
            <span class="mono">x ${fmt(app.project.aps[0].x, 2)} · y ${fmt(app.project.aps[0].y, 2)} · z ${fmt(cov.scene.floors[aps[0].floorIndex].z0 + p.apHeight, 2)} m</span></p>
          <div class="row">
            <label>Floor <select id="apFloor">${floors.map((f, i) => `<option value="${f.id}" ${i === aps[0].floorIndex ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
            <button class="small" data-tool-btn="ap">Move</button>
            <button class="small danger" id="btnRemoveAp">Remove</button>
          </div>
          <p class="muted tiny">Drag the AP marker with the Select tool to move it live.</p>`
        : `<p class="muted tiny">Place an AP on any floor to see its coverage everywhere in the house.</p>
           <div class="row"><button class="small primary" data-tool-btn="ap">◉ Place AP</button>
           ${app.project.ont ? '<button class="small" id="btnApAtOnt">Put AP at the ONT</button>' : ''}</div>`}
      </section>

      <section>
        <div class="section-head"><h2>Heatmap</h2>
          <label class="row" style="margin:0"><input type="checkbox" id="covShow" ${app.ui.showHeatmap ? 'checked' : ''}/> Show</label></div>
        <label class="field"><span>Viewing floor</span>
          <select id="covFloor">${floors.map((f, i) => `<option value="${f.id}" ${i === fi ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Opacity</span><input type="range" id="covOpacity" min="0.1" max="1" step="0.05" value="${app.ui.heatOpacity}" /></label>
        <label class="row"><input type="checkbox" id="covOutside" ${app.ui.heatOutside ? 'checked' : ''}/> Also shade outdoor cells</label>
        <div class="legend">
          <div class="legend-bar" style="background:linear-gradient(to right, ${STOPS.slice().reverse().map(([v, c]) => `rgb(${c.join(',')}) ${((v + 90) / 50) * 100}%`).join(', ')})"></div>
          <div class="legend-ticks"><span>−90</span><span>−80</span><span>−70</span><span>−60</span><span>−50</span><span>−40 dBm</span></div>
          <div class="legend-threshold" style="left:${((p.thresholdDbm + 90) / 50) * 100}%" title="coverage threshold"></div>
        </div>
      </section>

      ${s ? `
      <section>
        <h2>Coverage ≥ ${p.thresholdDbm} dBm</h2>
        <table>
          <thead><tr><th>Floor</th><th>Area m²</th><th>Covered</th></tr></thead>
          <tbody>
            ${s.perFloor.map((pf, i) => `<tr class="${i === fi ? 'selected' : ''}"><td>${esc(floors[i].label)}</td><td class="mono">${fmt(pf.area, 0)}</td>
              <td><div class="meter"><span style="width:${(pf.fraction * 100).toFixed(1)}%"></span></div><span class="mono">${fmt(pf.fraction * 100, 0)}%</span></td></tr>`).join('')}
            <tr><td><b>House</b></td><td class="mono"><b>${fmt(s.area, 0)}</b></td><td class="mono"><b>${fmt(s.fraction * 100, 1)}%</b></td></tr>
          </tbody>
        </table>
        <p class="muted tiny">${cov.scene.grid.nx}×${cov.scene.grid.ny} grid × ${floors.length} floors at ${p.cellSize} m, computed in ${fmt(cov.ms, 0)} ms. Hover the plan for RSSI and its loss breakdown.</p>
        ${warnings ? `<ul class="tiny warn-list">${warnings}</ul>` : ''}
      </section>` : ''}

      <section>
        <h2>Propagation model</h2>
        <p class="muted tiny mono">PL = PL0 + 10·n·log10(d/d0) + Σwalls + floors·slab<br/>RSSI = Tx − PL</p>
        <label class="field"><span>Band</span><select id="covBand">
          ${Object.keys(BAND_PL0).map((b) => `<option value="${b}" ${p.band === b ? 'selected' : ''}>${b} GHz (PL0 ${BAND_PL0[b]} dB)</option>`).join('')}
        </select></label>
        ${numField('txPowerDbm', 'Tx power (dBm EIRP)', 1)}
        ${numField('pl0', 'PL0 at d0 (dB)', 0.1)}
        ${numField('d0', 'd0 (m)', 0.1, 'min="0.1"')}
        ${numField('n', 'Path loss exponent n', 0.1, 'min="1"')}
        ${numField('floorDb', 'Floor slab loss (dB)', 0.5, 'min="0"')}
        ${numField('thresholdDbm', 'Coverage threshold (dBm)', 1)}
        ${numField('apHeight', 'AP height above floor (m)', 0.1, 'min="0"')}
        ${numField('rxHeight', 'Device height above floor (m)', 0.1, 'min="0"')}
        ${numField('cellSize', 'Grid cell size (m)', 0.1, 'min="0.1"')}
        <p class="muted tiny">Wall losses come from each wall's material (Plan tab). Changing the band only changes PL0; material losses are 2.4 GHz values, so raise them for 5/6 GHz.</p>
      </section>`;
  }

  function onPanelEvent(e) {
    const t = e.target;
    if (e.type === 'input' && t.id === 'covOpacity') { app.ui.heatOpacity = parseFloat(t.value); editor.requestRender(); return; }
    if (e.type === 'click') {
      if (t.id === 'btnRemoveAp') { app.checkpoint(); app.project.aps = []; app.changed(); }
      if (t.id === 'btnApAtOnt') {
        const ont = app.project.ont;
        app.checkpoint();
        app.project.aps = [{ id: uid('ap'), floorId: ont.floorId, x: ont.x, y: ont.y }];
        app.changed();
      }
      return;
    }
    if (e.type !== 'change') return;
    if (t.id === 'covShow') { app.ui.showHeatmap = t.checked; editor.requestRender(); app.saveSoon(); }
    else if (t.id === 'covOutside') { app.ui.heatOutside = t.checked; invalidate(); }
    else if (t.id === 'covFloor') app.setActiveFloor(t.value);
    else if (t.id === 'apFloor') {
      // keep the building-wide position, move to the other floor's frame
      const ap = app.project.aps[0];
      const from = app.project.floors.find((f) => f.id === ap.floorId);
      const to = app.project.floors.find((f) => f.id === t.value);
      app.checkpoint();
      ap.x = ap.x - from.origin.x + to.origin.x;
      ap.y = ap.y - from.origin.y + to.origin.y;
      ap.floorId = to.id;
      app.changed();
    } else if (t.id === 'covBand') {
      app.checkpoint();
      params().band = t.value;
      params().pl0 = BAND_PL0[t.value];
      app.changed();
    } else if (t.dataset.param) {
      const v = parseFloat(t.value);
      if (!Number.isFinite(v)) return;
      if (t.dataset.param === 'cellSize' && v < 0.1) return;
      app.checkpoint();
      params()[t.dataset.param] = v;
      app.changed();
    }
  }

  return { invalidate, recompute, renderPanel, onPanelEvent, onCanvasPick, placeAp, hoverInfo, apsGlobal, state: cov };
}

