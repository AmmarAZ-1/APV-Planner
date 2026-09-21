// Canvas floor-plan editor: pan/zoom view, background image, and the drawing tools.
// World coordinates are meters in the active floor's local frame.

import { closestOnSegment, constrainAngle, dist } from './geometry.js';
import { MATERIAL_BY_ID } from './materials.js';
import { addWall, wallLength } from './model.js';

const SNAP_PX = 10;
const HIT_PX = 7;

export class Editor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} app  host: { project, activeFloor, images, checkpoint(), changed(), ui, ... }
   */
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.view = { s: 40, ox: 40, oy: 40 };
    this.tool = 'select';
    this.hover = null; // { x, y, snap }
    this.chain = null; // wall tool: [{x,y}, ...]
    this.rectStart = null;
    this.opening = null; // { wallId, t }
    this.scalePts = [];
    this.drag = null;
    this.spaceDown = false;
    this.selectedWallId = null;
    this.layers = []; // extra draw passes: fn(ctx, editor), drawn between plan and walls
    this.topLayers = []; // drawn above walls
    this._raf = 0;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.requestRender(); this.app.onHover?.(null); });
    canvas.addEventListener('dblclick', (e) => { e.preventDefault(); if (this.tool === 'wall') this.finishChain(); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    this.resize();
  }

  // ---------- view ----------
  get floor() { return this.app.activeFloor; }
  get ppm() { return this.floor.scale.pxPerMeter; }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.dpr = dpr;
    this.cssW = r.width;
    this.cssH = r.height;
    this.render();
  }

  toScreen(x, y) { return [x * this.view.s + this.view.ox, y * this.view.s + this.view.oy]; }
  toWorld(sx, sy) { return { x: (sx - this.view.ox) / this.view.s, y: (sy - this.view.oy) / this.view.s }; }

  eventWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.toWorld(e.clientX - r.left, e.clientY - r.top);
  }

  /** Fit the active floor's image (or its walls, or a 20 m square) into view. */
  fit() {
    const f = this.floor;
    let minX = 0, minY = 0, maxX = 20, maxY = 15;
    const img = this.app.images.get(f.id);
    if (img) {
      maxX = img.width / this.ppm; maxY = img.height / this.ppm;
    } else if (f.walls.length) {
      minX = minY = Infinity; maxX = maxY = -Infinity;
      for (const w of f.walls) {
        minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
        minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
      }
      minX -= 1; minY -= 1; maxX += 1; maxY += 1;
    }
    const pad = 30;
    const s = Math.min((this.cssW - 2 * pad) / (maxX - minX), (this.cssH - 2 * pad) / (maxY - minY));
    this.view.s = Math.max(2, s);
    this.view.ox = (this.cssW - (maxX - minX) * this.view.s) / 2 - minX * this.view.s;
    this.view.oy = (this.cssH - (maxY - minY) * this.view.s) / 2 - minY * this.view.s;
    this.render();
  }

  zoomAt(sx, sy, factor) {
    const w = this.toWorld(sx, sy);
    this.view.s = Math.min(2000, Math.max(1, this.view.s * factor));
    this.view.ox = sx - w.x * this.view.s;
    this.view.oy = sy - w.y * this.view.s;
    this.requestRender();
  }

  setTool(tool) {
    this.tool = tool;
    this.chain = null;
    this.rectStart = null;
    this.opening = null;
    this.scalePts = [];
    this.canvas.dataset.tool = tool;
    this.requestRender();
  }

  select(wallId) {
    this.selectedWallId = wallId;
    this.app.onSelect?.(wallId);
    this.requestRender();
  }

  // ---------- snapping & hit testing ----------
  vertices() {
    const out = [];
    for (const w of this.floor.walls) out.push({ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 });
    if (this.chain) out.push(...this.chain);
    return out;
  }

  nearestWall(p, px = HIT_PX) {
    let best = null;
    for (const w of this.floor.walls) {
      const c = closestOnSegment(p.x, p.y, w.x1, w.y1, w.x2, w.y2);
      if (c.d * this.view.s <= px && (!best || c.d < best.c.d)) best = { wall: w, c };
    }
    return best;
  }

  /** Snap a raw world point: vertex > 45°-constraint (shift) > point-on-wall > grid. */
  snap(p, e) {
    const tol = SNAP_PX / this.view.s;
    let bestV = null, bestD = tol;
    for (const v of this.vertices()) {
      const d = dist(p.x, p.y, v.x, v.y);
      if (d < bestD) { bestD = d; bestV = v; }
    }
    if (bestV) return { x: bestV.x, y: bestV.y, snap: 'vertex' };
    const anchor = this.chain?.[this.chain.length - 1] ?? this.rectStart;
    if (e?.shiftKey && anchor) return { ...constrainAngle(anchor.x, anchor.y, p.x, p.y), snap: 'angle' };
    const nw = this.nearestWall(p, SNAP_PX * 0.8);
    if (nw) return { x: nw.c.x, y: nw.c.y, snap: 'edge' };
    if (this.app.ui.gridSnap) {
      const g = this.app.ui.gridStep || 0.25;
      return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g, snap: 'grid' };
    }
    return { x: p.x, y: p.y, snap: null };
  }

  // ---------- pointer handling ----------
  onDown(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const raw = this.eventWorld(e);
    const panGesture = e.button === 1 || this.spaceDown || this.tool === 'pan' || (e.button === 2 && this.tool !== 'wall');
    if (panGesture) {
      this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.ox, oy: this.view.oy };
      return;
    }
    if (e.button === 2 && this.tool === 'wall') { this.finishChain(); return; }
    if (e.button !== 0) return;

    const f = this.floor;
    const app = this.app;
    switch (this.tool) {
      case 'select': {
        const picked = app.onCanvasPick?.(raw, e); // markers owned by other modules (e.g. APs)
        if (picked) { this.drag = picked; return; }
        // vertex drag (moves every wall endpoint sharing that vertex)
        const tol = HIT_PX / this.view.s;
        let vx = null, best = tol;
        for (const w of f.walls) {
          for (const k of [1, 2]) {
            const d = dist(w['x' + k], w['y' + k], raw.x, raw.y);
            if (d < best) { best = d; vx = { x: w['x' + k], y: w['y' + k] }; }
          }
        }
        if (vx) {
          const refs = [];
          for (const w of f.walls) for (const k of [1, 2]) if (dist(w['x' + k], w['y' + k], vx.x, vx.y) < 1e-6) refs.push([w, k]);
          app.checkpoint();
          this.drag = { type: 'vertex', refs, moved: false };
          return;
        }
        const hit = this.nearestWall(raw);
        if (hit) { this.select(hit.wall.id); return; }
        this.select(null);
        this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.ox, oy: this.view.oy };
        return;
      }
      case 'wall': {
        const p = this.snap(raw, e);
        if (!this.chain) { this.chain = [{ x: p.x, y: p.y }]; break; }
        const last = this.chain[this.chain.length - 1];
        if (dist(last.x, last.y, p.x, p.y) < 0.02) break;
        app.checkpoint();
        const w = addWall(app.project, f, last.x, last.y, p.x, p.y, app.ui.material, app.ui.customDb);
        this.select(w.id);
        const first = this.chain[0];
        if (this.chain.length > 1 && dist(first.x, first.y, p.x, p.y) < 1e-6) this.chain = null; // closed a loop
        else this.chain.push({ x: p.x, y: p.y });
        app.changed();
        break;
      }
      case 'rect': {
        const p = this.snap(raw, e);
        this.rectStart = { x: p.x, y: p.y };
        this.drag = { type: 'rect' };
        break;
      }
      case 'opening': {
        const hit = this.nearestWall(raw, SNAP_PX);
        if (!hit) { app.toast('Click on an existing wall to start the opening'); break; }
        if (!this.opening || this.opening.wallId !== hit.wall.id) {
          this.opening = { wallId: hit.wall.id, t: hit.c.t };
        } else {
          this.splitOpening(hit.wall, this.opening.t, hit.c.t);
          this.opening = null;
        }
        break;
      }
      case 'scale': {
        const p = this.snap(raw, e);
        this.scalePts.push({ x: p.x, y: p.y });
        if (this.scalePts.length === 2) {
          const [a, b] = this.scalePts;
          this.scalePts = [];
          if (dist(a.x, a.y, b.x, b.y) > 1e-6) app.requestScale(a, b);
        }
        break;
      }
      case 'ont': {
        app.checkpoint();
        app.project.ont = { floorId: f.id, x: raw.x, y: raw.y };
        app.changed();
        break;
      }
      case 'origin': {
        const p = this.snap(raw, e);
        app.checkpoint();
        f.origin = { x: p.x, y: p.y };
        app.changed();
        app.toast(`Alignment point set for ${f.label}. Click the same physical spot on every floor.`);
        break;
      }
      default: {
        const extra = app.onToolDown?.(this.tool, raw, e);
        if (extra) this.drag = extra;
      }
    }
    this.requestRender();
  }

  onMove(e) {
    const raw = this.eventWorld(e);
    const d = this.drag;
    if (d?.type === 'pan') {
      this.view.ox = d.ox + (e.clientX - d.sx);
      this.view.oy = d.oy + (e.clientY - d.sy);
    } else if (d?.type === 'vertex') {
      // snap to other vertices but not to the ones being dragged
      const saved = d.refs.map(([w, k]) => [w['x' + k], w['y' + k]]);
      d.refs.forEach(([w, k]) => { w['x' + k] = NaN; w['y' + k] = NaN; });
      const p = this.snap(raw, e);
      d.refs.forEach(([w, k], i) => { w['x' + k] = saved[i][0]; w['y' + k] = saved[i][1]; });
      for (const [w, k] of d.refs) { w['x' + k] = p.x; w['y' + k] = p.y; }
      d.moved = true;
      this.app.changed({ light: true });
    } else if (d?.move) {
      d.move(raw, e);
    }
    const snapped = ['wall', 'rect', 'scale', 'origin'].includes(this.tool) ? this.snap(raw, e) : { ...raw, snap: null };
    this.hover = snapped;
    this.app.onHover?.(raw);
    this.requestRender();
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.type === 'vertex') {
      if (d.moved) this.app.changed();
    } else if (d.type === 'rect' && this.rectStart) {
      const p = this.snap(this.eventWorld(e), e);
      const a = this.rectStart;
      this.rectStart = null;
      if (Math.abs(p.x - a.x) > 0.2 && Math.abs(p.y - a.y) > 0.2) {
        const app = this.app;
        app.checkpoint();
        const pts = [a, { x: p.x, y: a.y }, p, { x: a.x, y: p.y }, a];
        for (let i = 0; i < 4; i++) addWall(app.project, this.floor, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, app.ui.material, app.ui.customDb);
        app.changed();
      }
    } else if (d.up) {
      d.up(this.eventWorld(e), e);
    }
    this.requestRender();
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }

  onKey(e, down) {
    if (e.target.closest?.('input, textarea, select, dialog')) return;
    if (e.code === 'Space') { this.spaceDown = down; e.preventDefault(); return; }
    if (!down) return;
    if (e.key === 'Escape') {
      this.chain = null; this.rectStart = null; this.opening = null; this.scalePts = [];
      this.requestRender();
    } else if (e.key === 'Enter') {
      this.finishChain();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedWallId) {
      this.app.deleteWall(this.selectedWallId);
      e.preventDefault();
    }
  }

  finishChain() {
    this.chain = null;
    this.requestRender();
  }

  /** Split a wall into [0,a] + opening [a,b] + [b,1], the middle piece taking the current opening material. */
  splitOpening(wall, t1, t2) {
    const a = Math.min(t1, t2), b = Math.max(t1, t2);
    const L = wallLength(wall);
    if ((b - a) * L < 0.1) { this.app.toast('Opening too narrow (< 10 cm)'); return; }
    const app = this.app;
    const f = this.floor;
    app.checkpoint();
    const P = (t) => ({ x: wall.x1 + (wall.x2 - wall.x1) * t, y: wall.y1 + (wall.y2 - wall.y1) * t });
    const pa = P(a), pb = P(b);
    const idx = f.walls.indexOf(wall);
    f.walls.splice(idx, 1);
    const custom = wall.material === 'other' ? wall.attenuationDb : undefined;
    if (a * L > 0.01) addWall(app.project, f, wall.x1, wall.y1, pa.x, pa.y, wall.material, custom);
    const mid = addWall(app.project, f, pa.x, pa.y, pb.x, pb.y, app.ui.openingMaterial, app.ui.customDb);
    if ((1 - b) * L > 0.01) addWall(app.project, f, pb.x, pb.y, wall.x2, wall.y2, wall.material, custom);
    this.select(mid.id);
    app.changed();
  }

  // ---------- rendering ----------
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    const ctx = this.ctx;
    const f = this.floor;
    if (!f) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--canvas-bg').trim() || '#f4f5f7';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const img = this.app.images.get(f.id);
    if (img) {
      const [x0, y0] = this.toScreen(0, 0);
      ctx.globalAlpha = this.app.ui.imageOpacity ?? 0.85;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img.el, x0, y0, (img.width / this.ppm) * this.view.s, (img.height / this.ppm) * this.view.s);
      ctx.globalAlpha = 1;
    }
    if (!img || this.app.ui.showGrid) this.drawGrid(css);

    if (this.app.ui.showGhost) this.drawGhost();
    for (const layer of this.layers) layer(ctx, this);
    this.drawWalls();
    this.drawMarkers(css);
    for (const layer of this.topLayers) layer(ctx, this);
    this.drawToolPreview(css);
  }

  drawGrid(css) {
    const ctx = this.ctx;
    const tl = this.toWorld(0, 0), br = this.toWorld(this.cssW, this.cssH);
    const step = this.view.s < 12 ? 5 : 1;
    ctx.lineWidth = 1;
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      ctx.strokeStyle = x % 5 === 0 ? css.getPropertyValue('--grid-major') : css.getPropertyValue('--grid-minor');
      const [sx] = this.toScreen(x, 0);
      ctx.beginPath(); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, this.cssH); ctx.stroke();
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
      ctx.strokeStyle = y % 5 === 0 ? css.getPropertyValue('--grid-major') : css.getPropertyValue('--grid-minor');
      const [, sy] = this.toScreen(0, y);
      ctx.beginPath(); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(this.cssW, Math.round(sy) + 0.5); ctx.stroke();
    }
  }

  /** Faint dashed walls of the floor below, mapped through both floors' alignment origins. */
  drawGhost() {
    const floors = this.app.project.floors;
    const i = floors.indexOf(this.floor);
    const below = floors[i - 1];
    if (!below) return;
    const ctx = this.ctx;
    const dx = this.floor.origin.x - below.origin.x, dy = this.floor.origin.y - below.origin.y;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(120, 90, 200, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const w of below.walls) {
      const [ax, ay] = this.toScreen(w.x1 + dx, w.y1 + dy);
      const [bx, by] = this.toScreen(w.x2 + dx, w.y2 + dy);
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawWalls() {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    for (const w of this.floor.walls) {
      const m = MATERIAL_BY_ID[w.material] || MATERIAL_BY_ID.other;
      const [ax, ay] = this.toScreen(w.x1, w.y1);
      const [bx, by] = this.toScreen(w.x2, w.y2);
      if (w.id === this.selectedWallId) {
        ctx.strokeStyle = 'rgba(255, 196, 0, 0.75)';
        ctx.lineWidth = m.width + 8;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.width;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    if (['select', 'wall', 'opening'].includes(this.tool) && this.view.s > 8) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      for (const w of this.floor.walls) {
        for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
          const [sx, sy] = this.toScreen(x, y);
          ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
          ctx.strokeRect(sx - 2.5, sy - 2.5, 5, 5);
        }
      }
    }
  }

  drawMarkers(css) {
    const ctx = this.ctx;
    const app = this.app;
    const f = this.floor;
    // alignment origin
    if (this.tool === 'origin' || f.origin.x || f.origin.y) {
      const [sx, sy] = this.toScreen(f.origin.x, f.origin.y);
      ctx.strokeStyle = '#7a4fd6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.moveTo(sx - 13, sy); ctx.lineTo(sx + 13, sy);
      ctx.moveTo(sx, sy - 13); ctx.lineTo(sx, sy + 13);
      ctx.stroke();
    }
    // scale reference
    const ref = f.scale.reference;
    if (ref && f.scale.calibrated && this.tool === 'scale') {
      const k = 1 / f.scale.pxPerMeter;
      const [ax, ay] = this.toScreen(ref.p1.x * k, ref.p1.y * k);
      const [bx, by] = this.toScreen(ref.p2.x * k, ref.p2.y * k);
      ctx.save();
      ctx.setLineDash([8, 4]);
      ctx.strokeStyle = '#e0457b';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.restore();
      label(ctx, (ax + bx) / 2, (ay + by) / 2 - 12, `${ref.meters} m reference`, '#e0457b');
    }
    // ONT
    const ont = app.project.ont;
    if (ont) {
      const ontFloor = app.project.floors.find((fl) => fl.id === ont.floorId);
      let x = ont.x, y = ont.y, faint = false;
      if (ontFloor !== f && ontFloor) {
        x = ont.x - ontFloor.origin.x + f.origin.x;
        y = ont.y - ontFloor.origin.y + f.origin.y;
        faint = true;
      }
      const [sx, sy] = this.toScreen(x, y);
      ctx.globalAlpha = faint ? 0.35 : 1;
      ctx.fillStyle = '#111827';
      roundRect(ctx, sx - 17, sy - 10, 34, 20, 5);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ONT', sx, sy + 0.5);
      if (faint) label(ctx, sx, sy + 20, `on ${ontFloor.label}`, '#111827');
      ctx.globalAlpha = 1;
    }
  }

  drawToolPreview(css) {
    const ctx = this.ctx;
    const h = this.hover;
    const accent = '#ff7a00';
    if (this.chain && h) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      const last = this.chain[this.chain.length - 1];
      const [ax, ay] = this.toScreen(last.x, last.y);
      const [bx, by] = this.toScreen(h.x, h.y);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, (ax + bx) / 2, (ay + by) / 2 - 12, `${dist(last.x, last.y, h.x, h.y).toFixed(2)} m`, accent);
    }
    if (this.rectStart && h) {
      const [ax, ay] = this.toScreen(this.rectStart.x, this.rectStart.y);
      const [bx, by] = this.toScreen(h.x, h.y);
      ctx.strokeStyle = accent;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.setLineDash([]);
      label(ctx, (ax + bx) / 2, Math.min(ay, by) - 12,
        `${Math.abs(h.x - this.rectStart.x).toFixed(2)} × ${Math.abs(h.y - this.rectStart.y).toFixed(2)} m`, accent);
    }
    if (this.scalePts.length === 1 && h) {
      const a = this.scalePts[0];
      const [ax, ay] = this.toScreen(a.x, a.y);
      const [bx, by] = this.toScreen(h.x, h.y);
      ctx.strokeStyle = '#e0457b';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const px = dist(a.x, a.y, h.x, h.y) * this.ppm;
      label(ctx, (ax + bx) / 2, (ay + by) / 2 - 12, `${px.toFixed(0)} image px`, '#e0457b');
    }
    if (this.opening) {
      const w = this.floor.walls.find((x) => x.id === this.opening.wallId);
      if (w) {
        const t = this.opening.t;
        const [sx, sy] = this.toScreen(w.x1 + (w.x2 - w.x1) * t, w.y1 + (w.y2 - w.y1) * t);
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
        if (h) {
          const c = closestOnSegment(h.x, h.y, w.x1, w.y1, w.x2, w.y2);
          const [ex, ey] = this.toScreen(c.x, c.y);
          ctx.strokeStyle = accent; ctx.lineWidth = 6; ctx.globalAlpha = 0.6;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
          ctx.globalAlpha = 1;
          label(ctx, (sx + ex) / 2, (sy + ey) / 2 - 14, `${(Math.abs(c.t - t) * wallLength(w)).toFixed(2)} m opening`, accent);
        }
      }
    }
    if (h && h.snap && ['wall', 'rect', 'scale', 'origin'].includes(this.tool)) {
      const [sx, sy] = this.toScreen(h.x, h.y);
      ctx.strokeStyle = h.snap === 'vertex' ? '#16a34a' : accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (h.snap === 'vertex') ctx.rect(sx - 6, sy - 6, 12, 12);
      else ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

export function label(ctx, x, y, text, color) {
  ctx.font = '600 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  roundRect(ctx, x - w / 2, y - 9, w, 18, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
