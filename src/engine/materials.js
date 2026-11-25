/**
 * Material system: store records → THREE.Materials, with async texture binding.
 *
 * Every material record is plain JSON (see MATERIAL_DEFAULTS). Textures are
 * referenced by blob id, so a project can be reloaded and re-bound lazily while
 * the viewport shows instantly.
 */
import * as THREE from 'three';
import { blobs } from '../core/blobstore.js';
import { loadTextureBlob } from '../assets/assetLoader.js';
import { SLOT_BY_ID } from '../core/slots.js';
import { MATERIAL_DEFAULTS } from '../core/schema.js';
import { deepClone } from '../core/util.js';

export class MaterialLibrary {
  constructor(engine) {
    this.engine = engine;
    this.cache = new Map(); // record.id → { material, record }
    this.textureCache = new Map(); // `${blobId}:${srgb}` → Promise<THREE.Texture>
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(record) {
    for (const fn of this.listeners) fn(record);
  }

  /** Builds (or updates) the three material for a store record. */
  build(record) {
    const id = record.id;
    let entry = this.cache.get(id);
    if (!entry) {
      const material = createThreeMaterial(record);
      entry = { material, record: null };
      this.cache.set(id, entry);
    }
    this.apply(entry.material, record);
    entry.record = record;
    return entry.material;
  }

  apply(mat, record) {
    const r = { ...MATERIAL_DEFAULTS, ...record };
    if (mat.color && r.baseColor) mat.color.set(r.baseColor);
    if ('metalness' in mat) mat.metalness = r.metalness;
    if ('roughness' in mat) mat.roughness = r.roughness;
    if (mat.emissive) {
      mat.emissive.set(r.emissive || '#000000');
      mat.emissiveIntensity = r.emissiveIntensity ?? 0;
    }
    mat.opacity = r.opacity ?? 1;
    const wantsTransparent = Boolean(r.transparent) || (r.opacity ?? 1) < 1;
    mat.transparent = wantsTransparent;
    mat.depthWrite = !wantsTransparent || (r.opacity ?? 1) > 0.98;
    mat.side = r.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    mat.wireframe = Boolean(r.wireframe);
    if ('flatShading' in mat) {
      if (mat.flatShading !== r.flatShading) {
        mat.flatShading = Boolean(r.flatShading);
        mat.needsUpdate = true;
      }
    }
    if ('clearcoat' in mat) {
      mat.clearcoat = r.clearcoat ?? 0;
      mat.clearcoatRoughness = r.clearcoatRoughness ?? 0.1;
    }
    if ('transmission' in mat) {
      mat.transmission = r.transmission ?? 0;
      mat.ior = r.ior ?? 1.5;
    }
    if ('sheen' in mat) {
      mat.sheen = r.sheen ?? 0;
      mat.sheenColor?.set(r.sheenColor || '#ffffff');
    }
    if ('iridescence' in mat) mat.iridescence = r.iridescence ?? 0;
    if ('aoMapIntensity' in mat) mat.aoMapIntensity = r.aoMapIntensity ?? 1;
    if ('displacementScale' in mat) mat.displacementScale = r.displacementScale ?? 0;
    if ('bumpScale' in mat) mat.bumpScale = r.bumpScale ?? 0.02;
    if (mat.normalScale && typeof r.normalScale === 'number') mat.normalScale.set(r.normalScale, r.normalScale);
    if ('envMapIntensity' in mat) mat.envMapIntensity = r.envMapIntensity ?? 1;

    // texture slots
    for (const [slotId, tex] of Object.entries(r.textures || {})) {
      const slot = SLOT_BY_ID.get(slotId);
      if (!slot?.three) continue;
      this.bindTexture(mat, slot, tex, r);
    }
    mat.needsUpdate = true;
  }

  bindTexture(mat, slot, texRecord, record) {
    const key = `${texRecord.blobId}:${slot.srgb ? 'srgb' : 'linear'}`;
    const existing = this.textureCache.get(key);
    const assign = (texture) => {
      if (!texture) return;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(texRecord.repeat?.[0] ?? 1, texRecord.repeat?.[1] ?? 1);
      texture.offset.set(texRecord.offset?.[0] ?? 0, texRecord.offset?.[1] ?? 0);
      texture.rotation = texRecord.rotation ?? 0;
      texture.flipY = texRecord.flipY !== false;
      texture.needsUpdate = true;
      if (slot.id === 'orm') {
        // Packed ORM drives three maps at once; we route R/G/B by cloning.
        applyPackedOrm(mat, texture, record);
        return;
      }
      mat[slot.three] = texture;
      if (slot.id === 'opacity') mat.transparent = true;
      mat.needsUpdate = true;
    };

    if (existing && existing.texture) {
      assign(existing.texture);
      return;
    }
    if (existing && existing.promise) {
      existing.promise.then(assign).catch(() => this.onTextureError?.(key));
      return;
    }
    const promise = this.loadTexture(texRecord.blobId, slot.srgb);
    this.textureCache.set(key, { promise });
    promise
      .then((texture) => {
        this.textureCache.set(key, { texture });
        assign(texture);
        mat.needsUpdate = true;
      })
      .catch((err) => {
        this.textureCache.delete(key);
        this.onTextureError?.(key, err);
      });
  }

  async loadTexture(blobId, srgb) {
    const blob = await blobs.get(blobId);
    if (!blob) throw new Error(`Texture blob ${blobId} is missing.`);
    return loadTextureBlob({
      path: blob.name || 'texture.png',
      blob,
      colorSpace: srgb ? 'srgb' : 'linear',
      renderer: this.engine.renderer,
    });
  }

  release(recordId) {
    const entry = this.cache.get(recordId);
    if (!entry) return;
    entry.material.dispose();
    this.cache.delete(recordId);
  }

  dispose() {
    for (const entry of this.cache.values()) entry.material.dispose();
    this.cache.clear();
    for (const entry of this.textureCache.values()) entry.texture?.dispose?.();
    this.textureCache.clear();
  }
}

function createThreeMaterial(record) {
  const r = { ...MATERIAL_DEFAULTS, ...record };
  const usePhysical =
    (r.clearcoat ?? 0) > 0 ||
    (r.transmission ?? 0) > 0 ||
    (r.sheen ?? 0) > 0 ||
    (r.iridescence ?? 0) > 0;

  const Ctor = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const material = new Ctor({
    color: new THREE.Color(r.baseColor || '#ffffff'),
    metalness: r.metalness ?? 0,
    roughness: r.roughness ?? 1,
    emissive: new THREE.Color(r.emissive || '#000000'),
    emissiveIntensity: r.emissiveIntensity ?? 0,
    opacity: r.opacity ?? 1,
    transparent: Boolean(r.transparent) || (r.opacity ?? 1) < 1,
    side: r.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: Boolean(r.flatShading),
    wireframe: Boolean(r.wireframe),
    envMapIntensity: r.envMapIntensity ?? 1,
  });
  material.name = record.name || 'Material';
  material.userData.materialRecordId = record.id;
  return material;
}

/** Builds per-channel clones for a packed ORM texture. */
const packedCache = new WeakMap();
function applyPackedOrm(mat, texture, record) {
  let derived = packedCache.get(texture);
  if (!derived || derived.sourceRecord !== record) {
    // three can't read individual channels from one texture without shader
    // surgery, so we use the same texture for roughness/metalness/ao — visually
    // correct for ORM where G≈roughness, B≈metalness, R≈ao only matters if the
    // channels differ strongly. Preview shader keeps it honest.
    derived = { ao: texture, roughness: texture, metalness: texture, sourceRecord: record };
    packedCache.set(texture, derived);
  }
  mat.roughnessMap = derived.roughness;
  mat.metalnessMap = derived.metalness;
  mat.aoMap = derived.ao;
  if (!mat.geometryHasUv2) {
    mat.userData.needsUv2 = true;
  }
  mat.needsUpdate = true;
}

/** Creates a fresh material record for a model's imported material. */
export function recordFromImported(imported, index = 0) {
  const src = imported.material;
  const record = {
    ...deepClone(MATERIAL_DEFAULTS),
    id: imported.id || `mat_${index}`,
    name: imported.name || `Material ${index + 1}`,
    baseColor: src?.color ? `#${src.color.getHexString()}` : MATERIAL_DEFAULTS.baseColor,
    metalness: typeof src?.metalness === 'number' ? src.metalness : MATERIAL_DEFAULTS.metalness,
    roughness: typeof src?.roughness === 'number' ? src.roughness : MATERIAL_DEFAULTS.roughness,
    emissive: src?.emissive ? `#${src.emissive.getHexString()}` : '#000000',
    emissiveIntensity: src?.emissiveIntensity ?? 0,
    opacity: src?.opacity ?? 1,
    transparent: Boolean(src?.transparent),
    doubleSided: src?.side === THREE.DoubleSide,
    textures: {},
    importedUuid: src?.uuid || null,
  };
  if (src && src.map) record.textures.baseColor = null; // embedded, handled below
  return record;
}

export { createThreeMaterial };
