/**
 * Portable Atlas project bundles.
 *
 * The project document and its content-addressed assets are written as a ZIP
 * using pass-through streams. File bytes are read in bounded chunks, and ZIP
 * assets are stored without recompression (models/textures are usually already
 * compressed). Import uses Blob slices for stored entries to avoid a full-size
 * JS ArrayBuffer copy.
 */
import { Zip, ZipPassThrough } from 'fflate';
import { ZipReader } from '../assets/zipReader.js';

export const PROJECT_DOCUMENT_PATH = 'project.atlascene';
const BUNDLE_CHUNK_SIZE = 8 * 1024 * 1024;

export function referencedBlobIds(document) {
  const ids = new Set();
  for (const asset of document?.assets || []) {
    if (typeof asset?.blobId === 'string' && asset.blobId) ids.add(asset.blobId);
  }
  for (const material of Object.values(document?.materials || {})) {
    for (const texture of Object.values(material?.textures || {})) {
      if (typeof texture?.blobId === 'string' && texture.blobId) ids.add(texture.blobId);
    }
  }
  return [...ids];
}

export function bundleBlobPath(blobId) {
  return `assets/${encodeURIComponent(blobId)}.blob`;
}

/** Builds a browser Blob from streamed ZIP output without concatenating bytes. */
export async function createProjectBundle(document, getBlob, { onProgress = () => {} } = {}) {
  if (!document || typeof document !== 'object') throw new TypeError('A project document is required.');
  if (typeof getBlob !== 'function') throw new TypeError('A blob lookup function is required.');

  const documentBlob = new Blob([JSON.stringify(document)], { type: 'application/json' });
  const ids = referencedBlobIds(document);
  const sources = [];
  let totalBytes = documentBlob.size;
  for (const id of ids) {
    const blob = await getBlob(id);
    if (!blob || typeof blob.slice !== 'function' || !Number.isFinite(blob.size)) {
      throw new Error(`Project asset is missing from local storage: ${id}`);
    }
    sources.push({ id, blob });
    totalBytes += blob.size;
  }

  const chunks = [];
  let zipError = null;
  let finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) zipError = error;
    if (data) chunks.push(data);
    if (final) finished = true;
  });

  let loadedBytes = 0;
  const pushBlob = async (path, blob) => {
    const stream = new ZipPassThrough(path);
    zip.add(stream);
    if (blob.size === 0) {
      stream.push(new Uint8Array(0), true);
      return;
    }
    for (let offset = 0; offset < blob.size; offset += BUNDLE_CHUNK_SIZE) {
      const end = Math.min(offset + BUNDLE_CHUNK_SIZE, blob.size);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      stream.push(bytes, end === blob.size);
      loadedBytes += bytes.byteLength;
      onProgress({ loaded: loadedBytes, total: totalBytes, path });
    }
  };

  await pushBlob(PROJECT_DOCUMENT_PATH, documentBlob);
  for (const { id, blob } of sources) {
    // Deliberately serialized: keeps peak working memory bounded on iPads.
    await pushBlob(bundleBlobPath(id), blob);
  }
  zip.end();

  if (zipError) throw zipError;
  if (!finished) throw new Error('Could not finish the project bundle.');
  return new Blob(chunks, { type: 'application/zip' });
}

/** Reads a portable bundle, validating the project file and each asset CRC. */
export async function readProjectBundle(file, { onProgress = () => {} } = {}) {
  const reader = await new ZipReader(file).open();
  if (!reader.has(PROJECT_DOCUMENT_PATH)) {
    throw new Error('This ZIP is not an Atlas project bundle.');
  }

  const documentBytes = await reader.read(PROJECT_DOCUMENT_PATH, { verify: true });
  let document;
  try {
    document = JSON.parse(new TextDecoder().decode(documentBytes));
  } catch {
    throw new Error('The project bundle contains an invalid project document.');
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.assets) || !Array.isArray(document.objects)) {
    throw new Error('The project bundle is missing its scene graph.');
  }

  const ids = referencedBlobIds(document);
  const entries = [];
  let completed = 0;
  for (const id of ids) {
    const path = bundleBlobPath(id);
    if (!reader.has(path)) throw new Error(`Project bundle is missing asset ${id}.`);
    // Stored bundle entries are returned as Blob slices rather than byte arrays.
    const blob = await reader.readBlob(path, { verify: true });
    entries.push({ id, blob });
    completed += 1;
    onProgress({ loaded: completed, total: ids.length, bytes: blob.size, id });
  }
  return { document, entries };
}
