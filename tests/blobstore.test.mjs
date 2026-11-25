import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashBlob } from '../src/core/blobstore.js';

test('hashBlob is stable across Blob and typed-array inputs', async () => {
  const bytes = new TextEncoder().encode('atlas scene assets');
  const withOffset = new Uint8Array(bytes.length + 4);
  withOffset.set(bytes, 2);
  const view = withOffset.subarray(2, 2 + bytes.length);

  assert.equal(await hashBlob(new Blob([bytes])), await hashBlob(view));
});

test('hashBlob handles large inputs in bounded, deterministic chunks', async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024 + 17);
  bytes[0] = 19;
  bytes[bytes.length - 1] = 71;
  const blobId = await hashBlob(new Blob([bytes]));
  assert.match(blobId, /^[a-f\d]{64}$/);
  assert.equal(await hashBlob(bytes), blobId);

  bytes[bytes.length - 1] ^= 1;
  assert.notEqual(await hashBlob(bytes), blobId);
});
