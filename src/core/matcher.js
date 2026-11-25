/**
 * Smart texture → model / material / slot matcher.
 *
 * Given a list of imported models (with their material slots) and a flat pile
 * of textures (often from a ZIP with arbitrary folder layouts), this produces
 * scored assignments. Pure functions only — no three.js, no DOM — so the whole
 * brain of the feature is unit-testable.
 */

import { basename, pathTokens, tokenize, foldersOf, stem } from './paths.js';

/* ------------------------------------------------------------------ *
 * Map-type vocabulary
 * ------------------------------------------------------------------ */

const SLOT_ALIASES = [
  // longer / more specific aliases first
  ['ambientocclusion', 'ao'],
  ['ambient_occlusion', 'ao'],
  ['occlusionroughnessmetallic', 'orm'],
  ['basecolor', 'baseColor'],
  ['base_color', 'baseColor'],
  ['diffuse', 'baseColor'],
  ['albedo', 'baseColor'],
  ['color', 'baseColor'],
  ['colour', 'baseColor'],
  ['diff', 'baseColor'],
  ['col', 'baseColor'],
  ['normalgl', 'normal'],
  ['normaldx', 'normal'],
  ['norm', 'normal'],
  ['normalmap', 'normal'],
  ['normal', 'normal'],
  ['nrm', 'normal'],
  ['nrml', 'normal'],
  ['roughness', 'roughness'],
  ['rough', 'roughness'],
  ['rgh', 'roughness'],
  ['glossiness', 'glossiness'],
  ['gloss', 'glossiness'],
  ['metalness', 'metalness'],
  ['metallic', 'metalness'],
  ['metal', 'metalness'],
  ['mtl', 'metalness'],
  ['specular', 'specular'],
  ['spec', 'specular'],
  ['emissive', 'emissive'],
  ['emission', 'emissive'],
  ['emit', 'emissive'],
  ['glow', 'emissive'],
  ['opacity', 'opacity'],
  ['alpha', 'opacity'],
  ['translucency', 'opacity'],
  ['transparency', 'opacity'],
  ['displacement', 'displacement'],
  ['displace', 'displacement'],
  ['height', 'displacement'],
  ['heightmap', 'displacement'],
  ['bump', 'bump'],
  ['disp', 'displacement'],
  ['orm', 'orm'],
  ['arm', 'orm'],
  ['rma', 'orm'],
  ['mra', 'orm'],
  ['maskmap', 'orm'],
  ['masks', 'orm'],
  ['cavity', 'ao'],
  ['ao', 'ao'],
];

const PACKED_SLOTS = {
  orm: ['ao', 'roughness', 'metalness'],
  rma: ['roughness', 'metalness', 'ao'],
  mra: ['metalness', 'roughness', 'ao'],
  arm: ['ao', 'roughness', 'metalness'],
};
PACKED_SLOTS.mask = PACKED_SLOTS.orm;
PACKED_SLOTS.masks = PACKED_SLOTS.orm;

/** Slots considered "colour", used as a fallback for unlabelled textures. */
export const SLOT_ORDER = [
  'baseColor', 'normal', 'roughness', 'metalness', 'ao', 'emissive',
  'opacity', 'displacement', 'bump', 'specular', 'glossiness',
];

const RESOLUTION_TOKENS = new Set([
  '1k', '2k', '4k', '8k', '16k', '512', '1024', '2048', '4096', '8192', '16384',
  'hd', 'fhd', 'qhd', 'uhd', 'px', 'low', 'med', 'medium', 'high', 'ultra',
  'final', 'fixed', 'copy', 'export', 'compressed', 'preview', 'thumb', 'small',
  'premult', 'linear', 'srgb', 'raw', 'tex', 'texture', 'map', 'png', 'jpg',
]);

const GENERIC_MATERIAL_TOKENS = new Set([
  'material', 'materials', 'mat', 'mats', 'mesh', 'obj', 'object', 'group',
  'default', 'lambert', 'blinn', 'phong', 'standard', 'physical', 'shader',
  'surface', 'shading', 'node', 'unnamed', 'null', 'none', 'new',
]);

const STOP_TOKENS = new Set([
  'the', 'and', 'of', 'a', 'for', 'with', 'to', 'in', 'on', 'by', 'v', 'ver',
]);

/** Removes resolution / packaging noise from a token list. */
export function stripNoise(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    // The camelCase splitter turns "4K" into "4" + "k"; re-join and drop it.
    if (/^\d{1,2}$/.test(t) && tokens[i + 1] === 'k') {
      i += 1;
      continue;
    }
    if (RESOLUTION_TOKENS.has(t)) continue;
    if (/^\d{3,5}$/.test(t)) continue; // 1024, 4096, 0001
    if (/^\d{4}$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Detects which PBR slot a texture filename claims to be.
 * @returns {{slot: string|null, packed: string[]|null, matched: string|null}}
 */
export function detectMapType(path) {
  const raw = stem(path).toLowerCase();
  const tokens = tokenize(raw);

  // 1) token-level aliases (most reliable)
  for (const token of tokens) {
    for (const [alias, slot] of SLOT_ALIASES) {
      if (token === alias) return finish(slot, alias);
    }
  }

  // 2) substring aliases at the end of the file name: "wood_BaseColor"
  for (const [alias, slot] of SLOT_ALIASES) {
    if (alias.length < 3) continue;
    const re = new RegExp(`(?:^|[_.\\-\\s])${escapeRe(alias)}$`, 'i');
    if (re.test(raw)) return finish(slot, alias);
  }

  // 3) single letter suffixes: wood_n.png, wood_c.png, wood_r.png
  const short = raw.match(/(?:^|[_.\-\s])(n|nr|d|c|r|m|a|e)$/);
  if (short) {
    const map = { n: 'normal', nr: 'normal', d: 'baseColor', c: 'baseColor', r: 'roughness', m: 'metalness', a: 'opacity', e: 'emissive' };
    return finish(map[short[1]], short[1]);
  }

  return { slot: null, packed: null, matched: null };

  function finish(slot, matched) {
    // The channel order follows the alias that matched, so "RMA" keeps its
    // roughness/metalness/ao order instead of collapsing into the ORM order.
    const packed = PACKED_SLOTS[matched] || PACKED_SLOTS[slot];
    if (packed) {
      return { slot: 'orm', packed, matched };
    }
    if (slot === 'glossiness') {
      // Gloss maps are roughness inverted; we flag it so the UI can offer a fix.
      return { slot: 'roughness', packed: null, matched, inverted: true };
    }
    return { slot, packed: null, matched };
  }
}

/** True when the name looks like a UDIM tile (foo.1001.png). */
export function detectUdim(path) {
  const base = stem(path);
  const m = base.match(/[.\-_](\d{4})$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (num < 1001 || num > 1100) return null;
  return { tile: num, udim: 1001 + Math.floor((num - 1001) / 10) * 10 + ((num - 1) % 10) };
}

/** True when a token is part of a longer slot phrase split by camelCase
 *  ("BaseColor" → base + color) — both halves must be dropped, not just one. */
const SLOT_PARTS = new Set(['base', 'normal', 'rough', 'metal', 'spec', 'emiss',
  'emis', 'occlus', 'displace', 'ambient', 'clear', 'coat', 'trans', 'height',
  'bump', 'alpha', 'opacity', 'gloss', 'diff', 'albedo', 'color', 'colour',
  'map', 'texture', 'tex', 'sg', 'srgb', 'rgb']);

/** Name with map-type + resolution noise stripped, used for similarity. */
export function identityTokens(path) {
  const tokens = pathTokens(path);
  const mapType = detectMapType(path);
  return stripNoise(tokens).filter((t) => {
    if (STOP_TOKENS.has(t)) return false;
    for (const [alias] of SLOT_ALIASES) {
      if (t === alias) return false;
    }
    // Drop leftover halves of camel-cased slot names, but only when the file
    // actually declares a map type (so a model called "Base" is unaffected).
    if (mapType.slot && SLOT_PARTS.has(t)) return false;
    return true;
  });
}

export function materialTokens(name) {
  const all = tokenize(name);
  const filtered = all.filter((t) => !GENERIC_MATERIAL_TOKENS.has(t));
  return stripNoise(filtered.length ? filtered : all);
}

export function identityString(path) {
  return identityTokens(path).join(' ');
}

function setOf(tokens) {
  return new Set(tokens);
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : setOf(a);
  const B = b instanceof Set ? b : setOf(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Fuzzy token overlap: also rewards partial string matches (wood ↔ wooden). */
export function tokenOverlap(aTokens, bTokens) {
  const A = [...setOf(aTokens)];
  const B = [...setOf(bTokens)];
  if (!A.length || !B.length) return 0;
  let score = 0;
  const usedB = new Set();
  for (const ta of A) {
    let best = 0;
    let bestIdx = -1;
    B.forEach((tb, i) => {
      let s = 0;
      if (ta === tb) s = 1;
      else if (ta.length >= 3 && tb.length >= 3 && (ta.startsWith(tb) || tb.startsWith(ta))) s = 0.72;
      else if (ta.length >= 4 && tb.length >= 4 && (ta.includes(tb) || tb.includes(ta))) s = 0.5;
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    });
    if (best > 0 && !usedB.has(bestIdx)) {
      usedB.add(bestIdx);
      score += best;
    }
  }
  return score / Math.max(A.length, B.length);
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

function idfMap(documents) {
  const df = new Map();
  for (const doc of documents) {
    for (const token of new Set(doc)) df.set(token, (df.get(token) || 0) + 1);
  }
  const total = Math.max(1, documents.length);
  const idf = new Map();
  for (const [token, count] of df) idf.set(token, Math.log(1 + total / count));
  return idf;
}

function weightedOverlap(aTokens, bTokens, idf) {
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  let hit = 0;
  let total = 0;
  for (const t of new Set(aTokens)) {
    const w = idf.get(t) ?? 1.5;
    total += w;
    if (bSet.has(t)) hit += w;
    else {
      for (const bt of bSet) {
        if (t.length >= 4 && bt.length >= 4 && (t.startsWith(bt) || bt.startsWith(t))) {
          hit += w * 0.6;
          break;
        }
      }
    }
  }
  return total ? hit / total : 0;
}

/**
 * @param {object} input
 * @param {Array<{id:string,path:string,materials:Array<{id:string,name:string,meshNames?:string[]}>}>} input.models
 * @param {Array<{id:string,path:string}>} input.textures
 * @param {{minConfidence?:number, allowCrossModel?:boolean}} [input.options]
 */
/**
 * Scores one texture against every (model, material) pair and returns the
 * best candidate, or null when there is nothing to match against.
 */
function bestCandidate(texture, modelTokens, idf) {
  const tTokens = identityTokens(texture.path);
  const tFolderTokens = new Set(foldersOf(texture.path).flatMap((f) => tokenize(f)));
  const mapType = detectMapType(texture.path);
  const udim = detectUdim(texture.path);

  let best = null;

  for (const { model, tokens: mTokens, folderTokens } of modelTokens) {
    // Model-level name affinity (textures often named after the model).
    const modelNameScore = Math.max(
      weightedOverlap(tTokens, mTokens, idf),
      tTokens.length ? jaccard(tTokens, mTokens) : 0,
    );
    let folderScore = 0;
    if (tFolderTokens.size && folderTokens.size) {
      let shared = 0;
      for (const f of tFolderTokens) if (folderTokens.has(f)) shared += 1;
      // Fraction of the smaller folder set that is shared, so a texture in a
      // "textures" subfolder still counts as living with its model.
      folderScore = shared / Math.max(1, Math.min(tFolderTokens.size, folderTokens.size));
    }

    for (const material of model.materials) {
      const matTokens = materialTokens(material.name);
      const nameScore = weightedOverlap(tTokens, matTokens, idf);
      const jac = jaccard(tTokens, matTokens);
      const meshScore = Math.max(
        0,
        ...(material.meshNames || []).map((mesh) =>
          weightedOverlap(tTokens, materialTokens(mesh), idf),
        ),
      );
      const exact = matTokens.length && identityString(texture.path) === identityString_material(material.name);

      // Weights reflect what actually identifies a texture in the wild:
      //  \u00b7 the texture set usually shares the MODEL name ("chair_Normal")
      //  \u00b7 failing that it shares the MATERIAL or MESH name ("wood_BaseColor")
      //  \u00b7 folders are a weaker but useful signal
      //  \u00b7 an explicit map-type keyword resolves which slot it fills
      let score =
        nameScore * 45 +
        jac * 20 +
        meshScore * 20 +
        modelNameScore * 58 +
        folderScore * 15 +
        (exact ? 15 : 0) +
        (mapType.slot ? 6 : 0);

      // Single-material models: an unlabelled texture almost certainly
      // belongs to that material.
      const soleMaterial = model.materials.length === 1;
      if (soleMaterial) {
        score += 12;
        if (mapType.slot) score += 6;
        if (folderScore > 0.5) score += 6;
      } else if (!mapType.slot && nameScore < 0.2) {
        score -= 10; // ambiguous colour-vs-other with nothing to go on
      }

      // UDIM tiles all belong to one material; keep them together.
      if (udim) score += 2;

      if (score > (best?.score ?? -Infinity)) {
        best = {
          score,
          model,
          material,
          mapType,
          udim,
          parts: { nameScore, jac, meshScore, modelNameScore, folderScore, exact },
        };
      }
    }
  }

  return best;
}

export function matchTextures(input) {
  const models = (input.models || []).filter((m) => m && Array.isArray(m.materials) && m.materials.length);
  const textures = (input.textures || []).filter(Boolean);
  const options = { minConfidence: 42, ...(input.options || {}) };

  const assignments = [];
  const unassigned = [];
  const matchedSlots = new Set(); // `${materialId}:${slot}`

  // Corpus for IDF: all material names + all mesh names
  const corpus = [];
  for (const m of models) {
    for (const mat of m.materials) {
      corpus.push(materialTokens(mat.name));
      for (const mesh of mat.meshNames || []) corpus.push(materialTokens(mesh));
    }
  }
  const idf = idfMap(corpus.filter((t) => t.length));

  const modelTokens = models.map((m) => ({
    model: m,
    tokens: stripNoise([...identityTokens(m.path), ...identityTokens(stem(m.path))]),
    folderTokens: new Set(foldersOf(m.path).flatMap((f) => tokenize(f))),
  }));

  // Pass 1 \u2014 find each texture's best (model, material) candidate. Nothing
  // is committed yet, so a weak texture cannot steal a slot from a strong one.
  const candidates = [];
  textures.forEach((texture, index) => {
    const best = bestCandidate(texture, modelTokens, idf);
    if (!best) {
      unassigned.push({ texture, reason: 'no-model', _index: index });
      return;
    }
    candidates.push({ texture, best, index });
  });

  // Pass 2 \u2014 commit highest confidence first so the strongest claim wins a
  // contested slot.
  candidates.sort((a, b) => b.best.score - a.best.score);

  for (const { texture, best, index } of candidates) {
    const confidence = Math.round(Math.min(100, Math.max(0, best.score)));
    const soleMaterial = best.model.materials.length === 1;
    // Single-material models are far more forgiving: an unlabelled texture in
    // the model's folder is almost certainly its colour map.
    const threshold = soleMaterial ? Math.min(options.minConfidence, 30) : options.minConfidence;

    // Determine slot: explicit map type wins; otherwise fall back to the first
    // free slot (colour first) \u2014 only when we are reasonably confident.
    let slot = best.mapType.slot;
    if (!slot) {
      slot = pickFreeSlot(best.material, matchedSlots, soleMaterial && confidence >= 18);
    }

    if (confidence < threshold || !slot) {
      unassigned.push({
        texture,
        reason: slot ? 'low-confidence' : 'unknown-slot',
        best: { modelId: best.model.id, materialId: best.material.id, confidence },
        _index: index,
      });
      continue;
    }

    const slotKey = `${best.material.id}:${slot}`;
    if (matchedSlots.has(slotKey)) {
      // A stronger texture already claimed this slot (a duplicate resolution,
      // or a packed map covering it). Leave this one for manual assignment.
      unassigned.push({
        texture,
        reason: 'slot-taken',
        best: { modelId: best.model.id, materialId: best.material.id, confidence },
        _index: index,
      });
      continue;
    }

    assignments.push({
      textureId: texture.id,
      texturePath: texture.path,
      modelId: best.model.id,
      materialId: best.material.id,
      slot,
      packed: best.mapType.packed,
      inverted: Boolean(best.mapType.inverted),
      confidence,
      reason: describeReason(best.parts, best.mapType),
      udim: best.udim,
      parts: best.parts,
      _index: index,
    });
    matchedSlots.add(slotKey);
    if (best.mapType.packed) {
      for (const s of best.mapType.packed) matchedSlots.add(`${best.material.id}:${s}`);
    }
  }

  // Restore input order so results are stable and predictable for the UI.
  assignments.sort((a, b) => a._index - b._index);
  unassigned.sort((a, b) => a._index - b._index);
  for (const a of assignments) delete a._index;
  for (const u of unassigned) delete u._index;

  // Post-pass: some engines drop the "_basecolor" suffix entirely. If a material
  // still has no base colour but got a normal/roughness, promote its best
  // "unknown" texture.
  const unmatchedSlots = [];
  for (const model of models) {
    for (const material of model.materials) {
      for (const slot of SLOT_ORDER) {
        if (!matchedSlots.has(`${material.id}:${slot}`)) unmatchedSlots.push({ modelId: model.id, materialId: material.id, slot });
      }
    }
  }

  return { assignments, unassigned, unmatchedSlots };
}

function identityString_material(name) {
  return materialTokens(name).join(' ');
}

function pickFreeSlot(material, matchedSlots, allowFallback) {
  if (!allowFallback) return null;
  for (const slot of SLOT_ORDER) {
    if (!matchedSlots.has(`${material.id}:${slot}`)) return slot;
  }
  return null;
}

function describeReason(parts, mapType) {
  const bits = [];
  if (parts.exact) bits.push('exact material name');
  if (parts.nameScore > 0.6) bits.push('material name match');
  else if (parts.nameScore > 0.25) bits.push('partial name match');
  if (parts.meshScore > 0.5) bits.push('mesh name match');
  if (parts.modelNameScore > 0.5) bits.push('model name match');
  if (parts.folderScore > 0.5) bits.push('shared folder');
  if (mapType.matched) bits.push(`"${mapType.matched}" → ${mapType.slot}`);
  return bits.join(' · ') || 'heuristic';
}

/**
 * Groups UDIM tiles so only the base tile is uploaded by default.
 * @returns {{base: string, tiles: Array<{id:string, tile:number}>}[]}
 */
export function groupUdim(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const udim = detectUdim(entry.path);
    if (!udim) continue;
    const key = basename(entry.path).replace(/[.\-_]\d{4}(\.[a-z0-9]+)$/i, '$1');
    if (!groups.has(key)) groups.set(key, { base: key, tiles: [] });
    groups.get(key).tiles.push({ id: entry.id, tile: udim.tile, path: entry.path });
  }
  for (const g of groups.values()) g.tiles.sort((a, b) => a.tile - b.tile);
  return [...groups.values()];
}
