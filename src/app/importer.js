/**
 * Import orchestration: files / folders / ZIPs → assets in the store.
 *
 * The flow for a ZIP is:
 *   1. read the central directory (cheap, flat memory)
 *   2. stream out only the models + their textures, one at a time
 *   3. load each model, then run the smart matcher against its materials
 *   4. present a review sheet with per-texture confidence
 *   5. apply, with live material thumbnails
 */
import { blobs, hashBlob } from '../core/blobstore.js';
import {
  basename, extensionOf, fileKind, stem, isJunkPath, normalizePath,
} from '../core/paths.js';
import { planArchive } from '../core/zipPlan.js';
import { ZipReader } from '../assets/zipReader.js';
import { loadAsset, Session } from '../assets/assetLoader.js';
import { matchTextures, detectMapType } from '../core/matcher.js';
import { uid, formatBytes, humanDuration } from '../core/util.js';
import { SLOT_BY_ID } from '../core/slots.js';

export class Importer {
  constructor(app) {
    this.app = app;
    this.cancelToken = { aborted: false };
    this.queue = [];
    this.running = false;
  }

  get store() {
    return this.app.store;
  }

  /* -------------------------------------------------------------- */

  /** Entry point for drops / file picker. */
  async ingestFiles(fileList, { fromFolder = false } = {}) {
    const files = [...fileList].filter(Boolean);
    if (!files.length) return;

    // Webkit directory drops give relative paths — keep them.
    const entries = files.map((file) => ({
      file,
      path: normalizePath(file.webkitRelativePath || file.relativePath || file.name),
    }));

    const zips = entries.filter((e) => extensionOf(e.path) === 'zip' || extensionOf(e.path) === 'atlaszip');
    const projects = entries.filter((e) => extensionOf(e.path) === 'atlascene');
    const rest = entries.filter((e) => !zips.includes(e) && !projects.includes(e));

    if (projects.length) {
      for (const project of projects) await this.app.io.openProjectFile(project.file);
    }
    if (zips.length) {
      for (const zip of zips) await this.ingestZip(zip.file, zip.path);
    }
    if (rest.length) {
      await this.ingestLooseFiles(rest, { fromFolder });
    }
  }

  /* -------------------------------------------------------------- */
  /* Loose files                                                     */
  /* -------------------------------------------------------------- */

  async ingestLooseFiles(entries, { fromFolder = false } = {}) {
    const models = [];
    const textures = [];
    const hdris = [];
    const audio = [];
    const mtls = new Map();

    for (const entry of entries) {
      const kind = fileKind(entry.path);
      if (isJunkPath(entry.path)) continue;
      if (kind === 'model') models.push(entry);
      else if (kind === 'texture') textures.push(entry);
      else if (kind === 'hdri') hdris.push(entry);
      else if (kind === 'audio') audio.push(entry);
      else if (kind === 'material') mtls.set(entry.path, entry);
      else if (extensionOf(entry.path) === 'bin') {
        // glTF sidecar — keep for the session below
        models.push({ ...entry, isSidecar: true });
      }
    }

    if (!models.length && !textures.length && !hdris.length && !audio.length) {
      this.app.toast.warn('Nothing importable', 'Try GLB, FBX, OBJ, STL, ply, images, HDR or ZIP.');
      return;
    }

    const modelEntries = models.filter((m) => !m.isSidecar);

    // Texture blobs first so auto-binding can reference them by id.
    const textureRecords = [];
    if (textures.length) {
      const toast = this.app.toast.progress(`Indexing ${textures.length} texture${textures.length > 1 ? 's' : ''}…`);
      let done = 0;
      for (const tex of textures) {
        try {
          const blobId = await hashBlob(tex.file);
          await blobs.put(blobId, tex.file);
          textureRecords.push({
            id: uid('tex'),
            name: stem(tex.path),
            path: tex.path,
            blobId,
            size: tex.file.size,
            width: null,
            height: null,
            mapType: detectMapType(tex.path).slot,
            thumb: null,
          });
        } catch (err) {
          this.app.log('warn', `Texture ${tex.path} failed: ${err.message}`);
        }
        done += 1;
        toast.progress((done / textures.length) * 100, `${done}/${textures.length} · ${basename(tex.path)}`);
      }
      toast.dismiss();
      this.store.update('assets', (assets) => [...assets, ...textureRecords.map((t) => ({ ...t, kind: 'texture' }))]);
      this.app.emit('assets:changed');
    }

    for (const hdri of hdris) {
      const blobId = await hashBlob(hdri.file);
      await blobs.put(blobId, hdri.file);
      this.store.push('assets', {
        id: uid('hdri'),
        kind: 'hdri',
        name: stem(hdri.path),
        path: hdri.path,
        blobId,
        size: hdri.file.size,
      });
    }

    for (const track of audio) {
      const blobId = await hashBlob(track.file);
      await blobs.put(blobId, track.file);
      this.store.push('assets', {
        id: uid('audio'),
        kind: 'audio',
        name: stem(track.path),
        path: track.path,
        blobId,
        size: track.file.size,
        mime: track.file.type,
      });
    }

    if (!modelEntries.length) {
      if (textureRecords.length) {
        this.app.toast.success(
          `${textureRecords.length} texture${textureRecords.length > 1 ? 's' : ''} added`,
          'Select a material, then drop a texture on its slot.',
        );
        this.app.emit('assets:changed');
      }
      if (hdris.length) this.app.emit('assets:changed');
      return;
    }

    // Build one session so loose glTF + .bin + images can resolve each other.
    const session = new Session();
    for (const entry of entries) session.add(entry.path, entry.file);
    for (const entry of modelEntries) {
      await this.importModel({
        path: entry.path,
        file: entry.file,
        session,
        textures: textureRecords,
        autoMatch: true,
        source: fromFolder ? 'folder' : 'files',
      });
    }
    session.dispose();
    this.app.emit('assets:changed');
  }

  /* -------------------------------------------------------------- */
  /* Models                                                          */
  /* -------------------------------------------------------------- */

  async importModel({ path, file, session, textures = [], autoMatch = true, source = 'files', extraTextures = [] }) {
    const toast = this.app.toast.progress(`Loading ${basename(path)}…`, formatBytes(file.size));
    const started = performance.now();
    try {
      const asset = await loadAsset({
        path,
        blob: file,
        format: extensionOf(path),
        renderer: this.app.engine.renderer,
        signal: this.cancelToken,
        session,
        onProgress: ({ loaded, total }) => {
          if (total) toast.progress((loaded / total) * 100, `${basename(path)} · ${formatBytes(loaded)} / ${formatBytes(total)}`);
        },
      });

      const blobId = await hashBlob(file);
      await blobs.put(blobId, file);

      const materialRecords = asset.materials.map((imported, index) => {
        const rec = {
          id: `${uid('mat')}`,
          name: imported.name,
          meshNames: imported.meshNames,
          baseColor: imported.material?.color ? `#${imported.material.color.getHexString()}` : '#c9d4e6',
          metalness: imported.material?.metalness ?? 0.08,
          roughness: imported.material?.roughness ?? 0.55,
          emissive: imported.material?.emissive ? `#${imported.material.emissive.getHexString()}` : '#000000',
          emissiveIntensity: imported.material?.emissiveIntensity ?? 0,
          opacity: imported.material?.opacity ?? 1,
          transparent: Boolean(imported.material?.transparent),
          doubleSided: Boolean(imported.material?.side === 2),
          textures: {},
          importedIndex: index,
          importedName: imported.name || null,
        };
        return rec;
      });

      const assetRecord = {
        id: uid('asset'),
        kind: 'model',
        name: stem(path),
        path,
        blobId,
        size: file.size,
        format: asset.format,
        stats: asset.stats,
        animations: asset.animations.map((clip) => ({ name: clip.name, duration: clip.duration })),
        materials: materialRecords.map((m) => ({ id: m.id, name: m.name })),
        thumb: null,
        addedAt: Date.now(),
        source,
        loadMs: Math.round(performance.now() - started),
      };

      this.store.batch(() => {
        this.store.push('assets', assetRecord);
        const materials = { ...this.store.get('materials', {}) };
        for (const rec of materialRecords) materials[rec.id] = rec;
        this.store.set('materials', materials);
      });

      // Material records → live three materials
      asset.materials.forEach((imported, index) => {
        this.app.materials.build(materialRecords[index]);
      });

      // Swap the loaded object's materials to library materials, then add to scene
      asset.materials.forEach((imported, index) => {
        const libMat = this.app.materials.cache.get(materialRecords[index].id)?.material;
        if (!libMat) return;
        asset.object.traverse((child) => {
          if (child.userData.materialId === imported.id) child.material = libMat;
        });
      });

      const node = this.app.scene.addAssetToScene({
        asset: assetRecord,
        object: asset.object,
        animations: asset.animations,
        materialIds: materialRecords.map((m) => m.id),
        frame: true,
      });

      toast.update({ title: `${basename(path)} imported`, message: `${asset.stats.meshes} meshes · ${formatBytes(file.size)} · ${humanDuration((performance.now() - started) / 1000)}` });
      setTimeout(() => toast.dismiss(), 2600);

      this.app.log('success', `Imported ${basename(path)} (${asset.stats.triangles.toLocaleString()} tris, ${asset.stats.materials} materials)`);

      // Smart texture matching
      if (autoMatch && (textures.length || extraTextures.length)) {
        await this.runSmartMatch({
          nodeId: node.id,
          assetRecord,
          materials: materialRecords.map((m) => ({ id: m.id, name: m.name, meshNames: m.meshNames })),
          textures: [...textures, ...extraTextures],
          preview: true,
        });
      }

      return { assetRecord, node, materialRecords };
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast.dismiss();
        return null;
      }
      console.error(err);
      toast.update({ title: `Could not load ${basename(path)}`, message: err.message });
      setTimeout(() => toast.dismiss(), 6000);
      this.app.log('error', `Import failed for ${basename(path)}: ${err.message}`);
      return null;
    }
  }

  /* -------------------------------------------------------------- */
  /* ZIP                                                             */
  /* -------------------------------------------------------------- */

  async ingestZip(file, path) {
    const toast = this.app.toast.progress(`Reading ${basename(path)}…`, formatBytes(file.size));
    let reader;
    try {
      reader = await new ZipReader(file).open();
    } catch (err) {
      toast.update({ title: 'That ZIP could not be read', message: err.message });
      setTimeout(() => toast.dismiss(), 6000);
      this.app.log('error', `ZIP failed: ${err.message}`);
      return;
    }

    const listed = reader.list().map((e) => ({ path: e.path, size: e.uncompressedSize }));
    const plan = planArchive(listed);

    toast.update({
      title: `${basename(path)} opened`,
      message: `${plan.stats.models} models · ${plan.stats.textures} textures · ${formatBytes(plan.stats.estimatedBytes)}`,
    });

    if (!plan.stats.models && !plan.stats.textures) {
      toast.update({ title: 'Nothing usable in this archive', message: 'No 3D models or textures were found.' });
      setTimeout(() => toast.dismiss(), 5000);
      return;
    }

    const choice = await this.app.ui.zipReview(plan, reader, file);
    if (!choice) {
      toast.dismiss();
      return;
    }

    try {
      if (choice.importTextures) {
        await this.extractTextures(reader, plan, choice, toast);
      }
      if (choice.importModels) {
        await this.extractModels(reader, plan, choice, toast);
      }
    } finally {
      toast.dismiss();
      this.app.emit('assets:changed');
      this.app.history.commit('Import archive');
    }
  }

  async extractTextures(reader, plan, choice, toast) {
    const paths = plan.textures.map((t) => t.path).filter((p) => choice.texturePaths?.includes(p) ?? true);
    if (!paths.length) return [];
    const records = [];
    let done = 0;
    for (const texturePath of paths) {
      try {
        const bytes = await reader.read(texturePath);
        const blob = new Blob([bytes], { type: 'image/png' });
        const blobId = await hashBlob(bytes);
        await blobs.put(blobId, blob);
        records.push({
          id: uid('tex'),
          kind: 'texture',
          name: stem(texturePath),
          path: texturePath,
          blobId,
          size: bytes.byteLength,
          mapType: detectMapType(texturePath).slot,
          thumb: null,
        });
      } catch (err) {
        this.app.log('warn', `Skipped ${basename(texturePath)}: ${err.message}`);
      }
      done += 1;
      if (done % 3 === 0 || done === paths.length) {
        toast.progress((done / paths.length) * 100, `Textures ${done}/${paths.length}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    const recordsWithKind = records.map((r) => ({ ...r, kind: 'texture' }));
    this.store.update('assets', (assets) => [...assets, ...recordsWithKind]);
    // Expose to the model pass through the app-level cache
    this.app.importer.lastTextureRecords = recordsWithKind;
    return recordsWithKind;
  }

  async extractModels(reader, plan, choice, toast) {
    const wanted = plan.models.filter((m) => choice.modelPaths?.includes(m.path) ?? true);
    if (!wanted.length) return;

    // Files required by each model (its sidecars) are extracted together.
    const textures = this.app.importer.lastTextureRecords || [];
    const modelsByTexture = new Map();
    for (const texture of plan.textures) {
      modelsByTexture.set(texture.path, texture.owner);
    }

    // Pre-create a texture lookup keyed by path for matcher input.
    const textureByPath = new Map(textures.map((t) => [t.path, t]));

    let done = 0;
    for (const model of wanted) {
      toast.progress((done / wanted.length) * 100, `Importing ${basename(model.path)}… (${done + 1}/${wanted.length})`);
      try {
        const session = new Session();
        const bytes = await reader.read(model.path);
        const blob = new Blob([bytes]);
        const fileName = basename(model.path);
        session.add(model.path, blob);

        // Sidecars referenced by loose glTF
        const sidecars = [...model.sidecars].filter((p) => p !== model.path);
        for (const sidecarPath of sidecars) {
          const data = await reader.read(sidecarPath);
          session.add(sidecarPath, new Blob([data]));
        }

        const relatedTextures = plan.textures
          .filter((t) => t.owner === model.path || model.texturePaths?.includes(t.path))
          .map((t) => textureByPath.get(t.path))
          .filter(Boolean);

        await this.importModel({
          path: model.path,
          file: blob,
          session,
          textures: relatedTextures,
          autoMatch: choice.smartMatch !== false,
          source: 'zip',
        });
        session.dispose();
        // key the session path base for relative glTF resolution
        void fileName;
      } catch (err) {
        this.app.log('error', `Failed to import ${model.path}: ${err.message}`);
      }
      done += 1;
    }
  }

  /* -------------------------------------------------------------- */
  /* Smart match                                                     */
  /* -------------------------------------------------------------- */

  /** Scores textures against materials; optionally shows a review sheet. */
  async runSmartMatch({ nodeId, assetRecord, materials, textures, preview = false }) {
    if (!textures.length) return null;
    const result = matchTextures({
      models: [{ id: assetRecord.id, path: assetRecord.path, materials }],
      textures: textures.map((t) => ({ id: t.id, path: t.path || t.name })),
      options: { minConfidence: 34 },
    });

    if (preview) {
      const accepted = await this.app.ui.matchReview({
        assetRecord,
        nodeId,
        result,
        textures,
        materials,
        modelPath: assetRecord.path,
      });
      if (accepted === null) return result;
      this.applyAssignments(accepted);
      return accepted;
    }

    this.applyAssignments(result.assignments);
    return result;
  }

  /** Applies matcher output to the store (one batch, one history entry). */
  applyAssignments(assignments) {
    if (!assignments?.length) return 0;
    const materials = { ...this.store.get('materials', {}) };
    const assets = this.store.get('assets', []);
    const textureById = new Map(assets.filter((a) => a.kind === 'texture').map((a) => [a.id, a]));
    let applied = 0;

    for (const assignment of assignments) {
      const record = materials[assignment.materialId];
      const texture = textureById.get(assignment.textureId);
      if (!record || !texture) continue;
      const textures_ = { ...(record.textures || {}) };
      textures_[assignment.slot] = {
        blobId: texture.blobId,
        assetId: texture.id,
        name: texture.name,
        path: texture.path,
        repeat: [1, 1],
        offset: [0, 0],
        rotation: 0,
      };
      if (assignment.slot === 'normal' && record.roughness === undefined) record.roughness = 0.55;
      materials[assignment.materialId] = { ...record, textures: textures_ };
      applied += 1;
    }

    this.store.batch(() => this.store.set('materials', materials));
    // rebuild material instances
    for (const id of new Set(assignments.map((a) => a.materialId))) {
      const record = this.store.get(`materials.${id}`);
      if (record) {
        const mat = this.app.materials.build(record);
        this.app.scene.refreshMaterial(id, mat);
      }
    }
    if (applied) {
      this.app.log('success', `Applied ${applied} texture${applied > 1 ? 's' : ''} automatically`);
      this.app.emit('materials:changed');
      this.app.history.commit('Auto-apply textures');
    }
    return applied;
  }

  /* -------------------------------------------------------------- */
  /* Textures for existing slots (manual + drop)                     */
  /* -------------------------------------------------------------- */

  async assignTextureFile(materialId, slot, file) {
    const blobId = await hashBlob(file);
    await blobs.put(blobId, file);
    const record = { ...this.store.get(`materials.${materialId}`) };
    if (!record) return null;
    record.textures = { ...(record.textures || {}) };
    record.textures[slot] = {
      blobId,
      assetId: null,
      name: stem(file.name),
      path: file.name,
      repeat: [1, 1],
      offset: [0, 0],
      rotation: 0,
    };
    this.store.batch(() => this.store.set(`materials.${materialId}`, record));
    const mat = this.app.materials.build(record);
    this.app.scene.refreshMaterial(materialId, mat);
    this.app.history.commit('Assign texture');
    this.app.log('info', `${SLOT_BY_ID.get(slot)?.label || slot} ← ${file.name}`);
    return record;
  }
}
