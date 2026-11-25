/**
 * A compact, streaming ZIP reader.
 *
 * Why not just `unzipSync`? Because a 1.5 GB texture archive would decompress
 * entirely into memory. This module parses the central directory (a few KB) and
 * then lets the caller stream-compress exactly the entry it wants, via
 * `Blob.slice().stream()`. Supports stored + deflate, ZIP64 and data descriptors.
 *
 * Pure parsing functions are exported separately so they can be unit-tested
 * with hand-built byte arrays.
 */
import { Inflate } from 'fflate';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export const EOCD_MAX_SEARCH = 66 * 1024; // 64KB comment + header

export function findEocd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.length - EOCD_MAX_SEARCH);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen <= bytes.length) return i;
    }
  }
  return -1;
}

/**
 * @param {Uint8Array} bytes tail of the archive (positioned at `tailOffset` in the file)
 * @param {number} tailOffset absolute file offset of bytes[0]
 * @param {number} fileSize
 */
export function readEndRecord(bytes, tailOffset, fileSize) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdIndex = findEocd(bytes);
  if (eocdIndex < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');
  const eocdAbs = tailOffset + eocdIndex;

  let entriesTotal = view.getUint16(eocdIndex + 10, true);
  let cdSize = view.getUint32(eocdIndex + 12, true);
  let cdOffset = view.getUint32(eocdIndex + 16, true);
  let comment = '';
  const commentLen = view.getUint16(eocdIndex + 20, true);
  if (commentLen) {
    comment = new TextDecoder().decode(bytes.subarray(eocdIndex + 22, eocdIndex + 22 + commentLen));
  }

  let needsZip64 = false;
  const locIndex = eocdIndex - 20;
  if (locIndex >= 0 && view.getUint32(locIndex, true) === SIG_EOCD64_LOC) {
    needsZip64 = true;
    const eocd64Offset = Number(view.getBigUint64(locIndex + 8, true));
    const rel = eocd64Offset - tailOffset;
    if (rel >= 0 && rel + 56 <= bytes.length) {
      if (view.getUint32(rel, true) === SIG_EOCD64) {
        entriesTotal = Number(view.getBigUint64(rel + 32, true));
        cdSize = Number(view.getBigUint64(rel + 40, true));
        cdOffset = Number(view.getBigUint64(rel + 48, true));
      }
    } else {
      needsZip64 = 'deferred';
    }
  }

  return {
    eocdAbs,
    entriesTotal,
    cdSize,
    cdOffset,
    comment,
    needsZip64,
    fileSize: fileSize ?? tailOffset + bytes.length,
  };
}

/**
 * Parses a central directory buffer into entry records.
 * @param {Uint8Array} bytes
 */
export function parseCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let ptr = 0;
  while (ptr + 46 <= bytes.length) {
    const sig = view.getUint32(ptr, true);
    if (sig !== SIG_CENTRAL) break;
    const flags = view.getUint16(ptr + 8, true);
    const method = view.getUint16(ptr + 10, true);
    const crc = view.getUint32(ptr + 16, true);
    let compressedSize = view.getUint32(ptr + 20, true);
    let uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    let localOffset = view.getUint32(ptr + 42, true);
    const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
    const name = decoder.decode(nameBytes);
    const extra = bytes.subarray(ptr + 46 + nameLen, ptr + 46 + nameLen + extraLen);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const z64 = parseZip64Extra(extra, uncompressedSize, compressedSize, localOffset);
      if (z64) {
        uncompressedSize = z64.uncompressedSize ?? uncompressedSize;
        compressedSize = z64.compressedSize ?? compressedSize;
        localOffset = z64.localOffset ?? localOffset;
      }
    }

    entries.push({
      path: name,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      encrypted: Boolean(flags & 1),
      directory: name.endsWith('/'),
    });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function parseZip64Extra(extra, uncompressedSize, compressedSize, localOffset) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let ptr = 0;
  while (ptr + 4 <= extra.length) {
    const id = view.getUint16(ptr, true);
    const size = view.getUint16(ptr + 2, true);
    if (id === 0x0001) {
      const out = {};
      let p = ptr + 4;
      if (uncompressedSize === 0xffffffff && p + 8 <= extra.length) {
        out.uncompressedSize = Number(view.getBigUint64(p, true));
        p += 8;
      }
      if (compressedSize === 0xffffffff && p + 8 <= extra.length) {
        out.compressedSize = Number(view.getBigUint64(p, true));
        p += 8;
      }
      if (localOffset === 0xffffffff && p + 8 <= extra.length) {
        out.localOffset = Number(view.getBigUint64(p, true));
        p += 8;
      }
      return out;
    }
    ptr += 4 + size;
  }
  return null;
}

/** Reads the local file header to find where the payload starts. */
export function parseLocalHeader(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30 || view.getUint32(0, true) !== SIG_LOCAL) {
    throw new Error(`Bad local header at offset ${offset}.`);
  }
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLen));
  return {
    offset,
    dataOffset: offset + 30 + nameLen + extraLen,
    method,
    flags,
    name,
    encrypted: Boolean(flags & 1),
  };
}

/** CRC-32 (used to verify a streamed entry on demand). */
let crcTable = null;
export function crc32(bytes, seed = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Browser-side reader. `openZip(blob)` reads only the tail + central directory,
 * keeping memory flat regardless of archive size.
 */
export class ZipReader {
  constructor(blob) {
    this.blob = blob;
    this.entries = [];
    this.end = null;
    this.index = new Map();
  }

  async open() {
    const size = this.blob.size;
    if (size < 22) throw new Error('File is too small to be a ZIP archive.');
    const tailLength = Math.min(size, EOCD_MAX_SEARCH + 20 * 3);
    let tailBytes = new Uint8Array(await this.blob.slice(size - tailLength).arrayBuffer());
    let tailOffset = size - tailLength;
    let end = readEndRecord(tailBytes, tailOffset, size);

    if (end.needsZip64 === 'deferred') {
      // ZIP64 locator points outside our tail window.
      const eocd64Pos = Number(new DataView(tailBytes.buffer).getBigUint64(tailBytes.length - 20 + 8, true));
      const len = 56;
      tailBytes = new Uint8Array(await this.blob.slice(eocd64Pos, eocd64Pos + len).arrayBuffer());
      tailOffset = eocd64Pos;
      const view = new DataView(tailBytes.buffer);
      end = {
        ...end,
        entriesTotal: Number(view.getBigUint64(32, true)),
        cdSize: Number(view.getBigUint64(40, true)),
        cdOffset: Number(view.getBigUint64(48, true)),
      };
    }

    if (end.cdOffset + end.cdSize > size) {
      throw new Error('ZIP central directory is out of range — the file may be truncated.');
    }
    const cdBytes = new Uint8Array(
      await this.blob.slice(end.cdOffset, end.cdOffset + end.cdSize).arrayBuffer(),
    );
    this.entries = parseCentralDirectory(cdBytes);
    for (const entry of this.entries) this.index.set(entry.path, entry);
    this.end = end;
    return this;
  }

  get fileCount() {
    return this.entries.filter((e) => !e.directory).length;
  }

  list() {
    return this.entries.filter((e) => !e.directory);
  }

  has(path) {
    return this.index.has(path);
  }

  /** Streams + inflates a single entry. Never loads the whole archive. */
  async read(path, { onProgress, verify = false } = {}) {
    const entry = this.index.get(path);
    if (!entry) throw new Error(`"${path}" is not in the archive.`);
    if (entry.encrypted) throw new Error(`"${path}" is password protected.`);

    const head = new Uint8Array(await this.blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    const header = parseLocalHeader(head, entry.localOffset);
    const start = header.dataOffset;
    const end = start + entry.compressedSize;
    const source = this.blob.slice(start, end, 'application/octet-stream');

    let bytes;
    if (entry.method === 0) {
      bytes = new Uint8Array(await source.arrayBuffer());
    } else if (entry.method === 8) {
      bytes = await inflateStream(source, entry.uncompressedSize, onProgress);
    } else {
      throw new Error(`Unsupported compression method ${entry.method} for "${path}".`);
    }
    if (verify && crc32(bytes) !== entry.crc) {
      throw new Error(`CRC mismatch for "${path}".`);
    }
    return bytes;
  }

  /** Returns an extracted Blob, slicing stored entries without copying bytes. */
  async readBlob(path, { verify = false, type = 'application/octet-stream' } = {}) {
    const entry = this.index.get(path);
    if (!entry) throw new Error(`"${path}" is not in the archive.`);
    if (entry.encrypted) throw new Error(`"${path}" is password protected.`);

    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`Unsupported compression method ${entry.method} for "${path}".`);
    }

    const head = new Uint8Array(await this.blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    const header = parseLocalHeader(head, entry.localOffset);
    if (header.method !== entry.method || header.encrypted) throw new Error(`Invalid local header for "${path}".`);
    const start = header.dataOffset;
    const end = start + entry.compressedSize;
    if (start < 0 || end > this.blob.size) throw new Error(`Payload is out of range for "${path}".`);
    const source = this.blob.slice(start, end);

    if (entry.method === 8) {
      if (typeof DecompressionStream === 'function') {
        const output = source.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const reader = output.getReader();
        const chunks = [];
        let size = 0;
        let checksum = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > entry.uncompressedSize) throw new Error(`Size mismatch for "${path}".`);
          if (verify) checksum = crc32(value, checksum);
          chunks.push(value);
        }
        if (size !== entry.uncompressedSize) throw new Error(`Size mismatch for "${path}".`);
        if (verify && checksum !== entry.crc) throw new Error(`CRC mismatch for "${path}".`);
        return new Blob(chunks, { type });
      }
      const bytes = await this.read(path, { verify });
      return new Blob([bytes], { type });
    }

    if (source.size !== entry.uncompressedSize) throw new Error(`Size mismatch for "${path}".`);
    if (verify) {
      let checksum = 0;
      const stream = source.stream().getReader();
      for (;;) {
        const { done, value } = await stream.read();
        if (done) break;
        checksum = crc32(value, checksum);
      }
      if (checksum !== entry.crc) throw new Error(`CRC mismatch for "${path}".`);
    }
    return source.slice(0, source.size, type);
  }
}

/**
 * Incremental DEFLATE using the platform's DecompressionStream when available
 * (streaming, zero JS overhead), falling back to fflate's Inflate.
 */
export async function inflateStream(blob, expectedSize, onProgress) {
  if (typeof DecompressionStream === 'function') {
    const out = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return collectStream(out, expectedSize, onProgress);
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    const inflate = new Inflate((chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (onProgress) onProgress(total, expectedSize);
    });
    inflate.push(new Uint8Array(0));
    const reader = blob.stream().getReader();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          inflate.push(value);
        }
        inflate.push(new Uint8Array(0), true);
        resolve();
      } catch (err) {
        reject(err);
      }
    })();
  });
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

async function collectStream(stream, expectedSize, onProgress) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (onProgress) onProgress(total, expectedSize);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
