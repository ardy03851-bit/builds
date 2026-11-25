/**
 * Content-addressed blob store.
 *
 * Imported bytes live as Blobs in IndexedDB; scene state keeps lightweight ids.
 * Large-file hashing works in bounded chunks so it does not allocate a second
 * full-size byte buffer. Decoders still need memory for parsed geometry/textures,
 * so the device's available RAM and GPU remain the practical import limits.
 */

const DB_NAME = 'atlas-scene-studio';
const DB_VERSION = 2;
const STORES = { blobs: 'blobs', meta: 'meta' };

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.blobs)) db.createObjectStore(STORES.blobs);
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
  return dbPromise;
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result?.__value ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

const req = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const HASH_CHUNK_SIZE = 8 * 1024 * 1024;
const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Stable content id. Small assets retain their plain SHA-256 id; large assets
 * use a versioned SHA-256 tree over 8 MiB chunk digests to bound extra memory.
 */
export async function hashBlob(blobOrBuffer) {
  const bytes = blobOrBuffer instanceof ArrayBuffer
    ? new Uint8Array(blobOrBuffer)
    : ArrayBuffer.isView(blobOrBuffer)
      ? new Uint8Array(blobOrBuffer.buffer, blobOrBuffer.byteOffset, blobOrBuffer.byteLength)
      : null;
  const size = bytes ? bytes.byteLength : blobOrBuffer?.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('hashBlob expects a Blob or binary buffer.');

  const readChunk = async (offset) => {
    const end = Math.min(offset + HASH_CHUNK_SIZE, size);
    return bytes
      ? bytes.subarray(offset, end)
      : new Uint8Array(await blobOrBuffer.slice(offset, end).arrayBuffer());
  };

  if (!globalThis.crypto?.subtle) {
    // Cheap streaming fallback for non-secure contexts without Web Crypto.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let offset = 0; offset < size; offset += HASH_CHUNK_SIZE) {
      const chunk = await readChunk(offset);
      for (let i = 0; i < chunk.length; i += 1) {
        const index = offset + i;
        h1 = (h1 ^ chunk[i]) * 16777619 >>> 0;
        h2 = (h2 + chunk[i] * (index + 1)) >>> 0;
      }
    }
    return `f${h1.toString(16)}${h2.toString(16)}${size.toString(16)}`;
  }

  if (size <= HASH_CHUNK_SIZE) {
    const data = bytes || await blobOrBuffer.arrayBuffer();
    return toHex(await globalThis.crypto.subtle.digest('SHA-256', data));
  }

  const chunkDigests = [];
  for (let offset = 0; offset < size; offset += HASH_CHUNK_SIZE) {
    const chunk = await readChunk(offset);
    chunkDigests.push(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', chunk)));
  }

  const header = new TextEncoder().encode(`atlas-sha256-chunks-v1:${size}:${HASH_CHUNK_SIZE}:`);
  const manifest = new Uint8Array(header.length + chunkDigests.length * 32);
  manifest.set(header);
  chunkDigests.forEach((digest, index) => manifest.set(digest, header.length + index * 32));
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', manifest));
}

class BlobStore {
  constructor() {
    this.cache = new Map(); // id → Blob (small LRU so repeat loads are instant)
    this.cacheLimit = 24;
    this.available = true;
    openDb().catch(() => {
      this.available = false;
    });
  }

  /** Saves bytes and returns their content hash. Deduplicated. */
  async put(id, blob) {
    if (!this.available) return id;
    try {
      await withStore(STORES.blobs, 'readwrite', (store) => {
        req(store.put(blob, id));
      });
    } catch {
      this.available = false;
    }
    this.remember(id, blob);
    return id;
  }

  async putFile(file) {
    const id = await hashBlob(file);
    await this.put(id, file);
    return id;
  }

  async has(id) {
    if (this.cache.has(id)) return true;
    if (!this.available) return false;
    try {
      const count = await withStore(STORES.blobs, 'readonly', (store) => {
        const r = store.count(id);
        return { __value: r };
      });
      return Boolean(await count);
    } catch {
      return false;
    }
  }

  async get(id) {
    if (this.cache.has(id)) return this.remember(id, this.cache.get(id));
    if (!this.available) return null;
    try {
      const blob = await withStore(STORES.blobs, 'readonly', (store) => ({ __value: req(store.get(id)) }));
      const value = await blob;
      if (value) this.remember(id, value);
      return value || null;
    } catch {
      return null;
    }
  }

  async delete(id) {
    this.cache.delete(id);
    if (!this.available) return;
    try {
      await withStore(STORES.blobs, 'readwrite', (store) => {
        req(store.delete(id));
      });
    } catch {
      /* ignore */
    }
  }

  async keys() {
    if (!this.available) return [...this.cache.keys()];
    try {
      return await withStore(STORES.blobs, 'readonly', (store) => ({ __value: req(store.getAllKeys()) }));
    } catch {
      return [...this.cache.keys()];
    }
  }

  async meta() {
    if (!this.available) return {};
    try {
      return (await withStore(STORES.meta, 'readonly', (store) => ({ __value: req(store.get('meta')) }))) || {};
    } catch {
      return {};
    }
  }

  async setMeta(patch) {
    const current = await this.meta();
    const next = { ...current, ...patch };
    if (!this.available) return next;
    try {
      await withStore(STORES.meta, 'readwrite', (store) => {
        req(store.put(next, 'meta'));
      });
    } catch {
      /* ignore */
    }
    return next;
  }

  /** Removes blobs not referenced by anything. */
  async gc(usedIds) {
    const keep = new Set(usedIds);
    const keys = await this.keys();
    const removed = [];
    for (const key of keys) {
      if (!keep.has(key)) {
        await this.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  remember(id, blob) {
    if (!blob) return blob;
    this.cache.delete(id);
    this.cache.set(id, blob);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    return blob;
  }
}

export const blobs = new BlobStore();

/** Object URL helper with automatic revocation. */
export class UrlPool {
  constructor() {
    this.urls = new Map();
  }

  async fromBlob(key, blob) {
    if (this.urls.has(key)) return this.urls.get(key);
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }

  revoke(key) {
    const url = this.urls.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(key);
    }
  }

  revokeAll() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
