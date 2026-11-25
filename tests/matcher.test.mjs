import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectMapType, detectUdim, identityTokens, materialTokens, jaccard,
  tokenOverlap, stripNoise, matchTextures, groupUdim, identityString,
} from '../src/core/matcher.js';

const model = (id, path, materials) => ({ id, path, materials });
const mat = (id, name, meshNames = []) => ({ id, name, meshNames });
const tex = (id, path) => ({ id, path });

test('detectMapType understands common naming conventions', () => {
  const cases = {
    'wood_BaseColor.png': 'baseColor',
    'wood_base_color.jpg': 'baseColor',
    'Wood_Albedo.png': 'baseColor',
    'wood_diffuse.png': 'baseColor',
    'wood_Normal.png': 'normal',
    'wood_nrm.png': 'normal',
    'wood_NormalGL.png': 'normal',
    'wood_Roughness.png': 'roughness',
    'wood_Rough.png': 'roughness',
    'wood_Metallic.png': 'metalness',
    'wood_Metalness.png': 'metalness',
    'wood_AO.png': 'ao',
    'wood_AmbientOcclusion.png': 'ao',
    'wood_Emissive.png': 'emissive',
    'wood_Opacity.png': 'opacity',
    'wood_Displacement.png': 'displacement',
    'wood_height.png': 'displacement',
    'wood_ORM.png': 'orm',
    'wood_specular.png': 'specular',
    'crate_n.png': 'normal',
    'crate_c.png': 'baseColor',
    'wood_Glossiness.png': 'roughness',
  };
  for (const [file, slot] of Object.entries(cases)) {
    assert.equal(detectMapType(file).slot, slot, file);
  }
  assert.equal(detectMapType('untitled.png').slot, null);
  assert.equal(detectMapType('render_final.png').slot, null);
});

test('packed ORM maps expose their channels', () => {
  const result = detectMapType('wood_ORM.png');
  assert.equal(result.slot, 'orm');
  assert.deepEqual(result.packed, ['ao', 'roughness', 'metalness']);
  assert.deepEqual(detectMapType('wood_ARM.png').packed, ['ao', 'roughness', 'metalness']);
  assert.deepEqual(detectMapType('wood_RMA.png').packed, ['roughness', 'metalness', 'ao']);
});

test('glossiness is reported as roughness + inverted flag', () => {
  const result = detectMapType('panel_Gloss.png');
  assert.equal(result.slot, 'roughness');
  assert.equal(result.inverted, true);
});

test('identityTokens drops map types, resolutions and folders', () => {
  assert.deepEqual(identityTokens('pack/Chair/wood_BaseColor_4K.png'), ['wood']);
  assert.deepEqual(identityTokens('hero_Normal_2048.png'), ['hero']);
  assert.deepEqual(identityTokens('Chair/chair_BaseColor.png'), ['chair']);
  assert.deepEqual(identityTokens('crate.png'), ['crate']);
});

test('materialTokens drops generic engine names', () => {
  assert.deepEqual(materialTokens('Material.001'), []);
  assert.deepEqual(materialTokens('default'), ['default']);
  assert.deepEqual(materialTokens('Wood_Planks'), ['wood', 'planks']);
  assert.deepEqual(materialTokens('Mesh001'), ['mesh001']);
});

test('stripNoise removes resolution tokens only', () => {
  assert.deepEqual(stripNoise(['wood', '4k', '1024', 'final', 'planks']), ['wood', 'planks']);
});

test('jaccard and tokenOverlap are symmetric-ish scorers', () => {
  assert.equal(jaccard(['a'], ['a']), 1);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard([], []), 0);
  assert.ok(tokenOverlap(['wood'], ['wooden']) > 0.5);
  assert.ok(tokenOverlap(['wood'], ['metal']) === 0);
});

test('detectUdim recognises tiles', () => {
  assert.deepEqual(detectUdim('wood.1001.png'), { tile: 1001, udim: 1001 });
  assert.equal(detectUdim('wood.1003.png').tile, 1003);
  assert.equal(detectUdim('wood.png'), null);
  assert.equal(detectUdim('wood.2024.png'), null);
});

test('groupUdim clusters a tile set', () => {
  const groups = groupUdim([
    { id: 'a', path: 'wood.1001.png' },
    { id: 'b', path: 'wood.1002.png' },
    { id: 'c', path: 'metal.1001.png' },
    { id: 'd', path: 'loose.png' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.base.startsWith('wood')).tiles.length, 2);
});

/* ------------------------------------------------------------------ */
/* end-to-end matching scenarios                                      */
/* ------------------------------------------------------------------ */

test('textures named after the model snap onto material slots', () => {
  const result = matchTextures({
    models: [model('a1', 'chair/chair.glb', [mat('m1', 'Wood', ['CrateMesh']), mat('m2', 'Metal_Band', ['BandMesh'])])],
    textures: [
      tex('t1', 'chair/textures/chair_BaseColor.png'),
      tex('t2', 'chair/textures/chair_Normal.png'),
      tex('t3', 'chair/textures/chair_Roughness.png'),
    ],
  });
  assert.equal(result.assignments.length, 3);
  const slots = result.assignments.map((a) => a.slot).sort();
  assert.deepEqual(slots, ['baseColor', 'normal', 'roughness']);
  for (const assignment of result.assignments) {
    assert.equal(assignment.materialId, 'm1');
    assert.ok(assignment.confidence >= 42);
    assert.ok(assignment.reason.length > 0);
  }
});

test('textures named after the material win over other materials', () => {
  const result = matchTextures({
    models: [model('a2', 'crate.glb', [mat('m3', 'Wood'), mat('m4', 'Metal_Band')])],
    textures: [
      tex('t4', 'wood_BaseColor.png'),
      tex('t5', 'wood_Normal.png'),
      tex('t6', 'metal_Band_BaseColor.png'),
    ],
  });
  const byTexture = new Map(result.assignments.map((a) => [a.textureId, a]));
  assert.equal(byTexture.get('t4').materialId, 'm3');
  assert.equal(byTexture.get('t5').materialId, 'm3');
  if (byTexture.get('t6')) assert.equal(byTexture.get('t6').materialId, 'm4');
});

test('unrelated textures are left alone', () => {
  const result = matchTextures({
    models: [model('a3', 'crate.glb', [mat('m1', 'Wood'), mat('m2', 'Metal')])],
    textures: [tex('t1', 'skybox_sunset.png')],
  });
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unassigned.length, 1);
});

test('single-material models accept unlabelled textures', () => {
  const result = matchTextures({
    models: [model('a4', 'Props/Vase.obj', [mat('m5', 'material_0', ['Vase'])])],
    textures: [tex('t7', 'Props/ceramic.png')],
  });
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].slot, 'baseColor');
});

test('a material never receives two textures in the same slot', () => {
  const result = matchTextures({
    models: [model('a5', 'crate.glb', [mat('m1', 'Wood')])],
    textures: [tex('t1', 'wood_BaseColor_4k.png'), tex('t2', 'wood_BaseColor_2k.png')],
  });
  const slots = result.assignments.map((a) => `${a.materialId}:${a.slot}`);
  assert.equal(new Set(slots).size, slots.length);
});

test('empty inputs are safe', () => {
  assert.deepEqual(matchTextures({}).assignments, []);
  assert.deepEqual(matchTextures({ models: [], textures: [] }).assignments, []);
  assert.deepEqual(matchTextures({ models: [model('a', 'x.glb', [])], textures: [tex('t', 'y.png')] }).assignments, []);
});

test('identityString of a texture and material line up', () => {
  assert.equal(identityString('wood_BaseColor.png'), identityString('Wood'));
});
