/**
 * PBR slot definitions shared by the material inspector, the texture matcher
 * and the ZIP importer. `three` key → `material` property.
 */

export const SLOTS = [
  { id: 'baseColor', label: 'Base Color', three: 'map', color: 'color', srgb: true, accept: 'Albedo / Diffuse' },
  { id: 'normal', label: 'Normal', three: 'normalMap', srgb: false, accept: 'Normal (OpenGL)', normal: true },
  { id: 'roughness', label: 'Roughness', three: 'roughnessMap', srgb: false, scalar: 'roughness' },
  { id: 'metalness', label: 'Metalness', three: 'metalnessMap', srgb: false, scalar: 'metalness' },
  { id: 'ao', label: 'Ambient Occlusion', three: 'aoMap', srgb: false, scalar: 'aoMapIntensity' },
  { id: 'emissive', label: 'Emissive', three: 'emissiveMap', srgb: true, color: 'emissive' },
  { id: 'opacity', label: 'Opacity', three: 'alphaMap', srgb: false },
  { id: 'displacement', label: 'Displacement', three: 'displacementMap', srgb: false, scalar: 'displacementScale' },
  { id: 'bump', label: 'Bump', three: 'bumpMap', srgb: false, scalar: 'bumpScale' },
  { id: 'specular', label: 'Specular', three: 'specularMap', srgb: true },
  { id: 'glossiness', label: 'Glossiness', three: 'metalnessMap', srgb: false },
  { id: 'orm', label: 'Packed ORM', three: 'roughnessMap', srgb: false, packed: true },
];

export const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.id, s]));

export const slotThreeKey = (id) => SLOT_BY_ID.get(id)?.three || null;

/** The colour/bool uniforms a slot drives (used by the inspector). */
export const SLOT_COLOR_PROP = (id) => SLOT_BY_ID.get(id)?.color || null;

export const PACKED_CHANNELS = {
  ao: { channel: 'r', label: 'R · Occlusion' },
  roughness: { channel: 'g', label: 'G · Roughness' },
  metalness: { channel: 'b', label: 'B · Metalness' },
};

/** Slot ids, colour-first, used when auto-picking an empty slot. */
export const SLOT_PRIORITY = ['baseColor', 'normal', 'roughness', 'metalness', 'ao', 'emissive', 'opacity', 'displacement'];
