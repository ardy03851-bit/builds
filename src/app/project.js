/**
 * Project persistence: `.atlascene` files (JSON with an asset manifest),
 * autosave to IndexedDB, and reopening without re-uploading blobs.
 */
import { SCHEMA_VERSION, createInitialState } from '../core/schema.js';
import { blobs } from '../core/blobstore.js';
import { deepClone, slug } from '../core/util.js';
import { triggerDownload, stamp } from './shots.js';

export class ProjectIO {
  constructor(app) {
    this.app = app;
    this.autosaveTimer = 0;
    this.bindings = new Map(); // materialId → record (for after-load rebinding)
  }

  get store() {
    return this.app.store;
  }

  /** Serialisable snapshot of the document (blobs are referenced by hash). */
  serialise() {
    const state = this.store.snapshot();
    const assets = state.assets.map((asset) => {
      const copy = { ...asset };
      delete copy.thumb;
      return copy;
    });
    return {
      schema: SCHEMA_VERSION,
      app: 'Atlas Scene Studio',
      savedAt: new Date().toISOString(),
      meta: state.meta,
      assets,
      objects: state.objects,
      materials: state.materials,
      camera: state.camera,
      render: state.render,
      environment: state.environment,
      snap: state.snap,
      shot: state.shot,
      lighting: state.lighting,
      timeline: { ...state.timeline, playing: false },
      ui: { ...state.ui },
    };
  }

  toBlob() {
    const json = JSON.stringify(this.serialise(), null, 1);
    return new Blob([json], { type: 'application/json' });
  }

  async save() {
    const blob = this.toBlob();
    const name = `${slug(this.store.get('meta.name', 'scene'), 'scene')}-${stamp()}.atlascene`;
    triggerDownload(blob, name);
    this.app.log('success', `Project saved as ${name}`);
    this.app.toast.success('Project saved', name);
    return name;
  }

  /** Writes to IndexedDB so a refresh keeps your work. */
  async autosave() {
    try {
      const payload = this.serialise();
      await blobs.setMeta({ autosave: payload, autosaveAt: Date.now() });
      this.app.emit('project:autosaved');
    } catch (err) {
      console.warn('[project] autosave failed', err);
    }
  }

  scheduleAutosave(delay = 1200) {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.autosave(), delay);
  }

  async loadAutosave() {
    const meta = await blobs.meta();
    if (!meta?.autosave) return null;
    return meta.autosave;
  }

  async clearAutosave() {
    await blobs.setMeta({ autosave: null, autosaveAt: null });
  }

  async openProjectFile(file) {
    try {
      const text = await file.text();
      const doc = JSON.parse(text);
      await this.applyDocument(doc, { source: file.name });
      this.app.toast.success('Project opened', file.name);
    } catch (err) {
      console.error(err);
      this.app.toast.error('Could not open project', err.message);
      this.app.log('error', `Project load failed: ${err.message}`);
    }
  }

  /** Replaces the whole document, rebinding blobs + rebuilding materials. */
  async applyDocument(doc, { source = 'project', silent = false } = {}) {
    if (!doc || typeof doc !== 'object') throw new Error('This file is not an Atlas project.');
    if (!Array.isArray(doc.objects) || !Array.isArray(doc.assets)) {
      throw new Error('Project file is missing its scene graph.');
    }
    if (doc.schema && doc.schema > SCHEMA_VERSION) {
      throw new Error('This project was made with a newer version of Atlas.');
    }

    const base = createInitialState();
    const next = {
      ...base,
      ...doc,
      assets: doc.assets || [],
      objects: doc.objects || [],
      materials: doc.materials || {},
      selection: [],
      timeline: { ...base.timeline, ...(doc.timeline || {}), playing: false },
      ui: { ...base.ui, ...(doc.ui || {}) },
      stats: base.stats,
    };

    this.app.scene.reset();
    this.app.materials.dispose();
    this.store.replace(next);
    this.app.history.reset();

    // Rebuild all objects
    for (const node of [...next.objects]) {
      if (node.kind === 'model' && node.assetId) {
        await this.app.rehydrateModel(node);
      }
    }
    this.app.engine.syncFromStore();
    this.app.vfx.sync();
    this.app.billboards.sync();
    this.app.engine.frameAll();
    this.app.applyUiState();
    this.app.emit('project:loaded');

    if (!silent) this.app.log('info', `Loaded project from ${source}`);
    return true;
  }

  /** Snapshot download with the current thumbnails included as JSON. */
  async exportManifest() {
    const blob = new Blob([JSON.stringify(this.serialise(), null, 2)], { type: 'application/json' });
    triggerDownload(blob, `${slug(this.store.get('meta.name', 'scene'))}-manifest.json`);
  }

  /** Free space freed by removing unused blobs (asset GC). */
  async garbageCollect() {
    const used = new Set(
      this.store
        .get('assets', [])
        .map((a) => a.blobId)
        .filter(Boolean),
    );
    for (const mat of Object.values(this.store.get('materials', {}))) {
      for (const tex of Object.values(mat.textures || {})) {
        if (tex?.blobId) used.add(tex.blobId);
      }
    }
    const removed = await blobs.gc(used);
    this.app.log('info', `Cleaned up ${removed.length} unused asset blobs`);
    return removed;
  }

  /** Estimated storage used by this project. */
  usage() {
    let total = 0;
    for (const asset of this.store.get('assets', [])) total += asset.size || 0;
    return total;
  }

  bindMaterial(materialId, record) {
    this.bindings.set(materialId, record);
  }

  clonedState() {
    return deepClone(this.serialise());
  }
}

/** Save helpers shared with keyboard shortcuts. */
export function projectFileName(name) {
  return `${slug(name || 'scene')}.atlascene`;
}
