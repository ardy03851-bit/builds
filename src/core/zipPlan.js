/**
 * Pure planning logic for archive (ZIP) imports.
 *
 * The planner never touches bytes: it receives a manifest of entries and
 * decides what is an asset, what is a sidecar for another asset, which folders
 * look like "one asset per folder", and how textures should be paired up.
 * That keeps the heavy unzip work in a worker and this part unit-testable.
 */

import {
  basename, dirname, fileKind, isJunkPath, normalizePath, stem, extensionOf,
} from './paths.js';
import { detectMapType, identityTokens, detectUdim } from './matcher.js';

const SIDECAR = {
  gltf: ['bin', 'gltf', 'png', 'jpg', 'jpeg', 'webp', 'ktx2', 'basis'],
  fbx: ['png', 'jpg', 'jpeg', 'webp', 'tga', 'psd', 'tif', 'tiff'],
  obj: ['mtl', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'tif', 'tiff', 'bmp'],
  dae: ['png', 'jpg', 'jpeg', 'webp', 'tga'],
  stl: [],
  ply: [],
  '3mf': [],
  vrm: [],
};

/**
 * @param {Array<{path:string, size?:number}>} entries
 * @param {{maxBytes?:number}} [options]
 */
export function planArchive(entries, options = {}) {
  const files = [];
  const skipped = [];
  const notes = [];

  for (const raw of entries || []) {
    const path = normalizePath(raw.path);
    if (isJunkPath(path)) {
      skipped.push({ path: raw.path, reason: 'junk' });
      continue;
    }
    const kind = fileKind(path);
    if (kind === 'unknown' && extensionOf(path) !== 'bin' && extensionOf(path) !== 'json') {
      skipped.push({ path: raw.path, reason: 'unsupported' });
      continue;
    }
    files.push({
      path,
      name: basename(path),
      stem: stem(path),
      ext: extensionOf(path),
      size: Number(raw.size) || 0,
      kind,
    });
  }

  // glTF (.glb/.gltf) and other models are the anchors.
  const models = files.filter((f) => f.kind === 'model');
  const textures = files.filter((f) => f.kind === 'texture' || f.kind === 'hdri');
  const materials = files.filter((f) => f.kind === 'material');
  const audio = files.filter((f) => f.kind === 'audio' || f.kind === 'video');

  const bboxes = [];
  const isInside = (path, box) => {
    const dir = dirname(path);
    return dir === box || dir.startsWith(`${box}/`);
  };

  // Loose glTF + .bin + textures: anything sharing the gltf's folder is a
  // sidecar and must be fetched by relative URL at runtime.
  for (const model of models) {
    const allowed = SIDECAR[model.ext] || [];
    const sidecars = files.filter((f) => {
      if (f === model) return false;
      if (!isInside(f.path, dirname(model.path))) return false;
      if (f.ext === 'bin') return true;
      return allowed.includes(f.ext);
    });
    if (sidecars.length) {
      bboxes.push({ model: model.path, files: sidecars.map((s) => s.path) });
    }
  }

  const groupedModels = models.map((m) => {
    const bbox = bboxes.find((b) => b.model === m.path);
    const sidecarSet = new Set(bbox?.files || []);
    const folder = dirname(m.path);
    const ownTextures = textures.filter((t) => sidecarSet.has(t.path) || isInside(t.path, folder));
    return {
      path: m.path,
      folder,
      depth: folder.split('/').filter(Boolean).length,
      ext: m.ext,
      size: m.size,
      texturePaths: ownTextures.map((t) => t.path),
      sidecarSet,
      sidecars: [...sidecarSet],
      embeddedTextures: ownTextures.filter((t) => t.path.startsWith(folder) && sidecarSet.has(t.path)).map((t) => t.path),
      candidateTextures: ownTextures.map((t) => t.path),
    };
  });

  // Assign each texture to the deepest model folder that contains it.
  const textureOwner = new Map();
  for (const texture of textures) {
    let best = null;
    for (const model of groupedModels) {
      if (model.sidecarSet.has(texture.path)) {
        best = model;
        break;
      }
      if (!isInside(texture.path, model.folder)) continue;
      if (!best || model.depth > best.depth) best = model;
    }
    if (best) textureOwner.set(texture.path, best.path);
  }

  // Folder-per-asset heuristic, used to order imports and show a friendly plan.
  const folderNames = new Map();
  for (const m of groupedModels) {
    const folder = dirname(m.path) || '.';
    if (!folderNames.has(folder)) folderNames.set(folder, []);
    folderNames.get(folder).push(m.path);
  }

  const udim = textures
    .filter((t) => detectUdim(t.path))
    .map((t) => ({ path: t.path, tile: detectUdim(t.path).tile }));

  const estimatedBytes = files.reduce((sum, f) => sum + f.size, 0);

  if (models.length === 0 && textures.length > 0) {
    notes.push('No models found — textures were added to the asset library.');
  }
  if (models.length > 1) {
    notes.push(`${models.length} models found; each keeps its own folder textures.`);
  }
  if (materials.length) {
    notes.push('MTL files detected — they are read when parsing OBJ assets.');
  }

  return {
    version: 1,
    files,
    models: groupedModels,
    textures: textures.map((t) => ({ path: t.path, kind: t.kind, owner: textureOwner.get(t.path) || null })),
    looseTextures: textures.filter((t) => !textureOwner.has(t.path)).map((t) => t.path),
    materials: materials.map((m) => m.path),
    audio: audio.map((a) => a.path),
    folders: [...folderNames.entries()].map(([folder, modelsInFolder]) => ({ folder, models: modelsInFolder })),
    udim,
    skipped,
    notes,
    estimatedBytes,
    stats: {
      models: models.length,
      textures: textures.length,
      files: files.length,
      skipped: skipped.length,
      estimatedBytes,
      biggest: files.reduce((max, f) => Math.max(max, f.size), 0),
    },
  };
}

/** Quick MIME check for the dropped file. */
export function looksLikeZip(name) {
  return /\.(zip|atlaszip)$/i.test(String(name || ''));
}

/** Turns a ZIP-internal path into a readable asset name. */
export function friendlyName(path) {
  return stem(path)
    .replace(/[_-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Decides whether an entry is plausibly a texture for a model with this name. */
export function nameAffinity(texturePath, modelPath) {
  const a = new Set(identityTokens(texturePath));
  const b = new Set(identityTokens(modelPath));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export { detectMapType };
