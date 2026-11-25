import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store, History } from '../src/core/store.js';
import { createInitialState, createObjectNode, SCHEMA_VERSION } from '../src/core/schema.js';

test('get / set / patch nested state', () => {
  const store = new Store({ a: { b: { c: 1 } }, list: [1, 2] });
  assert.equal(store.get('a.b.c'), 1);
  assert.equal(store.get('a.b.missing', 'fallback'), 'fallback');
  store.set('a.b.c', 5);
  assert.equal(store.get('a.b.c'), 5);
  store.set('a.b.d', 2);
  assert.equal(store.get('a.b.d'), 2);
  store.patch({ a: { b: { c: 9 } } });
  assert.equal(store.get('a.b.c'), 9);
  store.push('list', 3);
  assert.deepEqual(store.get('list'), [1, 2, 3]);
  store.removeWhere('list', (v) => v === 2);
  assert.deepEqual(store.get('list'), [1, 3]);
});

test('setting an equal value does not notify', () => {
  const store = new Store({ a: { b: 1 } });
  let calls = 0;
  store.subscribe(() => going(), 'a.b');
  const going = () => {
    calls += 1;
  };
  store.set('a.b', 1);
  assert.equal(calls, 0);
  store.set('a.b', 2);
  assert.equal(calls, 1);
});

test('path subscriptions are scoped but include ancestors/descendants', () => {
  const store = new Store({ obj: { pos: [0, 0, 0], name: 'x' }, other: 1 });
  const seen = [];
  store.subscribe((_s, path) => seen.push(path), 'obj');
  store.set('obj.pos', [1, 1, 1]);
  store.set('obj.name', 'y');
  store.set('other', 2);
  assert.deepEqual(seen, ['obj.pos', 'obj.name']);
});

test('batch notifies once per path', () => {
  const store = new Store({ a: 0, b: 0 });
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  store.batch(() => {
    store.set('a', 1);
    store.set('b', 2);
  });
  assert.equal(calls, 2);
});

test('snapshot / replace round-trips', () => {
  const store = new Store({ a: { deep: [1, 2, 3] } });
  const snap = store.snapshot();
  assert.deepEqual(snap, store.state);
  snap.a.deep.push(4);
  assert.deepEqual(store.get('a.deep'), [1, 2, 3]);
  store.replace(snap);
  assert.deepEqual(store.get('a.deep'), [1, 2, 3, 4]);
});

test('history records, undoes and redoes', () => {
  const store = new Store({ value: 0 });
  const history = new History(store);
  store.set('value', 1);
  assert.ok(history.commit('one'));
  store.set('value', 2);
  assert.ok(history.commit('two'));
  assert.equal(store.get('value'), 2);

  assert.equal(history.undo(), 'two');
  assert.equal(store.get('value'), 1);
  assert.equal(history.undo(), 'one');
  assert.equal(store.get('value'), 0);
  assert.equal(history.undo(), null);

  assert.equal(history.redo(), 'one');
  assert.equal(store.get('value'), 1);
});

test('history ignores no-op commits and clears redo on new edits', () => {
  const store = new Store({ value: 0 });
  const history = new History(store);
  assert.equal(history.commit('nope'), false);
  store.set('value', 1);
  history.commit('a');
  history.undo();
  store.set('value', 5);
  history.commit('b');
  assert.equal(history.canRedo, false);
});

test('history respects its limit', () => {
  const store = new Store({ value: 0 });
  const history = new History(store, { limit: 3 });
  for (let i = 1; i <= 6; i += 1) {
    store.set('value', i);
    history.commit(`v${i}`);
  }
  assert.equal(history.past.length, 3);
});

test('initial state is complete and serialisable', () => {
  const state = createInitialState();
  assert.equal(state.meta.version, SCHEMA_VERSION);
  assert.ok(Array.isArray(state.objects));
  assert.ok(Array.isArray(state.assets));
  assert.ok(state.render.bloom);
  assert.equal(state.render.softShadows, false);
  assert.ok(state.environment.theme);
  assert.ok(state.ui.gizmoMode);
  assert.ok(state.timeline);
  // must survive a JSON round-trip (it's what we save to disk)
  const json = JSON.parse(JSON.stringify(state));
  assert.deepEqual(json.objects, state.objects);
  assert.equal(typeof state.camera.position[0], 'number');
});

test('createObjectNode fills sane defaults', () => {
  const node = createObjectNode({ name: 'Thing' });
  assert.equal(node.name, 'Thing');
  assert.deepEqual(node.position, [0, 0, 0]);
  assert.deepEqual(node.scale, [1, 1, 1]);
  assert.equal(node.visible, true);
  assert.equal(node.kind, 'mesh');
  assert.ok(node.id.startsWith('obj_'));
});

test('object ids are unique', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(createObjectNode({}).id);
  assert.equal(ids.size, 500);
});
