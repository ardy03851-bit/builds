import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createInitialState, createObjectNode } from '../src/core/schema.js';
import { Store, History } from '../src/core/store.js';
import { SceneManager } from '../src/app/scene.js';
import { Engine } from '../src/engine/engine.js';

function makeScene() {
  const store = new Store(createInitialState());
  const history = new History(store);
  const engine = {
    root: new THREE.Group(),
    objectMap: new Map(),
    syncFromStore() {},
    syncSelection() {},
  };
  const app = {
    store,
    history,
    engine,
    animation: { unregister() {}, clear() {} },
    billboards: { sync() {} },
    emit() {},
  };
  const scene = new SceneManager(app);
  return { store, history, engine, scene };
}

function addLiveNode(store, engine, node, position = node.position) {
  store.push('objects', node);
  const object = new THREE.Group();
  object.position.fromArray(position);
  object.rotation.set(...node.rotation);
  object.scale.fromArray(node.scale);
  engine.root.add(object);
  engine.objectMap.set(node.id, object);
  engine.root.updateMatrixWorld(true);
  return object;
}

test('visibility and lock changes are undoable and redoable', () => {
  const { store, history, scene } = makeScene();
  const node = createObjectNode({ id: 'object-1', name: 'Cube' });
  store.push('objects', node);
  history.sync();

  scene.toggleVisibility(node.id);
  assert.equal(store.get('objects.0.visible'), false);
  assert.equal(history.canUndo, true);
  history.undo();
  assert.equal(store.get('objects.0.visible'), true);
  history.redo();
  assert.equal(store.get('objects.0.visible'), false);

  scene.toggleLock(node.id);
  assert.equal(store.get('objects.0.locked'), true);
  history.undo();
  assert.equal(store.get('objects.0.locked'), false);
  history.redo();
  assert.equal(store.get('objects.0.locked'), true);
});

test('group and ungroup preserve child world transforms', () => {
  const { store, history, engine, scene } = makeScene();
  const first = createObjectNode({ id: 'a', name: 'A', position: [2, 1, -1], rotation: [0.2, 0.3, 0] });
  const second = createObjectNode({ id: 'b', name: 'B', position: [-3, 2, 4] });
  const firstObject = addLiveNode(store, engine, first);
  const secondObject = addLiveNode(store, engine, second);
  store.set('selection', [first.id, second.id]);
  history.sync();

  const group = scene.groupSelection();
  assert.equal(group.kind, 'group');
  assert.deepEqual(store.get('objects').filter((node) => node.id === 'a' || node.id === 'b').map((node) => node.parentId), [group.id, group.id]);
  assert.deepEqual(store.get('selection'), [group.id]);
  assert.deepEqual(store.get('objects').find((node) => node.id === 'a').position, first.position);
  assert.deepEqual(store.get('objects').find((node) => node.id === 'b').position, second.position);

  // Model the new root/child relation before asking the scene manager to ungroup.
  const groupObject = new THREE.Group();
  engine.root.add(groupObject);
  engine.objectMap.set(group.id, groupObject);
  groupObject.add(firstObject, secondObject);
  engine.root.updateMatrixWorld(true);
  assert.equal(scene.ungroup([group.id]), true);
  assert.equal(store.get('objects').find((node) => node.id === 'a').parentId, null);
  assert.equal(store.get('objects').find((node) => node.id === 'b').parentId, null);
  assert.deepEqual(store.get('objects').find((node) => node.id === 'a').position, first.position);
  assert.deepEqual(store.get('objects').find((node) => node.id === 'b').position, second.position);
});

test('reparent keeps world position and refuses a parent cycle', () => {
  const { store, history, engine, scene } = makeScene();
  const parent = createObjectNode({ id: 'parent', name: 'Parent', position: [10, 0, 0] });
  const child = createObjectNode({ id: 'child', name: 'Child', position: [2, 0, 0] });
  const parentObject = addLiveNode(store, engine, parent);
  addLiveNode(store, engine, child);
  parentObject.position.set(10, 0, 0);
  engine.root.updateMatrixWorld(true);
  history.sync();

  scene.setParent(child.id, parent.id);
  assert.deepEqual(store.get('objects').find((node) => node.id === child.id).position, [-8, 0, 0]);
  const previous = store.get('objects');
  scene.setParent(parent.id, child.id);
  assert.deepEqual(store.get('objects'), previous);
});

test('engine sync attaches children even when they precede parents in state', () => {
  const store = new Store(createInitialState());
  const parent = createObjectNode({ id: 'parent', kind: 'group', name: 'Parent' });
  const child = createObjectNode({ id: 'child', kind: 'group', name: 'Child', parentId: parent.id });
  store.set('objects', [child, parent]);

  const engine = Object.create(Engine.prototype);
  engine.store = store;
  engine.objectMap = new Map();
  engine.nodeByObject = new WeakMap();
  engine.root = new THREE.Group();
  engine.buildNode = () => {};
  engine.updateNode = () => {};
  engine.onAttachNode = null;
  engine.syncFromStore();

  assert.equal(engine.objectMap.get(child.id).parent, engine.objectMap.get(parent.id));
  assert.equal(engine.objectMap.get(parent.id).parent, engine.root);
});
