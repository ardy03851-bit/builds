/**
 * Scene operations: adding assets, duplicating, parenting, deleting, and
 * binding live three.js material instances to store records.
 *
 * All mutations go through the store so undo/redo and autosave are automatic.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createObjectNode } from '../core/schema.js';
import { uid, deepClone, slug } from '../core/util.js';
import { basename, stem } from '../core/paths.js';

export class SceneManager {
  constructor(app) {
    this.app = app;
    this.loadedObjects = new Map(); // assetId → THREE.Object3D template
    this.nodeObjects = new Map(); // nodeId → THREE.Object3D instance
    this.materialOf = new Map(); // materialId → Set<nodeId>
  }

  get store() {
    return this.app.store;
  }

  get engine() {
    return this.app.engine;
  }

  /* -------------------------------------------------------------- */

  /** Places a freshly loaded object in the scene and registers it. */
  addAssetToScene({ asset, object, animations = [], materialIds = [], frame = false, position = null }) {
    const name = uniqueName(this.store.get('objects', []), stem(asset.path || asset.name));
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // Normalise: sit on the floor, centred, and scale down giant imports so a
    // model authored in millimetres doesn't land out of frame.
    object.position.set(-center.x, -box.min.y, -center.z);
    let scale = 1;
    const biggest = Math.max(size.x, size.y, size.z);
    if (Number.isFinite(biggest) && biggest > 0) {
      if (biggest > 40) scale = 2 / biggest;
      else if (biggest < 0.05) scale = 1 / Math.max(biggest, 1e-6);
    }

    const node = createObjectNode({
      id: uid('obj'),
      name,
      kind: 'model',
      assetId: asset.id,
      material: materialIds[0] || null,
      position: position || [0, 0, 0],
      scale: [scale, scale, scale],
      animations: animations.map((clip) => ({ name: clip.name, duration: clip.duration })),
      meta: {
        materialIds,
        bounds: { size: size.toArray(), center: center.toArray() },
        upAxis: 'y',
      },
    });

    this.loadedObjects.set(asset.id, object);
    this.nodeObjects.set(node.id, object);

    this.store.batch(() => {
      this.store.push('objects', node);
      this.store.set('selection', [node.id]);
    });

    // animation clips
    if (animations.length) {
      this.app.animation.register(node.id, object, animations);
      const tracks = this.app.animation.deriveTracks();
      this.store.set('timeline.tracks', tracks);
      this.store.set('timeline.duration', Math.max(...tracks.map((t) => t.duration), 1));
    }

    this.engine.syncFromStore();
    this.engine.syncSelection();
    if (frame) this.engine.frameSelection(1.7);
    this.app.history.commit(`Add ${name}`);
    this.app.emit('scene:changed');
    return node;
  }

  /** Re-attaches a stored model (project load). */
  attachLoadedObject(nodeId, object) {
    this.nodeObjects.set(nodeId, object);
  }

  /* -------------------------------------------------------------- */

  addPrimitive(kind) {
    const geo = createPrimitiveGeometry(kind);
    const material = new THREE.MeshStandardMaterial({ color: 0xc9d4e6, roughness: 0.45, metalness: 0.15 });
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = kind;

    const materialRecord = {
      id: uid('mat'),
      name: `${capitalise(kind)} Material`,
      baseColor: '#c9d4e6',
      metalness: 0.15,
      roughness: 0.45,
      textures: {},
    };

    const node = createObjectNode({
      name: capitalise(kind),
      kind: 'model',
      position: [0, 0.5, 0],
      material: materialRecord.id,
      meta: { materialIds: [materialRecord.id], primitive: kind },
    });

    this.store.batch(() => {
      this.store.set(`materials.${materialRecord.id}`, materialRecord);
      this.store.push('objects', node);
      this.store.set('selection', [node.id]);
    });

    this.app.materials.build(materialRecord);
    const libMat = this.app.materials.cache.get(materialRecord.id)?.material || material;
    mesh.material = libMat;

    const group = new THREE.Group();
    group.add(mesh);
    this.loadedObjects.set(`primitive:${node.id}`, group);
    this.nodeObjects.set(node.id, group);

    this.engine.syncFromStore();
    this.engine.syncSelection();
    this.engine.frameSelection();
    this.app.history.commit(`Add ${kind}`);
    this.app.emit('scene:changed');
    return node;
  }

  addLight(type = 'point') {
    const light = {
      type,
      color: type === 'ambient' ? '#9bb7ff' : '#fff4e0',
      intensity: type === 'point' ? 18 : type === 'spot' ? 30 : 2.4,
      castShadow: type !== 'ambient',
      distance: 0,
      decay: 2,
      angle: 0.6,
      penumbra: 0.45,
    };
    const node = createObjectNode({
      name: `${capitalise(type)} Light`,
      kind: 'light',
      position: [2, 3.5, 2],
      light,
    });
    this.store.batch(() => {
      this.store.push('objects', node);
      this.store.set('selection', [node.id]);
    });
    this.engine.syncFromStore();
    this.engine.syncSelection();
    this.app.history.commit('Add light');
    this.app.emit('scene:changed');
    return node;
  }

  addBillboard({ text = 'Label', style = 'bubble', targetNodeId = null } = {}) {
    let position = [0, 2, 0];
    if (targetNodeId) {
      const target = this.store.get('objects', []).find((o) => o.id === targetNodeId);
      if (target) position = [...target.position];
    }
    const node = createObjectNode({
      name: text,
      kind: 'billboard',
      position,
      billboard: {
        text,
        title: '',
        subtitle: '',
        style,
        offsetY: 1.2,
        scale: 1,
        opacity: 1,
        clickable: true,
        anchorTo: targetNodeId,
      },
    });
    this.store.batch(() => {
      this.store.push('objects', node);
      this.store.set('selection', [node.id]);
    });
    this.engine.syncFromStore();
    this.app.billboards.sync();
    this.app.history.commit('Add billboard');
    this.app.emit('scene:changed');
    return node;
  }

  /* -------------------------------------------------------------- */

  select(ids, { additive = false } = {}) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : ids ? [ids] : [];
    const current = this.store.get('selection', []);
    let next;
    if (additive) {
      next = [...current];
      for (const id of list) {
        const index = next.indexOf(id);
        if (index >= 0) next.splice(index, 1);
        else next.push(id);
      }
    } else {
      next = list;
    }
    this.store.set('selection', next);
  }

  rename(nodeId, name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    this.store.update('objects', (objects) =>
      objects.map((o) => (o.id === nodeId ? { ...o, name: clean } : o)),
    );
    this.app.history.commit('Rename');
    this.app.emit('scene:changed');
  }

  duplicate(nodeId = null) {
    const ids = nodeId ? [nodeId] : this.store.get('selection', []);
    if (!ids.length) return;
    const created = [];
    this.store.batch(() => {
      for (const id of ids) {
        const node = this.store.get('objects', []).find((o) => o.id === id);
        if (!node) continue;
        const copy = createObjectNode({
          ...deepClone(node),
          id: uid('obj'),
          name: uniqueName(this.store.get('objects', []), `${node.name} copy`),
          position: [node.position[0] + 0.6, node.position[1], node.position[2] + 0.6],
        });
        this.store.push('objects', copy);
        created.push(copy.id);

        // duplicate the underlying three object as a template clone
        const src = this.nodeObjects.get(id);
        if (src) {
          const clone = src.clone(true);
          this.nodeObjects.set(copy.id, clone);
        }
        const entry = this.app.animation.mixers.get(id);
        if (entry) this.app.animation.register(copy.id, this.nodeObjects.get(copy.id), entry.clips);
      }
      this.store.set('selection', created);
    });
    this.engine.syncFromStore();
    this.app.history.commit('Duplicate');
    this.app.emit('scene:changed');
  }

  delete(ids = null) {
    const list = ids ? [].concat(ids) : this.store.get('selection', []);
    if (!list.length) return;
    const set = new Set(list);
    // include descendants
    const objects = this.store.get('objects', []);
    let changed = true;
    while (changed) {
      changed = false;
      for (const obj of objects) {
        if (obj.parentId && set.has(obj.parentId) && !set.has(obj.id)) {
          set.add(obj.id);
          changed = true;
        }
      }
    }

    this.store.batch(() => {
      this.store.set(
        'objects',
        objects.filter((o) => !set.has(o.id)),
      );
      this.store.set('selection', []);
    });

    for (const id of set) {
      this.app.animation.unregister(id);
      this.nodeObjects.delete(id);
      this.app.billboards.sync();
    }
    this.engine.syncFromStore();
    this.app.history.commit('Delete');
    this.app.emit('scene:changed');
  }

  setParent(childId, parentId) {
    if (childId === parentId) return;
    // prevent cycles
    let cursor = parentId;
    const objects = this.store.get('objects', []);
    while (cursor) {
      if (cursor === childId) return;
      cursor = objects.find((o) => o.id === cursor)?.parentId || null;
    }
    this.store.update('objects', (list) =>
      list.map((o) => (o.id === childId ? { ...o, parentId: parentId || null } : o)),
    );
    this.engine.syncFromStore();
    this.app.history.commit('Reparent');
    this.app.emit('scene:changed');
  }

  toggleVisibility(nodeId) {
    this.store.update('objects', (list) =>
      list.map((o) => (o.id === nodeId ? { ...o, visible: o.visible === false } : o)),
    );
    this.engine.syncFromStore();
    this.app.emit('scene:changed');
  }

  toggleLock(nodeId) {
    this.store.update('objects', (list) =>
      list.map((o) => (o.id === nodeId ? { ...o, locked: !o.locked } : o)),
    );
    this.engine.syncFromStore();
    this.app.emit('scene:changed');
  }

  setTransform(nodeId, patch) {
    this.store.update('objects', (list) =>
      list.map((o) => (o.id === nodeId ? { ...o, ...patch } : o)),
    );
    this.engine.syncTransforms();
    this.app.emit('scene:changed');
  }

  /** Live material instance for a record id, applied everywhere it's used. */
  refreshMaterial(materialId, materialInstance) {
    const used = new Set();
    for (const object of this.nodeObjects.values()) {
      object.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const list = Array.isArray(child.material) ? child.material : [child.material];
        if (list.some((m) => m?.userData?.materialRecordId === materialId)) used.add(child);
      });
    }
    for (const mesh of used) {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => (m.userData?.materialRecordId === materialId ? materialInstance : m));
      } else {
        mesh.material = materialInstance;
      }
    }
    this.engine.updateSelectionOutline();
  }

  /* -------------------------------------------------------------- */

  /** Story-friendly summary used by the status bar and export dialog. */
  summary() {
    const objects = this.store.get('objects', []);
    let triangles = 0;
    let meshes = 0;
    for (const object of this.nodeObjects.values()) {
      object.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        meshes += 1;
        const geo = child.geometry;
        const index = geo.getIndex();
        const pos = geo.getAttribute('position');
        triangles += index ? index.count / 3 : (pos ? pos.count / 3 : 0);
      });
    }
    return {
      objects: objects.length,
      meshes,
      triangles: Math.round(triangles),
      lights: objects.filter((o) => o.kind === 'light').length,
      billboards: objects.filter((o) => o.kind === 'billboard').length,
      vfx: objects.filter((o) => o.kind === 'vfx').length,
      animations: objects.reduce((sum, o) => sum + (o.animations?.length || 0), 0),
    };
  }

  /** Builds a GLB of the whole scene (without helpers/gizmos). */
  async exportGLB({ binary = true } = {}) {
    const root = new THREE.Group();
    root.name = slug(this.store.get('meta.name', 'scene'), 'scene');
    for (const node of this.store.get('objects', [])) {
      if (node.parentId) continue;
      const object = this.nodeObjects.get(node.id);
      if (!object) continue;
      const clone = object.clone(true);
      clone.position.fromArray(node.position);
      clone.rotation.set(...node.rotation);
      clone.scale.fromArray(node.scale);
      clone.visible = node.visible !== false;
      root.add(clone);
    }
    if (!root.children.length) throw new Error('There is nothing in the scene to export yet.');

    const exporter = new GLTFExporter();
    return new Promise((resolve, reject) => {
      exporter.parse(
        root,
        (result) => {
          if (binary) resolve(new Blob([result], { type: 'model/gltf-binary' }));
          else resolve(new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' }));
        },
        (err) => reject(err),
        { binary, animations: [], onlyVisible: false, embedImages: true },
      );
    });
  }

  /** Clears the scene graph (used by New / load). */
  reset() {
    this.app.animation.clear();
    for (const object of this.nodeObjects.values()) object.parent?.remove(object);
    this.nodeObjects.clear();
    this.loadedObjects.clear();
    for (const group of this.engine.objectMap.values()) group.parent?.remove(group);
    this.engine.objectMap.clear();
    this.engine.root.clear();
    this.engine.root.updateMatrixWorld(true);
    this.engine.transform.detach();
    this.app.billboards.sync();
  }
}

function createPrimitiveGeometry(kind) {
  switch (kind) {
    case 'sphere':
      return new THREE.SphereGeometry(0.5, 48, 32);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.42, 0.42, 1, 48, 1);
    case 'cone':
      return new THREE.ConeGeometry(0.5, 1, 48, 1);
    case 'torus':
      return new THREE.TorusGeometry(0.42, 0.16, 24, 64);
    case 'plane':
      return new THREE.PlaneGeometry(1.4, 1.4, 1, 1);
    case 'capsule':
      return new THREE.CapsuleGeometry(0.32, 0.6, 12, 24);
    case 'cube':
    default:
      return new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  }
}

export function uniqueName(objects, base) {
  const existing = new Set(objects.map((o) => o.name));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

const capitalise = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

export { basename };
