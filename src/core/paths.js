/**
 * Path + filename analysis helpers.
 *
 * Every importer funnels file names through here so the texture matcher,
 * the ZIP classifier and the asset library all agree on what a file "is".
 */

export const MODEL_EXTENSIONS = [
  'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3mf',
];
export const TEXTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'ktx2', 'basis'];
export const HDR_EXTENSIONS = ['hdr', 'exr'];
export const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'wav', 'm4a'];
export const VIDEO_EXTENSIONS = ['mp4', 'webm'];
export const MATERIAL_EXTENSIONS = ['mtl'];
export const DOC_EXTENSIONS = ['atlascene', 'atlaszip'];

const ALL_EXTENSIONS = [
  ...MODEL_EXTENSIONS,
  ...TEXTURE_EXTENSIONS,
  ...HDR_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...MATERIAL_EXTENSIONS,
];

/** Lower-case extension without the dot. */
export function extensionOf(path) {
  const clean = stripQuery(String(path ?? ''));
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function stripQuery(path) {
  const s = String(path ?? '');
  const q = s.search(/[?#]/);
  return q === -1 ? s : s.slice(0, q);
}

export function basename(path) {
  const clean = stripQuery(String(path ?? '')).replace(/\\/g, '/');
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/** Directory without trailing slash ('' for top level). */
export function dirname(path) {
  const clean = String(path ?? '').replace(/\\/g, '/');
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? '' : clean.slice(0, idx);
}

/** File name without its extension. */
export function stem(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

export function normalizePath(path) {
  const parts = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** Junk entries that archive tools love to sprinkle into ZIPs. */
export function isJunkPath(path) {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (!p) return true;
  if (p.endsWith('/')) return true;
  if (/(^|\/)__MACOSX(\/|$)/i.test(p)) return true;
  if (/(^|\/)\.DS_Store$/i.test(p)) return true;
  if (/(^|\/)Thumbs\.db$/i.test(p)) return true;
  if (/(^|\/)desktop\.ini$/i.test(p)) return true;
  if (/(^|\/)\._/.test(p)) return true;
  if (/(^|\/)\.git(\/|$)/.test(p)) return true;
  return false;
}

export function fileKind(path) {
  const ext = extensionOf(path);
  if (MODEL_EXTENSIONS.includes(ext)) return 'model';
  if (MATERIAL_EXTENSIONS.includes(ext)) return 'material';
  if (TEXTURE_EXTENSIONS.includes(ext)) return 'texture';
  if (HDR_EXTENSIONS.includes(ext)) return 'hdri';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (DOC_EXTENSIONS.includes(ext)) return 'project';
  return 'unknown';
}

export function isSupportedFile(path) {
  return ALL_EXTENSIONS.includes(extensionOf(path));
}

export const mimeForExtension = (ext) => {
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    ktx2: 'image/ktx2',
    basis: 'image/basis',
    hdr: 'image/vnd.radiance',
    exr: 'image/x-exr',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    bin: 'application/octet-stream',
    fbx: 'application/octet-stream',
    obj: 'text/plain',
    mtl: 'text/plain',
    stl: 'model/stl',
    ply: 'application/octet-stream',
    dae: 'model/vnd.collada+xml',
    '3mf': 'model/3mf',
    json: 'application/json',
    atlascene: 'application/json',
    atlaszip: 'application/zip',
  };
  return map[String(ext).toLowerCase()] || 'application/octet-stream';
};

/** Splits a name into lowercase semantic tokens ("Wood_Planks_4K" → wood, planks). */
export function tokenize(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Path without folders, without extension, normalised to tokens. */
export function pathTokens(path) {
  return tokenize(stem(path));
}

/** Relative folder chain, useful for grouping loose texture packs. */
export function foldersOf(path) {
  return dirname(path)
    .split('/')
    .filter(Boolean)
    .map((f) => f.toLowerCase());
}

/** Folder key used to group files that live in the same place. */
export function foldName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The cheapest useful identity of a file: its lower-case base name. */
export function foldPath(path) {
  return foldName(basename(path));
}

/** Case-insensitive extension test. */
export function hasExtension(path, list) {
  const ext = extensionOf(path);
  return list.some((e) => e === ext);
}
