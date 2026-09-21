// App controller: owns the project state, undo history, images, sidebars and dialogs.

import { createCoverage, ensureCoverageState } from './coverage.js';
import { Editor } from './editor.js';
import { MATERIALS, MATERIAL_BY_ID } from './materials.js';
import {
  addWall, applyMaterialDefaults, createFloor, createProject, DEFAULT_PPM, floorZ,
  fromModelJSON, rescaleFloor, toModelJSON, wallLength,
} from './model.js';
import { renderPlanImage, sampleHouse, SAMPLE_PPM } from './sample.js';
import { loadLocal, saveLocal } from './storage.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

const TOOL_HINTS = {
  select: 'Click a wall to select it · drag a corner to move it · drag empty space to pan · Del deletes · wheel zooms',
  wall: 'Click to add corners · Shift locks to 45° · double-click, Enter or right-click ends the run · snaps to corners and walls',
  rect: 'Drag to draw a rectangular room (adds 4 walls)',
  opening: 'Click two points along an existing wall to cut a door or window into it',
  scale: 'Click two points a known distance apart (e.g. the ends of a scale bar or a wall you have measured)',
  origin: 'Click a feature visible on every floor (e.g. an outside corner). Floors are stacked on these points.',
  ont: 'Click where the ONT / fibre terminal is',
  ap: 'Click to place the AP (click again or drag it with Select to move) · hover the plan to read RSSI',
};
const TOOL_KEYS = { v: 'select', w: 'wall', r: 'room', o: 'opening', s: 'scale', a: 'origin', n: 'ont', p: 'ap' };

const app = {
  project: createProject(),
  activeFloorId: null,
  images: new Map(), // floorId -> { el, url, blob, width, height }
  ui: {
    material: 'drywall',
    openingMaterial: 'wood_door',
    customDb: 6,
    gridSnap: false,
    gridStep: 0.25,
    showGhost: true,
    showGrid: false,
    imageOpacity: 0.85,
    rightTab: 'plan',
    showHeatmap: true,
    heatOpacity: 0.6,
    heatOutside: false,
  },
  undoStack: [],
  redoStack: [],
  selectedWallId: null,

  get activeFloor() {
    return this.project.floors.find((f) => f.id === this.activeFloorId) || this.project.floors[0];
  },

  checkpoint() {
    this.undoStack.push(JSON.stringify({ project: this.project, activeFloorId: this.activeFloorId }));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  },

  /** Notify of a model change. `light` = geometry is mid-drag, skip sidebar rebuild + autosave. */
  changed({ light = false } = {}) {
    coverage.invalidate();
    editor.requestRender();
    if (light) return;
    renderAll();
    scheduleSave();
  },

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3200);
  },

  requestScale(a, b) { openScaleDialog(a, b); },

  deleteWall(id) {
    const f = this.activeFloor;
    const i = f.walls.findIndex((w) => w.id === id);
    if (i < 0) return;
    this.checkpoint();
    f.walls.splice(i, 1);
    if (editor.selectedWallId === id) editor.select(null);
    this.changed();
  },

  onSelect(id) {
    this.selectedWallId = id;
    renderRight();
    if (id) $(`#rightPanel tr[data-wall="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  },

  onHover(p) {
    const info = p ? coverage.hoverInfo(p) : '';
    $('#hudPos').textContent = p ? `${info ? info + '   ·   ' : ''}x ${fmt(p.x)} m   y ${fmt(p.y)} m` : '';
  },

  onCanvasPick(raw) { return coverage.onCanvasPick(raw); },
  onToolDown(tool, raw) { return tool === 'ap' ? coverage.placeAp(raw) : null; },
  setActiveFloor(id) { setActiveFloor(id); },
  saveSoon() { scheduleSave(); },
};

const editor = new Editor($('#canvas'), app);
const coverage = createCoverage(app, editor);
window.apv = { app, editor, coverage }; // handy for debugging from the console

// ---------------------------------------------------------------- undo / redo
function restore(snapshot) {
  const s = JSON.parse(snapshot);
  app.project = s.project;
  ensureCoverageState(app.project);
  app.activeFloorId = s.activeFloorId;
  editor.select(null);
  app.changed();
}
function undo() {
  if (!app.undoStack.length) return;
  app.redoStack.push(JSON.stringify({ project: app.project, activeFloorId: app.activeFloorId }));
  restore(app.undoStack.pop());
}
function redo() {
  if (!app.redoStack.length) return;
  app.undoStack.push(JSON.stringify({ project: app.project, activeFloorId: app.activeFloorId }));
  restore(app.redoStack.pop());
}

// ---------------------------------------------------------------- images
async function setFloorImage(floor, blob, name) {
  const url = URL.createObjectURL(blob);
  const el = new Image();
  // onload rather than decode(): decode() can stay pending while the tab is hidden
  await new Promise((res, rej) => { el.onload = res; el.onerror = () => rej(new Error('image failed to load')); el.src = url; });
  app.images.set(floor.id, { el, url, blob, width: el.naturalWidth, height: el.naturalHeight });
  floor.image = { name: name || 'plan', width: el.naturalWidth, height: el.naturalHeight };
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- persistence
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const images = {};
    for (const f of app.project.floors) {
      const img = app.images.get(f.id);
      if (img) images[f.id] = img.blob;
    }
    saveLocal({ project: app.project, activeFloorId: app.activeFloorId, ui: app.ui }, images);
  }, 600);
}

async function loadProject(project, imageBlobs = {}, activeFloorId = null) {
  app.images.clear();
  ensureCoverageState(project);
  app.project = project;
  app.activeFloorId = activeFloorId && project.floors.some((f) => f.id === activeFloorId) ? activeFloorId : project.floors[0].id;
  for (const f of project.floors) {
    const blob = imageBlobs[f.id];
    if (blob) {
      try { await setFloorImage(f, blob, f.image?.name); } catch { f.image = null; }
    } else {
      f.image = null;
    }
  }
  app.undoStack.length = 0;
  app.redoStack.length = 0;
  editor.select(null);
  editor.setTool('select');
  renderAll();
  editor.fit();
  scheduleSave();
}

async function importModelJSON(json) {
  const { project, imageUrls } = fromModelJSON(json);
  const blobs = {};
  for (const [id, url] of Object.entries(imageUrls)) {
    try { blobs[id] = await (await fetch(url)).blob(); } catch { /* image unavailable */ }
  }
  await loadProject(project, blobs);
}

async function modelWithEmbeddedImages() {
  const dataUrls = {};
  for (const f of app.project.floors) {
    const img = app.images.get(f.id);
    if (img) dataUrls[f.id] = await blobToDataUrl(img.blob);
  }
  return toModelJSON(app.project, (f) => dataUrls[f.id] || null);
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function loadSample(kind) {
  const s = sampleHouse();
  const project = createProject();
  project.name = s.name;
  const blobs = {};
  project.floors = [];
  for (const sf of s.floors) {
    const f = createFloor(sf.label);
    f.storeyHeight = sf.storeyHeight;
    blobs[f.id] = await renderPlanImage(sf, `${s.name} — ${sf.label}`);
    f.image = { name: `${sf.label}.png` };
    if (kind === 'traced') {
      f.scale = { pxPerMeter: SAMPLE_PPM, calibrated: true, reference: { p1: { x: 60, y: 660 }, p2: { x: 360, y: 660 }, meters: 5 } };
      for (const [x1, y1, x2, y2, m] of sf.walls) addWall(project, f, x1, y1, x2, y2, m);
    }
    project.floors.push(f);
  }
  if (kind === 'traced') project.ont = { floorId: project.floors[s.ont.floorIndex].id, ...{ x: s.ont.x, y: s.ont.y } };
  await loadProject(project, blobs);
  app.toast(kind === 'traced'
    ? 'Sample house loaded. Switch floors on the left.'
    : 'Plan images loaded. Start with the Scale tool: the bar at the bottom is 5 m.');
}

// ---------------------------------------------------------------- scale dialog
let pendingScale = null;
function openScaleDialog(a, b) {
  const f = app.activeFloor;
  const meters = Math.hypot(b.x - a.x, b.y - a.y);
  pendingScale = { f, a, b, meters, ppm: f.scale.pxPerMeter };
  $('#scalePx').textContent = (meters * f.scale.pxPerMeter).toFixed(1);
  $('#scaleMeters').value = '';
  $('#scaleDialog').showModal();
  $('#scaleMeters').focus();
}
$('#scaleMeters').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#scaleDialog form').requestSubmit(); }
});
$('#scaleDialog form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#scaleDialog').close();
  const real = parseFloat($('#scaleMeters').value);
  if (!pendingScale || !(real > 0)) return;
  const { f, a, b, meters, ppm } = pendingScale;
  pendingScale = null;
  const factor = real / meters; // every stored length on this floor scales by this
  app.checkpoint();
  rescaleFloor(app.project, f, factor);
  f.scale = {
    pxPerMeter: ppm / factor,
    calibrated: true,
    reference: { p1: { x: a.x * ppm, y: a.y * ppm }, p2: { x: b.x * ppm, y: b.y * ppm }, meters: real },
  };
  editor.view.s /= factor; // keep the image on screen where it was
  app.changed();
  app.toast(`Scale set: ${(ppm / factor).toFixed(1)} px/m on ${f.label}`);
});

// ---------------------------------------------------------------- rendering: left panel
function renderFloorList() {
  const list = $('#floorList');
  const floors = app.project.floors;
  list.innerHTML = floors.map((f, i) => `
    <li class="floor-item ${f.id === app.activeFloor.id ? 'active' : ''}" data-floor="${f.id}">
      <div class="meta">
        <div class="name">${esc(f.label)}</div>
        <div class="sub">z = ${fmt(floorZ(app.project, i))} m · ${f.walls.length} walls
          ${f.image ? (f.scale.calibrated ? '<span class="badge ok">scaled</span>' : '<span class="badge warn">no scale</span>') : '<span class="badge">drawn</span>'}
          ${app.project.ont?.floorId === f.id ? '<span class="badge">ONT</span>' : ''}</div>
      </div>
      <div class="btns">
        <button class="icon small" data-act="up" title="Move up" ${i === floors.length - 1 ? 'disabled' : ''}>▲</button>
        <button class="icon small" data-act="down" title="Move down" ${i === 0 ? 'disabled' : ''}>▼</button>
      </div>
    </li>`).join('');
}

function renderFloorDetails() {
  const f = app.activeFloor;
  const i = app.project.floors.indexOf(f);
  const img = app.images.get(f.id);
  $('#floorDetails').innerHTML = `
    <div class="section-head"><h2>Floor settings</h2>
      <button class="small danger" id="btnDelFloor" ${app.project.floors.length < 2 ? 'disabled' : ''}>Delete floor</button></div>
    <label class="field"><span>Label</span><input id="fLabel" value="${esc(f.label)}" /></label>
    <label class="field"><span>Storey height (m)</span><input id="fHeight" type="number" step="0.05" min="1.5" max="10" value="${f.storeyHeight}" /></label>
    <div class="field"><span>Floor plane z</span><span class="mono">${fmt(floorZ(app.project, i))} m</span></div>

    <h2 style="margin-top:14px">Plan image</h2>
    <div class="row">
      <label class="button small">${img ? 'Replace image…' : 'Upload image…'}<input id="fImage" type="file" accept="image/*" hidden /></label>
      ${img ? '<button class="small danger" id="btnRemoveImage">Remove</button>' : ''}
    </div>
    ${img ? `
      <p class="muted tiny">${esc(f.image?.name || '')} · ${img.width}×${img.height}px</p>
      <label class="field"><span>Image opacity</span><input id="fOpacity" type="range" min="0.1" max="1" step="0.05" value="${app.ui.imageOpacity}" /></label>`
    : '<p class="muted tiny">No image: draw on the metric grid instead, or type walls in on the right.</p>'}

    <h2 style="margin-top:14px">Scale</h2>
    ${f.scale.calibrated
      ? `<p class="tiny"><span class="badge ok">calibrated</span> ${fmt(f.scale.pxPerMeter, 1)} px/m${f.scale.reference ? ` from a ${f.scale.reference.meters} m reference` : ''}</p>`
      : img
        ? `<p class="tiny"><span class="badge warn">not calibrated</span> assuming ${DEFAULT_PPM} px/m. Use the Scale tool before tracing.</p>`
        : '<p class="tiny muted">Grid is in meters, so no calibration is needed.</p>'}
    <div class="row"><button class="small" id="btnScaleTool">⟷ Set scale</button><button class="small" id="btnFit">Fit view</button></div>

    <h2 style="margin-top:14px">Alignment</h2>
    <p class="muted tiny">Origin at local (${fmt(f.origin.x)}, ${fmt(f.origin.y)}) m. Use <b>Align</b> to click the same physical spot on every floor so the floors stack correctly.</p>
    <label class="row"><input type="checkbox" id="fGhost" ${app.ui.showGhost ? 'checked' : ''}/> Show floor below as a dashed overlay</label>
    <label class="row"><input type="checkbox" id="fGrid" ${app.ui.showGrid ? 'checked' : ''}/> Show 1 m grid over the image</label>
  `;
}

// ---------------------------------------------------------------- rendering: right panel
function materialOptions(selected) {
  return MATERIALS.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
}

function renderRight() {
  const el = $('#rightPanel');
  const tabs = `<div class="tabs" role="tablist">
      <button role="tab" data-tab="plan" class="${app.ui.rightTab === 'plan' ? 'active' : ''}">Plan</button>
      <button role="tab" data-tab="coverage" class="${app.ui.rightTab === 'coverage' ? 'active' : ''}">Coverage</button>
    </div>`;
  if (app.ui.rightTab === 'coverage') {
    el.innerHTML = tabs + '<div id="tabBody"></div>';
    coverage.renderPanel($('#tabBody'));
    return;
  }
  renderPlanPanel(el, tabs);
}

function renderPlanPanel(el, tabs) {
  const f = app.activeFloor;
  const p = app.project;
  const sel = f.walls.find((w) => w.id === app.selectedWallId);
  const ont = p.ont;
  const ontFloorIdx = ont ? p.floors.findIndex((x) => x.id === ont.floorId) : -1;
  el.innerHTML = tabs + `
    <section>
      <div class="section-head"><h2>Walls on ${esc(f.label)} (${f.walls.length})</h2>
        ${f.walls.length ? '<button class="small danger" id="btnClearWalls">Clear all</button>' : ''}</div>
      ${f.walls.length ? `
      <div class="wall-table-wrap"><table>
        <thead><tr><th>#</th><th>Material</th><th>dB</th><th>Len</th><th></th></tr></thead>
        <tbody>${f.walls.map((w, i) => `
          <tr class="clickable ${w.id === app.selectedWallId ? 'selected' : ''}" data-wall="${w.id}">
            <td>${i + 1}</td>
            <td><span class="swatch" style="background:${MATERIAL_BY_ID[w.material]?.color}"></span><select data-field="material">${materialOptions(w.material)}</select></td>
            <td>${w.material === 'other'
              ? `<input type="number" step="0.5" data-field="db" value="${w.attenuationDb}" />`
              : `<span class="mono">${w.attenuationDb}</span>`}</td>
            <td class="mono">${fmt(wallLength(w), 1)}</td>
            <td><button class="icon small danger" data-act="del" title="Delete wall">✕</button></td>
          </tr>`).join('')}
        </tbody></table></div>` : '<p class="muted tiny">No walls yet. Use the Wall or Room tool, or add them by coordinates below.</p>'}
    </section>

    ${sel ? `
    <section>
      <h2>Selected wall</h2>
      <div class="coords" id="selCoords">
        ${['x1', 'y1', 'x2', 'y2'].map((k) => `<label><span>${k} (m)</span><input type="number" step="0.01" data-k="${k}" value="${sel[k].toFixed(3)}" /></label>`).join('')}
      </div>
      <p class="muted tiny">Length ${fmt(wallLength(sel))} m · ${esc(MATERIAL_BY_ID[sel.material]?.label)} · ${sel.attenuationDb} dB</p>
    </section>` : ''}

    <section>
      <h2>Add wall by coordinates</h2>
      <p class="muted tiny">Meters, in this floor's frame (x right, y down from the image's top-left).</p>
      <form id="formWall">
        <div class="coords">
          ${['x1', 'y1', 'x2', 'y2'].map((k) => `<label><span>${k}</span><input name="${k}" type="number" step="0.01" required /></label>`).join('')}
        </div>
        <div class="row"><select name="material">${materialOptions(app.ui.material)}</select><button class="small primary">Add wall</button></div>
      </form>
      <h2 style="margin-top:12px">Add rectangular room</h2>
      <form id="formRoom">
        <div class="coords">
          ${[['x', 'x'], ['y', 'y'], ['w', 'width'], ['h', 'depth']].map(([k, l]) => `<label><span>${l}</span><input name="${k}" type="number" step="0.01" required /></label>`).join('')}
        </div>
        <div class="row"><select name="material">${materialOptions(app.ui.material)}</select><button class="small primary">Add room</button></div>
      </form>
    </section>

    <section>
      <h2>ONT</h2>
      ${ont && ontFloorIdx >= 0 ? `
        <p class="tiny">On <b>${esc(p.floors[ontFloorIdx].label)}</b> (floor index ${ontFloorIdx})<br/>
        <span class="mono">x ${fmt(ont.x)} m · y ${fmt(ont.y)} m · z ${fmt(floorZ(p, ontFloorIdx))} m</span></p>
        <div class="row"><button class="small" data-tool-btn="ont">Move</button><button class="small danger" id="btnClearOnt">Remove</button></div>`
      : `<p class="muted tiny">Not placed yet.</p><button class="small" data-tool-btn="ont">▣ Place ONT</button>`}
    </section>

    <section>
      <h2>Material defaults (dB per wall crossed)</h2>
      <table><tbody>
        ${MATERIALS.map((m) => `<tr><td><span class="swatch" style="background:${m.color}"></span>${esc(m.label)}</td>
          <td><input type="number" step="0.5" min="0" data-mat="${m.id}" value="${p.materials[m.id]}" /></td></tr>`).join('')}
      </tbody></table>
      <p class="muted tiny">Changing a default updates every wall of that material. "Other" walls keep their own per-wall value. Values are for 2.4 GHz; see docs/LITERATURE.md.</p>
    </section>
  `;
}

function renderToolbar() {
  document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === editor.tool));
  const t = editor.tool;
  let html = '';
  if (t === 'wall' || t === 'rect') {
    html += `<label>Material <select id="optMaterial">${materialOptions(app.ui.material)}</select></label>`;
  }
  if (t === 'opening') {
    html += `<label>Opening is <select id="optOpening">${materialOptions(app.ui.openingMaterial)}</select></label>`;
  }
  if ((t === 'wall' || t === 'rect') && app.ui.material === 'other' || t === 'opening' && app.ui.openingMaterial === 'other') {
    html += `<label>dB <input id="optCustomDb" type="number" step="0.5" value="${app.ui.customDb}" /></label>`;
  }
  if (['wall', 'rect', 'origin'].includes(t)) {
    html += `<label><input type="checkbox" id="optGrid" ${app.ui.gridSnap ? 'checked' : ''}/> Snap to ${app.ui.gridStep} m grid</label>`;
  }
  $('#toolOptions').innerHTML = html;
  $('#hudHint').textContent = TOOL_HINTS[t] || '';
}

function renderAll() {
  $('#projectName').value = app.project.name;
  $('#btnUndo').disabled = !app.undoStack.length;
  $('#btnRedo').disabled = !app.redoStack.length;
  renderFloorList();
  renderFloorDetails();
  renderRight();
  renderToolbar();
}

function setTool(t) {
  editor.setTool(t);
  renderToolbar();
}

function setActiveFloor(id) {
  if (id === app.activeFloorId) return;
  app.activeFloorId = id;
  editor.select(null);
  editor.setTool(editor.tool);
  renderAll();
  editor.fit();
}

// ---------------------------------------------------------------- events
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});
$('#toolOptions').addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'optMaterial') app.ui.material = e.target.value;
  if (id === 'optOpening') app.ui.openingMaterial = e.target.value;
  if (id === 'optCustomDb') app.ui.customDb = parseFloat(e.target.value) || 0;
  if (id === 'optGrid') app.ui.gridSnap = e.target.checked;
  renderToolbar();
});

$('#floorList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-floor]');
  if (!li) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const floors = app.project.floors;
  const i = floors.findIndex((f) => f.id === li.dataset.floor);
  if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i + 1 : i - 1;
    if (j < 0 || j >= floors.length) return;
    app.checkpoint();
    [floors[i], floors[j]] = [floors[j], floors[i]];
    app.changed();
    return;
  }
  setActiveFloor(li.dataset.floor);
});

$('#btnAddFloor').addEventListener('click', () => {
  app.checkpoint();
  const n = app.project.floors.length;
  const f = createFloor(n === 0 ? 'Ground floor' : n === 1 ? 'First floor' : `Floor ${n}`);
  app.project.floors.push(f);
  app.activeFloorId = f.id;
  editor.select(null);
  app.changed();
  editor.fit();
});

$('#leftPanel').addEventListener('change', async (e) => {
  const f = app.activeFloor;
  const t = e.target;
  if (t.id === 'fLabel') { app.checkpoint(); f.label = t.value.trim() || f.label; app.changed(); }
  if (t.id === 'fHeight') {
    const v = parseFloat(t.value);
    if (v > 0) { app.checkpoint(); f.storeyHeight = v; app.changed(); }
  }
  if (t.id === 'fGhost') { app.ui.showGhost = t.checked; editor.requestRender(); }
  if (t.id === 'fGrid') { app.ui.showGrid = t.checked; editor.requestRender(); }
  if (t.id === 'fImage' && t.files[0]) {
    const file = t.files[0];
    try {
      await setFloorImage(f, file, file.name);
    } catch {
      app.toast('Could not read that image');
      return;
    }
    if (!f.scale.calibrated) app.toast('Image loaded. Next: set the scale with two points a known distance apart.');
    app.changed();
    editor.fit();
    if (!f.scale.calibrated) setTool('scale');
  }
});
$('#leftPanel').addEventListener('input', (e) => {
  if (e.target.id === 'fOpacity') { app.ui.imageOpacity = parseFloat(e.target.value); editor.requestRender(); }
});
$('#leftPanel').addEventListener('click', (e) => {
  const id = e.target.id;
  const f = app.activeFloor;
  if (id === 'btnDelFloor') {
    if (f.walls.length && !confirm(`Delete "${f.label}" and its ${f.walls.length} walls?`)) return;
    app.checkpoint();
    const floors = app.project.floors;
    const i = floors.indexOf(f);
    floors.splice(i, 1);
    if (app.project.ont?.floorId === f.id) app.project.ont = null;
    app.project.aps = app.project.aps.filter((ap) => ap.floorId !== f.id);
    app.activeFloorId = floors[Math.max(0, i - 1)].id;
    editor.select(null);
    app.changed();
    editor.fit();
  }
  if (id === 'btnRemoveImage') {
    app.images.delete(f.id);
    f.image = null;
    app.changed();
  }
  if (id === 'btnScaleTool') setTool('scale');
  if (id === 'btnFit') editor.fit();
});

$('#rightPanel').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { app.ui.rightTab = tab.dataset.tab; renderRight(); scheduleSave(); return; }
  const tb = e.target.closest('[data-tool-btn]');
  if (tb) { setTool(tb.dataset.toolBtn); return; }
  if (app.ui.rightTab === 'coverage') { coverage.onPanelEvent(e); return; }
  if (e.target.id === 'btnClearOnt') { app.checkpoint(); app.project.ont = null; app.changed(); return; }
  if (e.target.id === 'btnClearWalls') {
    const f = app.activeFloor;
    if (!confirm(`Delete all ${f.walls.length} walls on ${f.label}?`)) return;
    app.checkpoint(); f.walls = []; editor.select(null); app.changed(); return;
  }
  const row = e.target.closest('tr[data-wall]');
  if (!row) return;
  if (e.target.closest('[data-act="del"]')) { app.deleteWall(row.dataset.wall); return; }
  if (e.target.closest('select, input')) return;
  editor.select(row.dataset.wall);
});

$('#rightPanel').addEventListener('input', (e) => {
  if (app.ui.rightTab === 'coverage') coverage.onPanelEvent(e);
});
$('#rightPanel').addEventListener('change', (e) => {
  if (app.ui.rightTab === 'coverage') { coverage.onPanelEvent(e); return; }
  const t = e.target;
  const f = app.activeFloor;
  const row = t.closest('tr[data-wall]');
  if (row && t.dataset.field) {
    const w = f.walls.find((x) => x.id === row.dataset.wall);
    app.checkpoint();
    if (t.dataset.field === 'material') {
      w.material = t.value;
      w.attenuationDb = w.material === 'other' ? app.project.materials.other : app.project.materials[w.material];
    } else if (t.dataset.field === 'db') {
      w.attenuationDb = parseFloat(t.value) || 0;
    }
    app.changed();
    return;
  }
  if (t.dataset.k) {
    const w = f.walls.find((x) => x.id === app.selectedWallId);
    const v = parseFloat(t.value);
    if (w && Number.isFinite(v)) { app.checkpoint(); w[t.dataset.k] = v; app.changed(); }
    return;
  }
  if (t.dataset.mat) {
    const v = parseFloat(t.value);
    if (!Number.isFinite(v)) return;
    app.checkpoint();
    app.project.materials[t.dataset.mat] = v;
    applyMaterialDefaults(app.project);
    app.changed();
  }
});

$('#rightPanel').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const n = (k) => parseFloat(fd[k]);
  const f = app.activeFloor;
  const custom = fd.material === 'other' ? app.project.materials.other : undefined;
  if (e.target.id === 'formWall') {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(n);
    if (Math.hypot(x2 - x1, y2 - y1) < 0.01) { app.toast('Wall must be longer than 1 cm'); return; }
    app.checkpoint();
    const w = addWall(app.project, f, x1, y1, x2, y2, fd.material, custom);
    app.changed();
    editor.select(w.id);
  } else if (e.target.id === 'formRoom') {
    const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(n);
    if (!(w > 0 && h > 0)) { app.toast('Width and depth must be positive'); return; }
    app.checkpoint();
    const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
    for (let i = 0; i < 4; i++) addWall(app.project, f, ...pts[i], ...pts[i + 1], fd.material, custom);
    app.changed();
  }
});

$('#projectName').addEventListener('change', (e) => { app.project.name = e.target.value.trim() || 'My house'; scheduleSave(); });
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#btnNew').addEventListener('click', () => {
  if (!confirm('Start a new, empty project? (Save first if you want to keep this one.)')) return;
  loadProject(createProject());
});
$('#sampleSelect').addEventListener('change', async (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (v) await loadSample(v);
});
$('#fileOpen').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await importModelJSON(JSON.parse(await file.text()));
    app.toast(`Opened ${file.name}`);
  } catch (err) {
    app.toast(`Could not open: ${err.message}`);
  }
});
$('#btnSave').addEventListener('click', async () => {
  download(`${app.project.name.replace(/[^\w-]+/g, '_')}.apv.json`, JSON.stringify(await modelWithEmbeddedImages(), null, 2));
});
$('#btnJson').addEventListener('click', () => {
  const model = toModelJSON(app.project, (f) => app.images.get(f.id)?.url || null);
  $('#jsonView').textContent = JSON.stringify(model, null, 2);
  $('#jsonDialog').showModal();
});
$('#btnJsonClose').addEventListener('click', () => $('#jsonDialog').close());
$('#btnJsonCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#jsonView').textContent);
  app.toast('Model JSON copied');
});
$('#btnJsonDownload').addEventListener('click', () => $('#btnSave').click());

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select, dialog')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  if (tool) setTool(tool === 'room' ? 'rect' : tool);
});

// ---------------------------------------------------------------- boot
(async function boot() {
  const saved = await loadLocal();
  if (saved?.project?.project?.floors?.length) {
    Object.assign(app.ui, saved.project.ui || {});
    await loadProject(saved.project.project, saved.images || {}, saved.project.activeFloorId);
  } else {
    app.activeFloorId = app.project.floors[0].id;
    app.ui.gridSnap = true;
    renderAll();
    editor.fit();
  }
})();
