import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp, lerp, slug, formatBytes, formatNumber, formatTime, deepClone, deepEqual,
  debounce, mapRange, escapeHtml,
} from '../src/core/util.js';
import {
  extensionOf, basename, dirname, stem, normalizePath, isJunkPath, fileKind, isSupportedFile,
  mimeForExtension, tokenize, pathTokens, foldersOf, hasExtension,
  foldName, foldPath, stripQuery,
} from '../src/core/paths.js';

test('clamp / lerp / mapRange', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(mapRange(5, 0, 10, 0, 100), 50);
});

test('slug produces safe file names', () => {
  assert.equal(slug('My Scene — Draft'), 'my-scene-draft');
  assert.equal(slug('Ünïcode Île'), 'unicode-ile');
  assert.equal(slug(''), 'item');
  assert.equal(slug('!!!', 'fallback'), 'fallback');
  assert.equal(slug('a'.repeat(10)), 'a'.repeat(10));
});

test('formatBytes scales units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 * 2.5), '2.5 MB');
  assert.equal(formatBytes(-4), '0 B');
  assert.equal(formatBytes('nope'), '0 B');
});

test('formatTime pads correctly', () => {
  assert.equal(formatTime(0), '00:00.00');
  assert.equal(formatTime(65.5), '01:05.50');
  assert.equal(formatTime(-3), '00:00.00');
});

test('formatNumber tolerates junk', () => {
  assert.equal(formatNumber(1500), '1,500');
  assert.equal(formatNumber(undefined), '0');
});

test('deepClone / deepEqual', () => {
  const source = { a: 1, b: [1, 2, { c: 3 }] };
  const copy = deepClone(source);
  assert.notEqual(copy, source);
  assert.ok(deepEqual(copy, source));
  copy.b[2].c = 4;
  assert.ok(!deepEqual(copy, source));
  assert.ok(deepEqual(deepClone(undefined), undefined));
});

test('debounce fires once with the last args', async () => {
  let calls = 0;
  let seen = null;
  const fn = debounce((v) => {
    calls += 1;
    seen = v;
  }, 10);
  fn(1);
  fn(2);
  fn(3);
  assert.equal(calls, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1);
  assert.equal(seen, 3);
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(escapeHtml('"quoted" & \'single\''), '&quot;quoted&quot; &amp; &#39;single&#39;');
});

test('extension / basename / dirname / stem', () => {
  assert.equal(extensionOf('a/b/Crate.GLB'), 'glb');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('.gitignore'), '');
  assert.equal(extensionOf('file.png?v=2'), 'png');
  assert.equal(basename('a/b/c.png'), 'c.png');
  assert.equal(basename('c.png'), 'c.png');
  assert.equal(dirname('a/b/c.png'), 'a/b');
  assert.equal(dirname('c.png'), '');
  assert.equal(stem('a/b.c.png'), 'b.c');
  assert.equal(stripQuery('x.png?y=1#z'), 'x.png');
});

test('dirname + subfolder tests agree (regression: trailing slash bug)', () => {
  const folder = dirname('pack/Chair/chair.glb');
  assert.equal(folder, 'pack/Chair');
  assert.ok('pack/Chair/tex/a.png'.startsWith(`${folder}/`));
});

test('normalizePath resolves dots and separators', () => {
  assert.equal(normalizePath('a\\b\\c.png'), 'a/b/c.png');
  assert.equal(normalizePath('./a/./b//c.png'), 'a/b/c.png');
  assert.equal(normalizePath('a/b/../c.png'), 'a/c.png');
  assert.equal(normalizePath('/leading/slash.png'), 'leading/slash.png');
});

test('isJunkPath catches archive cruft', () => {
  assert.ok(isJunkPath('__MACOSX/._crate.glb'));
  assert.ok(isJunkPath('.DS_Store'));
  assert.ok(isJunkPath('folder/Thumbs.db'));
  assert.ok(isJunkPath('folder/'));
  assert.ok(isJunkPath(''));
  assert.ok(isJunkPath('folder/._hidden'));
  assert.ok(!isJunkPath('models/crate.glb'));
});

test('fileKind classifies supported formats', () => {
  assert.equal(fileKind('a.glb'), 'model');
  assert.equal(fileKind('a.fbx'), 'model');
  assert.equal(fileKind('a.vrm'), 'unknown');
  assert.equal(fileKind('a.drc'), 'unknown');
  assert.equal(fileKind('a.PNG'), 'texture');
  assert.equal(fileKind('a.tga'), 'texture');
  assert.equal(fileKind('scene.atlaszip'), 'project');
  assert.equal(isSupportedFile('a.tga'), true);
  assert.equal(isSupportedFile('scene.atlaszip'), true);
  assert.equal(fileKind('a.hdr'), 'hdri');
  assert.equal(fileKind('a.mtl'), 'material');
  assert.equal(fileKind('a.mp3'), 'audio');
  assert.equal(fileKind('a.txt'), 'unknown');
});

test('mimeForExtension covers the formats we accept', () => {
  assert.equal(mimeForExtension('png'), 'image/png');
  assert.equal(mimeForExtension('GLB'), 'model/gltf-binary');
  assert.equal(mimeForExtension('unknown-ext'), 'application/octet-stream');
});

test('tokenize splits camelCase and snake_case', () => {
  assert.deepEqual(tokenize('WoodPlanks_4K-Final'), ['wood', 'planks', '4', 'k', 'final']);
  assert.deepEqual(pathTokens('pack/chair_BaseColor.png'), ['chair', 'base', 'color']);
  assert.deepEqual(foldersOf('a/B/c/d.png'), ['a', 'b', 'c']);
  assert.ok(hasExtension('x.GLB', ['glb']));
  assert.equal(foldName('Chair_01.png'), 'chair01png');
  assert.equal(foldPath('a/Chair_01.png'), 'chair01png');
});
