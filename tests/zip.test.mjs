import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8, unzipSync } from 'fflate';

import {
  planArchive, looksLikeZip, friendlyName, nameAffinity,
} from '../src/core/zipPlan.js';
import {
  ZipReader, readEndRecord, parseCentralDirectory, parseLocalHeader,
  crc32, inflateStream, EOCD_MAX_SEARCH,
} from '../src/assets/zipReader.js';

/* ------------------------------------------------------------------ */
/* a tiny deterministic fixture (built in-process, no binary in repo)  */
/* ------------------------------------------------------------------ */

const pngBytes = new Uint8Array(512).fill(7);
const glbBytes = new Uint8Array(2048);
for (let i = 0; i < glbBytes.length; i += 1) glbBytes[i] = (i * 31) % 251;

const fixtureFiles = {
  'pack/Chair/chair.glb': glbBytes,
  'pack/Chair/tex/Chair_BaseColor.png': pngBytes,
  'pack/Chair/tex/Chair_Normal.png': pngBytes,
  'pack/Chair/tex/Chair_Roughness.png': pngBytes,
  'pack/Table/table.obj': strToU8('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
  'pack/Table/table.mtl': strToU8('newmtl Wood\nKd 1 1 1\n'),
  'pack/Table/tex/table_BaseColor.png': pngBytes,
  'pack/loose/sky.hdr': new Uint8Array(64).fill(3),
  'pack/notes.txt': strToU8('nothing to see'),
  '__MACOSX/._chair.glb': strToU8('junk'),
  'pack/.DS_Store': new Uint8Array(4),
};

/** Blob shim with `slice()` + `arrayBuffer()` + `stream()`, as browsers give us. */
function makeBlob(bytes) {
  const data = new Uint8Array(bytes);
  const slice = (start = 0, end = data.length) => makeBlob(data.slice(start, end));
  return {
    size: data.length,
    slice,
    async arrayBuffer() {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
    },
    stream() {
      let offset = 0;
      const chunk = 512;
      return new ReadableStream({
        pull(controller) {
          if (offset >= data.length) {
            controller.close();
            return;
          }
          controller.enqueue(data.slice(offset, offset + chunk));
          offset += chunk;
        },
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* parsing                                                            */
/* ------------------------------------------------------------------ */

test('crc32 matches known vectors', () => {
  assert.equal(crc32(strToU8('')), 0);
  assert.equal(crc32(strToU8('123456789')), 0xcbf43926);
});

test('readEndRecord finds the central directory', () => {
  const bytes = zipSync({ 'a.txt': strToU8('hello') });
  const end = readEndRecord(bytes, 0, bytes.length);
  assert.ok(end.entriesTotal >= 1);
  assert.ok(end.cdOffset > 0);
  assert.ok(end.cdOffset + end.cdSize <= bytes.length);
});

test('parseCentralDirectory lists every entry', () => {
  const zip = zipSync(fixtureFiles);
  const end = readEndRecord(zip, 0, zip.length);
  const entries = parseCentralDirectory(zip.subarray(end.cdOffset, end.cdOffset + end.cdSize));
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, Object.keys(fixtureFiles).sort());
  for (const entry of entries) {
    assert.equal(entry.method === 0 || entry.method === 8, true, `method ${entry.method}`);
    assert.equal(entry.encrypted, false);
  }
});

test('parseLocalHeader points at the payload', () => {
  const zip = zipSync({ 'a.txt': strToU8('hello world') });
  const end = readEndRecord(zip, 0, zip.length);
  const [entry] = parseCentralDirectory(zip.subarray(end.cdOffset, end.cdOffset + end.cdSize));
  const header = parseLocalHeader(zip.subarray(entry.localOffset), entry.localOffset);
  assert.equal(header.name, 'a.txt');
  assert.ok(header.dataOffset > entry.localOffset);
});

/* ------------------------------------------------------------------ */
/* streaming reader                                                   */
/* ------------------------------------------------------------------ */

test('ZipReader round-trips stored and deflated entries', async () => {
  const zip = zipSync(fixtureFiles, { level: 6 });
  const reader = await new ZipReader(makeBlob(zip)).open();
  assert.equal(reader.fileCount, Object.keys(fixtureFiles).length);

  const glb = await reader.read('pack/Chair/chair.glb', { verify: true });
  assert.deepEqual([...glb], [...glbBytes]);

  const text = await reader.read('pack/Table/table.obj', { verify: true });
  assert.match(new TextDecoder().decode(text), /^v 0 0 0/);

  const notFound = await reader.read('nope.glb').then(() => null, (err) => err.message);
  assert.match(notFound, /not in the archive/);
});

test('ZipReader rejects non-zip input', async () => {
  const reader = new ZipReader(makeBlob(strToU8('not a zip at all, sorry!')));
  await assert.rejects(reader.open(), /Not a ZIP|too small/i);
});

test('ZipReader rejects truncated archives', async () => {
  const zip = zipSync(fixtureFiles);
  const truncated = zip.slice(0, Math.floor(zip.length / 2));
  const reader = new ZipReader(makeBlob(truncated));
  await assert.rejects(reader.open());
});

test('inflateStream handles a large deflated payload', async () => {
  const big = new Uint8Array(300 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 256;
  const zip = zipSync({ 'big.bin': big }, { level: 9 });
  const end = readEndRecord(zip, 0, zip.length);
  const [entry] = parseCentralDirectory(zip.subarray(end.cdOffset, end.cdOffset + end.cdSize));
  const header = parseLocalHeader(zip.subarray(entry.localOffset), entry.localOffset);
  const payload = makeBlob(zip.slice(header.dataOffset, header.dataOffset + entry.compressedSize));
  const out = await inflateStream(payload, entry.uncompressedSize);
  assert.equal(out.length, big.length);
  assert.deepEqual([...out.slice(0, 64)], [...big.slice(0, 64)]);
});

test('EOCD search window covers long comments', () => {
  assert.ok(EOCD_MAX_SEARCH > 65_536);
});

/* ------------------------------------------------------------------ */
/* planner                                                            */
/* ------------------------------------------------------------------ */

test('planArchive classifies, skips junk and pairs textures', () => {
  const plan = planArchive(Object.entries(fixtureFiles).map(([path, data]) => ({ path, size: data.length })));
  assert.equal(plan.stats.models, 2);
  assert.equal(plan.stats.textures, 5);
  assert.ok(plan.skipped.some((s) => s.reason === 'junk'));
  assert.ok(plan.skipped.some((s) => s.reason === 'unsupported'));

  const chair = plan.models.find((m) => m.path.endsWith('chair.glb'));
  assert.deepEqual(
    chair.texturePaths.sort(),
    ['pack/Chair/tex/Chair_BaseColor.png', 'pack/Chair/tex/Chair_Normal.png', 'pack/Chair/tex/Chair_Roughness.png'],
  );

  const table = plan.models.find((m) => m.path.endsWith('table.obj'));
  assert.ok(table.sidecars.includes('pack/Table/table.mtl'));
  assert.deepEqual(plan.looseTextures, ['pack/loose/sky.hdr']);
});

test('planArchive with only textures reports it', () => {
  const plan = planArchive([
    { path: 'tex/a.png', size: 1 },
    { path: 'tex/b.png', size: 1 },
  ]);
  assert.equal(plan.stats.models, 0);
  assert.equal(plan.stats.textures, 2);
  assert.ok(plan.notes.some((n) => /No models found/.test(n)));
});

test('planArchive picks the deepest folder for a texture', () => {
  const plan = planArchive([
    { path: 'Pack/chair.glb', size: 1 },
    { path: 'Pack/Sub/table.glb', size: 1 },
    { path: 'Pack/Sub/table_BaseColor.png', size: 1 },
  ]);
  const owner = plan.textures.find((t) => t.path.includes('table_BaseColor')).owner;
  assert.equal(owner, 'Pack/Sub/table.glb');
});

test('planArchive handles an empty archive', () => {
  const plan = planArchive([]);
  assert.equal(plan.stats.files, 0);
  assert.deepEqual(plan.models, []);
  assert.deepEqual(plan.textures, []);
});

test('looksLikeZip and friendlyName', () => {
  assert.ok(looksLikeZip('pack.ZIP'));
  assert.ok(looksLikeZip('scene.atlaszip'));
  assert.ok(!looksLikeZip('model.glb'));
  assert.equal(friendlyName('Pack/Chair_01-final.glb'), 'Chair 01 final');
});

test('nameAffinity scores shared tokens', () => {
  assert.ok(nameAffinity('chair/textures/chair_BaseColor.png', 'chair/chair.glb') > 0.4);
  assert.equal(nameAffinity('sky.png', 'chair.glb'), 0);
});

test('planner output survives JSON', () => {
  const plan = planArchive(Object.entries(fixtureFiles).map(([path, data]) => ({ path, size: data.length })));
  const round = JSON.parse(JSON.stringify(plan));
  assert.equal(round.stats.models, plan.stats.models);
  assert.deepEqual(round.looseTextures, plan.looseTextures);
});

test('real zips round-trip through unzipSync for parity', () => {
  const zip = zipSync(fixtureFiles, { level: 6 });
  const back = unzipSync(zip);
  assert.equal(Object.keys(back).length, Object.keys(fixtureFiles).length);
});
