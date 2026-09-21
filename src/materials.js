// Wall material catalogue. Default attenuations are single-pass penetration
// losses at 2.4 GHz for typical residential construction; see docs/LITERATURE.md
// for sources and ranges. Every value is editable in the UI.

export const MATERIALS = [
  { id: 'drywall', label: 'Drywall / gypsum', db: 3.5, color: '#7f95ad', width: 2 },
  { id: 'wood_door', label: 'Wood door', db: 4, color: '#b27a3a', width: 3 },
  { id: 'brick', label: 'Brick', db: 8, color: '#b5523b', width: 4 },
  { id: 'concrete', label: 'Reinforced concrete', db: 18, color: '#4b5058', width: 5 },
  { id: 'glass', label: 'Glass (clear window)', db: 3, color: '#3aa7d6', width: 3 },
  { id: 'other', label: 'Other (custom dB)', db: 6, color: '#9166d0', width: 3 },
];

export const MATERIAL_BY_ID = Object.fromEntries(MATERIALS.map((m) => [m.id, m]));

export function defaultMaterialDb() {
  return Object.fromEntries(MATERIALS.map((m) => [m.id, m.db]));
}
