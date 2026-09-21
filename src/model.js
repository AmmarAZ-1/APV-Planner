// Project data model. All geometry is stored in meters in each floor's local frame
// (origin = top-left of that floor's plan image, +x right, +y down).
// A floor's `origin` is the local point that maps to the building-wide (0,0),
// which lets plans drawn from differently-cropped images line up vertically.

import { defaultMaterialDb, MATERIAL_BY_ID } from './materials.js';

export const DEFAULT_PPM = 50; // pixels per meter assumed before a floor is calibrated
export const DEFAULT_STOREY_HEIGHT = 2.7;

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

export function createProject() {
  return {
    version: 1,
    name: 'My house',
    floors: [createFloor('Ground floor')],
    ont: null, // { floorId, x, y } local meters
    materials: defaultMaterialDb(),
  };
}

export function createFloor(label) {
  return {
    id: uid('floor'),
    label,
    storeyHeight: DEFAULT_STOREY_HEIGHT,
    image: null, // { name, width, height } — the pixels live in the image store, not in the model
    scale: { pxPerMeter: DEFAULT_PPM, calibrated: false, reference: null },
    origin: { x: 0, y: 0 },
    walls: [],
  };
}

/** z-position (m) of a floor's plane = sum of storey heights of the floors below it. */
export function floorZ(project, index) {
  let z = 0;
  for (let i = 0; i < index; i++) z += project.floors[i].storeyHeight;
  return z;
}

export function wallDb(project, material, customDb) {
  if (material === 'other') return Number.isFinite(customDb) ? customDb : project.materials.other;
  return project.materials[material] ?? MATERIAL_BY_ID[material]?.db ?? 0;
}

export function addWall(project, floor, x1, y1, x2, y2, material, customDb) {
  const wall = {
    id: uid('w'),
    x1, y1, x2, y2,
    material,
    attenuationDb: wallDb(project, material, customDb),
  };
  floor.walls.push(wall);
  return wall;
}

/** Keep per-wall dB in sync after a material default changes (custom "other" walls keep their own value). */
export function applyMaterialDefaults(project) {
  for (const f of project.floors)
    for (const w of f.walls)
      if (w.material !== 'other') w.attenuationDb = wallDb(project, w.material);
}

/**
 * Multiply every length on a floor by `factor`. Used when the scale is (re)calibrated so
 * geometry stays glued to the image pixels it was traced on.
 */
export function rescaleFloor(project, floor, factor) {
  for (const w of floor.walls) {
    w.x1 *= factor; w.y1 *= factor; w.x2 *= factor; w.y2 *= factor;
  }
  floor.origin.x *= factor;
  floor.origin.y *= factor;
  if (project.ont && project.ont.floorId === floor.id) {
    project.ont.x *= factor;
    project.ont.y *= factor;
  }
}

export function wallLength(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The inspectable, JSON-serialisable model.
 * @param {(floor) => string|null} imageUrlFor  blob URL for on-screen export, data URL for a portable file
 */
export function toModelJSON(project, imageUrlFor = () => null) {
  const ontIndex = project.ont ? project.floors.findIndex((f) => f.id === project.ont.floorId) : -1;
  return {
    format: 'apv-planner/model',
    version: 1,
    name: project.name,
    units: 'meters',
    coordinateFrame:
      'Wall and ONT x/y are in each floor\'s local frame (plan image top-left, +y down). ' +
      'Building-wide x/y = local - floor.origin. zHeight is the floor plane elevation.',
    materials: { ...project.materials },
    floors: project.floors.map((f, i) => ({
      label: f.label,
      zHeight: r3(floorZ(project, i)),
      storeyHeight: f.storeyHeight,
      imageUrl: imageUrlFor(f),
      image: f.image ? { ...f.image } : null,
      scale: { pxPerMeter: r3(f.scale.pxPerMeter), calibrated: f.scale.calibrated, reference: f.scale.reference },
      origin: { x: r3(f.origin.x), y: r3(f.origin.y) },
      walls: f.walls.map((w) => ({
        x1: r3(w.x1), y1: r3(w.y1), x2: r3(w.x2), y2: r3(w.y2),
        material: w.material,
        attenuationDb: w.attenuationDb,
      })),
    })),
    ont:
      ontIndex >= 0
        ? { floorIndex: ontIndex, x: r3(project.ont.x), y: r3(project.ont.y), z: r3(floorZ(project, ontIndex)) }
        : null,
  };
}

/** Parse a model JSON (as produced by toModelJSON) back into a project. Returns { project, imageUrls }. */
export function fromModelJSON(json) {
  if (!json || !Array.isArray(json.floors)) throw new Error('Not an APV Planner model: missing "floors" array');
  const project = createProject();
  project.name = json.name || 'Imported house';
  if (json.materials) Object.assign(project.materials, json.materials);
  const imageUrls = {};
  project.floors = json.floors.map((jf, i) => {
    const f = createFloor(jf.label || `Floor ${i + 1}`);
    f.storeyHeight = num(jf.storeyHeight, DEFAULT_STOREY_HEIGHT);
    if (jf.scale) {
      f.scale.pxPerMeter = num(jf.scale.pxPerMeter, DEFAULT_PPM);
      f.scale.calibrated = !!jf.scale.calibrated;
      f.scale.reference = jf.scale.reference ?? null;
    }
    if (jf.origin) f.origin = { x: num(jf.origin.x, 0), y: num(jf.origin.y, 0) };
    f.image = jf.image ? { ...jf.image } : null;
    if (jf.imageUrl && /^(data:|https?:)/.test(jf.imageUrl)) imageUrls[f.id] = jf.imageUrl;
    else f.image = null;
    for (const w of jf.walls || []) {
      const mat = MATERIAL_BY_ID[w.material] ? w.material : 'other';
      addWall(project, f, num(w.x1), num(w.y1), num(w.x2), num(w.y2), mat,
        mat === 'other' ? num(w.attenuationDb, project.materials.other) : undefined);
    }
    return f;
  });
  if (json.ont && project.floors[json.ont.floorIndex]) {
    project.ont = { floorId: project.floors[json.ont.floorIndex].id, x: num(json.ont.x), y: num(json.ont.y) };
  }
  return { project, imageUrls };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
