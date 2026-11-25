import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createProjectBundle, readProjectBundle, referencedBlobIds, bundleBlobPath, PROJECT_DOCUMENT_PATH } from '../src/core/projectBundle.js';

const project = {
  schema: 1,
  meta: { name: 'Portable chair' },
  objects: [{ id: 'object-1', kind: 'model', assetId: 'asset-1' }],
  assets: [{ id: 'asset-1', blobId: 'model-content-hash', kind: 'model' }],
  materials: {
    'material-1': {
      textures: {
        baseColor: { blobId: 'texture-content-hash' },
        normal: { blobId: 'texture-content-hash' },
      },
    },
  },
};

test('bundle asset references are unique and include material textures', () => {
  assert.deepEqual(referencedBlobIds(project), ['model-content-hash', 'texture-content-hash']);
  assert.equal(bundleBlobPath('texture-content-hash'), 'assets/texture-content-hash.blob');
});

test('portable project bundle round-trips document and assets', async () => {
  const sources = new Map([
    ['model-content-hash', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'model/gltf-binary' })],
    ['texture-content-hash', new Blob([new Uint8Array(24).fill(7)], { type: 'image/png' })],
  ]);
  const progress = [];
  const bundle = await createProjectBundle(project, (id) => sources.get(id), {
    onProgress: (event) => progress.push(event),
  });

  assert.equal(bundle.type, 'application/zip');
  assert.ok(bundle.size > 100);
  assert.ok(progress.length >= 3);
  const { document, entries } = await readProjectBundle(bundle);
  assert.deepEqual(document, project);
  assert.deepEqual(entries.map((entry) => entry.id), referencedBlobIds(project));
  assert.deepEqual([...new Uint8Array(await entries[0].blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(await entries[1].blob.arrayBuffer())], new Array(24).fill(7));
});

test('portable bundle fails clearly if a referenced asset is missing', async () => {
  await assert.rejects(
    createProjectBundle(project, async () => null),
    /asset is missing from local storage/,
  );
});

test('reader rejects ZIP files that are not Atlas bundles', async () => {
  const unrelated = new Blob([zipSync({ 'notes.txt': strToU8('hello') })]);
  await assert.rejects(readProjectBundle(unrelated), /not an Atlas project bundle/);
});

test('bundle reader streams and verifies deflated asset entries too', async () => {
  const document = { schema: 1, objects: [], assets: [{ blobId: 'packed-texture' }], materials: {} };
  const payload = new Uint8Array(512 * 1024).fill(13);
  const zip = zipSync({
    [PROJECT_DOCUMENT_PATH]: strToU8(JSON.stringify(document)),
    [bundleBlobPath('packed-texture')]: payload,
  }, { level: 6 });
  const result = await readProjectBundle(new Blob([zip]));
  assert.equal(result.entries[0].blob.size, payload.length);
  assert.deepEqual(new Uint8Array(await result.entries[0].blob.slice(0, 128).arrayBuffer()), payload.slice(0, 128));
});
