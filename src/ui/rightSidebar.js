/**
 * Right sidebar: Inspector · Render · Lighting · VFX.
 *
 * The inspector is the heart of the "detailed controls" ask: transform,
 * geometry info, material PBR stack with drag-and-drop texture slots, shader
 * tweaks, and per-object extras (lights, billboards, VFX uniforms).
 */
import {
  $, h, icon, Panel, section, prop, vec3, slider, colorField, toggleRow,
  selectField, segmented, textInput, emptyHint,
} from './dom.js';
import { SLOTS } from '../core/slots.js';
import { LIGHT_PRESETS, GRID_ENV_THEMES } from '../core/schema.js';
import { SHADER_PRESETS } from '../core/shaderlib.js';
import { formatBytes, formatNumber } from '../core/util.js';
import { basename } from '../core/paths.js';

export class RightSidebar {
  constructor(app) {
    this.app = app;
    this.root = $('#right-panel');
    this.panel = new Panel(this.root, () => this.render());
    this.openSections = new Map();
  }

  mount() {
    this.panel.mount();
    const invalidate = () => this.panel.invalidate();
    this.app.store.subscribe(invalidate, 'selection');
    this.app.store.subscribe(invalidate, 'objects');
    this.app.store.subscribe(invalidate, 'materials');
    this.app.store.subscribe(invalidate, 'ui.activeMaterial');
    this.app.store.subscribe(invalidate, 'ui.rightTab');
    this.app.store.subscribe(invalidate, 'render');
    this.app.store.subscribe(invalidate, 'environment');
    this.app.store.subscribe(invalidate, 'lighting');
  }

  render() {
    const tab = this.app.store.get('ui.rightTab', 'inspector');
    switch (tab) {
      case 'render':
        return this.renderRenderTab();
      case 'lighting':
        return this.renderLightingTab();
      case 'vfx':
        return this.renderVfxTab();
      default:
        return this.renderInspector();
    }
  }

  /* ============================================================ inspector */

  renderInspector() {
    const selection = this.app.store.get('selection', []);
    const objects = this.app.store.get('objects', []);
    if (selection.length > 1) {
      return h(
        'div.panel',
        {},
        h('div.panel-title', {}, `${selection.length} objects selected`),
        h('p.u-muted', { style: { fontSize: '12px' } }, 'Transform all at once:'),
        h('div.u-col', {},
          h('button.btn', { type: 'button', onClick: () => this.app.alignSelection('x') }, 'Align on X'),
          h('button.btn', { type: 'button', onClick: () => this.app.alignSelection('y') }, 'Align on Y'),
          h('button.btn', { type: 'button', onClick: () => this.app.distributeSelection('x') }, 'Distribute on X'),
          h('button.btn', { type: 'button', onClick: () => this.app.groupSelection() }, 'Group into empty'),
          h('button.btn.btn-danger', { type: 'button', onClick: () => this.app.scene.delete() }, 'Delete all'),
        ),
      );
    }

    const node = objects.find((o) => o.id === selection[0]);
    if (!node) {
      return h(
        'div',
        {},
        h('div.panel', {}, h('div.panel-title', {}, 'Inspector'), emptyHint('Select an object in the viewport or the scene tree.', 'cube')),
        this.renderQuickSettings(),
      );
    }

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h(
        'div.panel-head',
        { style: { position: 'static' } },
        h('div.u-col', { style: { gap: '2px', minWidth: 0 } },
          h('div.panel-title', {}, node.kind === 'model' ? (node.meta?.primitive ? 'Primitive' : 'Model') : node.kind),
          textInput({
            value: node.name,
            onChange: (value) => this.app.scene.rename(node.id, value),
          }),
        ),
      ),
      this.section('Transform', this.transformControls(node), { key: 'insp.transform', open: true }),
      node.kind === 'light' ? this.section('Light', this.lightControls(node), { key: 'insp.light', open: true }) : null,
      node.kind === 'billboard' ? this.section('Billboard', this.billboardControls(node), { key: 'insp.billboard', open: true }) : null,
      node.kind === 'vfx' ? this.section('VFX Uniforms', this.vfxNodeControls(node), { key: 'insp.vfx', open: true }) : null,
      node.assetId ? this.section('Asset', this.assetControls(node), { key: 'insp.asset', open: false }) : null,
      this.materialSection(node),
      this.section('Object', this.objectControls(node), { key: 'insp.object', open: false }),
    );
  }

  section(title, body, opts) {
    return section(title, body, opts);
  }

  transformControls(node) {
    const commit = () => this.app.history.commit('Transform');
    return [
      prop('Position', vec3({
        value: node.position,
        step: 0.05,
        onChange: (v) => this.app.scene.setTransform(node.id, { position: v }),
        onCommit: commit,
      })),
      prop('Rotation', vec3({
        value: node.rotation.map((r) => (r * 180) / Math.PI),
        step: 1,
        unit: '°',
        onChange: (v) => this.app.scene.setTransform(node.id, { rotation: v.map((d) => (d * Math.PI) / 180) }),
        onCommit: commit,
      })),
      prop('Scale', vec3({
        value: node.scale,
        step: 0.02,
        onChange: (v) => this.app.scene.setTransform(node.id, { scale: v }),
        onCommit: commit,
      })),
      h('div.u-row.u-gap-1', {},
        h('button.btn', {
          type: 'button',
          style: { flex: '1 1 0', height: '26px', fontSize: '11px' },
          onClick: () => this.app.scene.setTransform(node.id, {
            position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
          }),
        }, 'Reset'),
        h('button.btn', {
          type: 'button',
          style: { flex: '1 1 0', height: '26px', fontSize: '11px' },
          onClick: () => this.app.scene.setTransform(node.id, { position: [node.position[0], 0, node.position[2]] }),
        }, 'Drop to floor'),
        h('button.btn', {
          type: 'button',
          style: { flex: '1 1 0', height: '26px', fontSize: '11px' },
          onClick: () => this.app.engine.frameSelection(),
        }, 'Frame'),
      ),
      h('div.u-row.u-gap-1', { style: { flexWrap: 'wrap' } },
        ['x', 'y', 'z'].map((axis) =>
          h('button.btn', {
            type: 'button',
            style: { height: '24px', fontSize: '10.5px', padding: '0 8px' },
            title: `Rotate 90° around ${axis.toUpperCase()}`,
            onClick: () => {
              const rot = [...node.rotation];
              rot['xyz'.indexOf(axis)] += Math.PI / 2;
              this.app.scene.setTransform(node.id, { rotation: rot });
              this.app.history.commit('Rotate');
            },
          }, `+90° ${axis.toUpperCase()}`),
        ),
      ),
    ];
  }

  lightControls(node) {
    const light = node.light || {};
    const update = (patch) => {
      this.app.store.update('objects', (list) =>
        list.map((o) => (o.id === node.id ? { ...o, light: { ...o.light, ...patch } } : o)),
      );
      this.app.engine.syncFromStore();
    };
    return [
      prop('Type', selectField({
        value: light.type || 'point',
        options: ['directional', 'point', 'spot', 'area', 'ambient'],
        onChange: (v) => update({ type: v }),
      })),
      prop('Color', colorField({ value: light.color || '#ffffff', onChange: (v) => update({ color: v }) })),
      slider({ label: 'Intensity', value: light.intensity ?? 1, min: 0, max: 60, step: 0.1, onChange: (v) => update({ intensity: v }) }),
      slider({ label: 'Distance', value: light.distance ?? 0, min: 0, max: 60, step: 0.5, onChange: (v) => update({ distance: v }) }),
      slider({ label: 'Decay', value: light.decay ?? 2, min: 0, max: 4, step: 0.05, onChange: (v) => update({ decay: v }) }),
      toggleRow('Cast shadows', Boolean(light.castShadow), (v) => update({ castShadow: v })),
    ];
  }

  billboardControls(node) {
    const cfg = node.billboard || {};
    const update = (patch) => {
      this.app.store.update('objects', (list) =>
        list.map((o) => (o.id === node.id ? { ...o, billboard: { ...o.billboard, ...patch } } : o)),
      );
      this.app.billboards.sync();
      this.app.billboards.update();
    };
    return [
      prop('Text', textInput({ value: cfg.text || '', onChange: (v) => update({ text: v }) })),
      prop('Title', textInput({ value: cfg.title || '', onChange: (v) => update({ title: v }) })),
      prop('Subtitle', textInput({ value: cfg.subtitle || '', onChange: (v) => update({ subtitle: v }) })),
      prop('Style', segmented({
        small: true,
        value: cfg.style || 'bubble',
        options: [{ value: 'bubble', label: 'Bubble' }, { value: 'chip', label: 'Chip' }, { value: 'label', label: 'Label' }],
        onChange: (v) => update({ style: v }),
      })),
      slider({ label: 'Offset Y', value: cfg.offsetY ?? 1.2, min: -4, max: 6, step: 0.05, onChange: (v) => update({ offsetY: v }) }),
      slider({ label: 'Scale', value: cfg.scale ?? 1, min: 0.4, max: 3, step: 0.02, onChange: (v) => update({ scale: v }) }),
      slider({ label: 'Opacity', value: cfg.opacity ?? 1, min: 0, max: 1, step: 0.01, onChange: (v) => update({ opacity: v }) }),
    ];
  }

  vfxNodeControls(node) {
    const record = this.app.vfx.shaderFor(node);
    if (!record) return [emptyHint('This VFX has no shader assigned.', 'vfx')];
    return [
      prop('Geometry', selectField({
        value: node.vfx?.geometry || 'plane',
        options: ['plane', 'sphere', 'box', 'torus', 'cylinder'],
        onChange: (v) => {
          this.app.store.update('objects', (list) =>
            list.map((o) => (o.id === node.id ? { ...o, vfx: { ...o.vfx, geometry: v } } : o)),
          );
          this.app.vfx.sync();
        },
      })),
      slider({
        label: 'Scale', value: node.vfx?.scale ?? 1, min: 0.1, max: 12, step: 0.05,
        onChange: (v) => {
          this.app.store.update('objects', (list) =>
            list.map((o) => (o.id === node.id ? { ...o, vfx: { ...o.vfx, scale: v } } : o)),
          );
        },
      }),
      toggleRow('Face camera', Boolean(node.vfx?.billboard), (v) => {
        this.app.store.update('objects', (list) =>
          list.map((o) => (o.id === node.id ? { ...o, vfx: { ...o.vfx, billboard: v } } : o)),
        );
      }),
      ...this.uniformControls(node, record),
    ];
  }

  uniformControls(node, record) {
    const overrides = node.vfx?.uniforms || {};
    const setUniform = (name, value) => {
      this.app.store.update('objects', (list) =>
        list.map((o) => (o.id === node.id ? { ...o, vfx: { ...o.vfx, uniforms: { ...o.vfx.uniforms, [name]: value } } } : o)),
      );
      this.app.vfx.sync();
    };
    const rows = [];
    for (const [name, def] of Object.entries(record.uniforms || {})) {
      const value = overrides[name] !== undefined ? overrides[name] : def.value;
      if (def.type === 'color') {
        rows.push(prop(def.label || name, colorField({ value, onChange: (v) => setUniform(name, v) })));
      } else if (def.type === 'float' || def.type === 'int') {
        rows.push(slider({
          label: def.label || name,
          value: Number(value) || 0,
          min: def.min ?? 0,
          max: def.max ?? 1,
          step: def.step ?? 0.01,
          onChange: (v) => setUniform(name, v),
        }));
      }
    }
    return rows.length ? rows : [emptyHint('This shader has no numeric uniforms.', 'info')];
  }

  assetControls(node) {
    const asset = this.app.store.get('assets', []).find((a) => a.id === node.assetId);
    if (!asset) return [emptyHint('Asset metadata missing.', 'warn')];
    const rows = [
      h('div.u-col', { style: { gap: '3px', fontSize: '11px' } },
        h('div.u-row', {}, h('span.u-muted', {}, 'File'), h('span.u-truncate.u-grow', { style: { textAlign: 'right' }, title: asset.path }, basename(asset.path))),
        h('div.u-row', {}, h('span.u-muted', {}, 'Size'), h('span.u-grow', { style: { textAlign: 'right' } }, formatBytes(asset.size))),
        h('div.u-row', {}, h('span.u-muted', {}, 'Format'), h('span.u-grow', { style: { textAlign: 'right' } }, asset.format || '—')),
        h('div.u-row', {}, h('span.u-muted', {}, 'Meshes'), h('span.u-grow', { style: { textAlign: 'right' } }, formatNumber(asset.stats?.meshes))),
        h('div.u-row', {}, h('span.u-muted', {}, 'Triangles'), h('span.u-grow', { style: { textAlign: 'right' } }, formatNumber(asset.stats?.triangles))),
        h('div.u-row', {}, h('span.u-muted', {}, 'Materials'), h('span.u-grow', { style: { textAlign: 'right' } }, formatNumber(asset.stats?.materials))),
      ),
    ];
    if (asset.animations?.length) {
      rows.push(
        h('div.panel-title', {}, 'Clips'),
        ...asset.animations.map((clip) =>
          h('div.u-row', { style: { fontSize: '11px' } },
            icon('film', 12),
            h('span.u-grow.u-truncate', {}, clip.name),
            h('span.u-muted', {}, `${clip.duration.toFixed(2)}s`),
          ),
        ),
      );
    }
    return rows;
  }

  materialSection(node) {
    const materialIds = node.meta?.materialIds || [];
    const activeId = this.app.store.get('ui.activeMaterial') || materialIds[0];
    const record = this.app.store.get(`materials.${activeId}`);
    if (!record) {
      if (node.kind !== 'model') return null;
      return this.section('Material', [emptyHint('No material bound to this object.', 'layers')], { key: 'insp.mat', open: true });
    }
    const update = (patch, label = 'Material') => {
      this.app.store.set(`materials.${activeId}`, { ...record, ...patch });
      const mat = this.app.materials.build(this.app.store.get(`materials.${activeId}`));
      this.app.scene.refreshMaterial(activeId, mat);
      this.app.emit('materials:changed');
      if (label) this.app.history.commit(label);
    };
    const live = (patch) => {
      this.app.store.set(`materials.${activeId}`, { ...this.app.store.get(`materials.${activeId}`), ...patch });
      const mat = this.app.materials.build(this.app.store.get(`materials.${activeId}`));
      this.app.scene.refreshMaterial(activeId, mat);
    };

    const children = [
      materialIds.length > 1
        ? prop('Material', selectField({
            value: activeId,
            options: materialIds.map((id) => ({
              value: id,
              label: this.app.store.get(`materials.${id}`)?.name || id,
            })),
            onChange: (v) => this.app.setActiveMaterial(v),
          }))
        : null,
      prop('Name', textInput({ value: record.name, onChange: (v) => live({ name: v }), onCommit: () => this.app.history.commit('Rename material') })),
      prop('Base Color', h('div.u-row.u-gap-1', {},
        colorField({ value: record.baseColor || '#c9d4e6', onChange: (v) => live({ baseColor: v }), onCommit: () => this.app.history.commit('Base color') }),
        h('button.icon-btn.icon-sm', {
          type: 'button',
          title: 'Pick colour from viewport eyedropper',
          onClick: () => this.app.eyedropper(),
        }, icon('wand', 12)),
      )),
      slider({ label: 'Metalness', value: record.metalness ?? 0, min: 0, max: 1, step: 0.01, onChange: (v) => live({ metalness: v }), onCommit: () => this.app.history.commit('Metalness') }),
      slider({ label: 'Roughness', value: record.roughness ?? 0.5, min: 0, max: 1, step: 0.01, onChange: (v) => live({ roughness: v }), onCommit: () => this.app.history.commit('Roughness') }),
      prop('Emissive', colorField({ value: record.emissive || '#000000', onChange: (v) => live({ emissive: v }), onCommit: () => this.app.history.commit('Emissive') })),
      slider({ label: 'Emissive Power', value: record.emissiveIntensity ?? 0, min: 0, max: 6, step: 0.05, onChange: (v) => live({ emissiveIntensity: v }), onCommit: () => this.app.history.commit('Emissive power') }),
      slider({ label: 'Opacity', value: record.opacity ?? 1, min: 0, max: 1, step: 0.01, onChange: (v) => live({ opacity: v, transparent: v < 1 }), onCommit: () => this.app.history.commit('Opacity') }),
      h('div.u-row.u-gap-1', { style: { flexWrap: 'wrap' } },
        this.miniToggle('Double sided', record.doubleSided, (v) => update({ doubleSided: v })),
        this.miniToggle('Wireframe', record.wireframe, (v) => update({ wireframe: v })),
        this.miniToggle('Flat shade', record.flatShading, (v) => update({ flatShading: v })),
      ),
    ];

    return this.section('Material', [
      ...children,
      this.textureSlots(activeId, record),
      this.section('Advanced PBR', [
        slider({ label: 'Clearcoat', value: record.clearcoat ?? 0, min: 0, max: 1, step: 0.01, onChange: (v) => live({ clearcoat: v }), onCommit: () => this.app.history.commit('Clearcoat') }),
        slider({ label: 'Transmission', value: record.transmission ?? 0, min: 0, max: 1, step: 0.01, onChange: (v) => live({ transmission: v }), onCommit: () => this.app.history.commit('Transmission') }),
        slider({ label: 'IOR', value: record.ior ?? 1.5, min: 1, max: 2.5, step: 0.01, onChange: (v) => live({ ior: v }), onCommit: () => this.app.history.commit('IOR') }),
        slider({ label: 'Sheen', value: record.sheen ?? 0, min: 0, max: 1, step: 0.01, onChange: (v) => live({ sheen: v }), onCommit: () => this.app.history.commit('Sheen') }),
        slider({ label: 'Env Intensity', value: record.envMapIntensity ?? 1, min: 0, max: 3, step: 0.02, onChange: (v) => live({ envMapIntensity: v }), onCommit: () => this.app.history.commit('Env intensity') }),
        slider({ label: 'Normal Scale', value: record.normalScale ?? 1, min: 0, max: 4, step: 0.02, onChange: (v) => live({ normalScale: v }), onCommit: () => this.app.history.commit('Normal scale') }),
        slider({ label: 'AO Intensity', value: record.aoMapIntensity ?? 1, min: 0, max: 2, step: 0.02, onChange: (v) => live({ aoMapIntensity: v }), onCommit: () => this.app.history.commit('AO') }),
        slider({ label: 'Displacement', value: record.displacementScale ?? 0.05, min: 0, max: 1, step: 0.005, onChange: (v) => live({ displacementScale: v }), onCommit: () => this.app.history.commit('Displacement') }),
      ], { key: 'insp.pbr', open: false }),
    ], { key: 'insp.mat', open: true });
  }

  miniToggle(label, checked, onChange) {
    return h(
      `button.btn${checked ? '.is-active' : ''}`,
      {
        type: 'button',
        'aria-pressed': String(Boolean(checked)),
        style: {
          height: '24px',
          fontSize: '10.5px',
          padding: '0 8px',
          color: checked ? 'var(--accent)' : 'var(--fg-muted)',
          background: checked ? 'var(--accent-soft)' : 'transparent',
          borderColor: checked ? 'var(--accent)' : 'var(--border-default)',
        },
        onClick: (event) => {
          const next = event.currentTarget.getAttribute('aria-pressed') !== 'true';
          event.currentTarget.setAttribute('aria-pressed', String(next));
          event.currentTarget.classList.toggle('is-active', next);
          event.currentTarget.style.color = next ? 'var(--accent)' : 'var(--fg-muted)';
          event.currentTarget.style.background = next ? 'var(--accent-soft)' : 'transparent';
          event.currentTarget.style.borderColor = next ? 'var(--accent)' : 'var(--border-default)';
          onChange(next);
        },
      },
      label,
    );
  }

  textureSlots(materialId, record) {
    const slots = SLOTS.filter((s) => !s.packed);
    return h(
      'div.u-col',
      { style: { marginTop: '10px', gap: '6px' } },
      h('div.panel-title', {}, 'Texture maps'),
      ...slots.map((slot) => this.textureSlot(materialId, record, slot)),
      h('button.btn', {
        type: 'button',
        style: { height: '26px', fontSize: '11px', marginTop: '2px' },
        onClick: () => this.app.autoBindMaterial(materialId),
      }, icon('sparkle', 12), 'Auto-bind from library'),
    );
  }

  textureSlot(materialId, record, slot) {
    const tex = record.textures?.[slot.id];
    const thumb = tex ? this.app.getThumbnail(tex.blobId) : null;
    if (tex && !thumb && !this.app.pendingThumb.has(tex.blobId)) {
      this.app.pendingThumb.add(tex.blobId);
      this.app.texturePreview({ blobId: tex.blobId, name: tex.name }).then((url) => {
        this.app.pendingThumb.delete(tex.blobId);
        if (url) {
          this.app.cacheThumbnail(tex.blobId, url);
          this.panel.invalidate();
        }
      });
    }

    const el = h(
      `div.tex-slot${tex ? '.is-filled' : ''}`,
      {
        dataset: { slot: slot.id, materialId },
        title: tex ? `${tex.name} — click to replace, right-click for options` : `Drop a texture here (${slot.accept || slot.label})`,
        onClick: (event) => {
          if (event.target.closest('.tex-actions')) return;
          this.app.pickTextureFor(materialId, slot.id);
        },
        onContextMenu: (event) => {
          if (!tex) return;
          event.preventDefault();
          this.app.ui.contextMenu(event, [
            { label: 'Replace texture…', icon: 'upload', action: () => this.app.pickTextureFor(materialId, slot.id) },
            { label: 'Remove texture', icon: 'trash', danger: true, action: () => this.app.removeTexture(materialId, slot.id) },
          ]);
        },
        onDragOver: (event) => {
          if (!event.dataTransfer.types.includes('application/x-atlas-asset') && !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          el.classList.add('is-drop');
        },
        onDragLeave: () => el.classList.remove('is-drop'),
        onDrop: (event) => {
          el.classList.remove('is-drop');
          event.preventDefault();
          event.stopPropagation();
          const payload = event.dataTransfer.getData('application/x-atlas-asset');
          if (payload) {
            try {
              const { assetId } = JSON.parse(payload);
              this.app.assignAssetToSlot(assetId, materialId, slot.id);
            } catch { /* ignore malformed */ }
            return;
          }
          const file = event.dataTransfer.files?.[0];
          if (file) this.app.importer.assignTextureFile(materialId, slot.id, file);
        },
      },
      h('div.tex-thumb', {},
        thumb ? h('img', { src: thumb, alt: '' }) : icon('texture', 16),
      ),
      h('div.tex-info', {},
        h('div.tex-label', {}, slot.label),
        tex ? h('div.tex-name', { title: tex.name }, tex.name) : h('div.tex-empty', {}, slot.accept || 'Drop or click'),
      ),
      h('div.tex-actions', {},
        tex
          ? h('button.icon-btn.icon-sm', {
              type: 'button',
              title: 'Remove texture',
              onClick: (event) => {
                event.stopPropagation();
                this.app.removeTexture(materialId, slot.id);
              },
            }, icon('close', 11))
          : null,
      ),
    );
    return el;
  }

  objectControls(node) {
    return [
      toggleRow('Visible', node.visible !== false, () => this.app.scene.toggleVisibility(node.id)),
      toggleRow('Locked', Boolean(node.locked), () => this.app.scene.toggleLock(node.id)),
      h('div.u-row.u-gap-1', {},
        h('button.btn', { type: 'button', style: { flex: '1 1 0' }, onClick: () => this.app.scene.duplicate(node.id) }, icon('copy', 12), 'Duplicate'),
        h('button.btn.btn-danger', { type: 'button', style: { flex: '1 1 0' }, onClick: () => this.app.scene.delete(node.id) }, icon('trash', 12), 'Delete'),
      ),
      h('div.u-col', { style: { gap: '2px', fontSize: '10.5px', color: 'var(--fg-subtle)' } },
        h('div', {}, `id · ${node.id}`),
        h('div', {}, `kind · ${node.kind}`),
      ),
    ];
  }

  renderQuickSettings() {
    const env = this.app.store.get('environment', {});
    return this.section('Environment', [
      prop('Theme', selectField({
        value: env.theme,
        options: Object.entries(GRID_ENV_THEMES).map(([id, t]) => ({ value: id, label: t.label })),
        onChange: (v) => {
          this.app.store.set('environment.theme', v);
          this.app.history.commit('Environment');
        },
      })),
      toggleRow('Grid', env.showGrid !== false, (v) => this.app.store.set('environment.showGrid', v)),
      toggleRow('Backdrop', env.showBackground !== false, (v) => this.app.store.set('environment.showBackground', v)),
      slider({ label: 'Key Light', value: env.keyIntensity ?? 2.4, min: 0, max: 8, step: 0.05, onChange: (v) => this.app.store.set('environment.keyIntensity', v) }),
      slider({ label: 'Ambient', value: env.ambientIntensity ?? 0.65, min: 0, max: 3, step: 0.02, onChange: (v) => this.app.store.set('environment.ambientIntensity', v) }),
    ], { key: 'insp.env', open: true });
  }

  /* ============================================================ render */

  renderRenderTab() {
    const render = this.app.store.get('render', {});
    const set = (path, value, commit = true) => {
      this.app.store.set(`render.${path}`, value);
      if (commit) this.app.history.commit('Render settings');
    };
    return h(
      'div.panel',
      {},
      h('div.panel-title', {}, 'Image'),
      this.section('Tone & Colour', [
        prop('Tone mapping', selectField({
          value: render.toneMapping,
          options: ['ACESFilmic', 'AgX', 'Neutral', 'Linear', 'Reinhard', 'Cineon', 'None'],
          onChange: (v) => set('toneMapping', v),
        })),
        slider({ label: 'Exposure', value: render.exposure ?? 1, min: 0.1, max: 4, step: 0.01, onChange: (v) => set('exposure', v, false), onCommit: () => this.app.history.commit('Exposure') }),
        slider({ label: 'Pixel ratio', value: render.pixelRatioCap ?? 2, min: 0.5, max: 3, step: 0.05, onChange: (v) => set('pixelRatioCap', v, false), onCommit: () => this.app.history.commit('Pixel ratio') }),
      ], { key: 'render.tone', open: true }),

      this.section('Shadows', [
        toggleRow('Enable shadows', render.shadows !== false, (v) => set('shadows', v)),
        toggleRow('Soft shadows', render.softShadows !== false, (v) => set('softShadows', v)),
      ], { key: 'render.shadows', open: true }),

      this.section('Bloom', [
        toggleRow('Bloom', Boolean(render.bloom?.enabled), (v) => set('bloom.enabled', v)),
        slider({ label: 'Strength', value: render.bloom?.strength ?? 0.55, min: 0, max: 2, step: 0.01, onChange: (v) => set('bloom.strength', v, false), onCommit: () => this.app.history.commit('Bloom') }),
        slider({ label: 'Radius', value: render.bloom?.radius ?? 0.45, min: 0, max: 1, step: 0.01, onChange: (v) => set('bloom.radius', v, false), onCommit: () => this.app.history.commit('Bloom') }),
        slider({ label: 'Threshold', value: render.bloom?.threshold ?? 0.82, min: 0, max: 1, step: 0.01, onChange: (v) => set('bloom.threshold', v, false), onCommit: () => this.app.history.commit('Bloom') }),
      ], { key: 'render.bloom', open: false }),

      this.section('Grade & Grain', [
        toggleRow('Vignette', Boolean(render.vignette?.enabled), (v) => set('vignette.enabled', v)),
        slider({ label: 'Amount', value: render.vignette?.amount ?? 0.35, min: 0, max: 1, step: 0.01, onChange: (v) => set('vignette.amount', v, false), onCommit: () => this.app.history.commit('Vignette') }),
        toggleRow('Film grain', Boolean(render.film?.enabled), (v) => set('film.enabled', v)),
        slider({ label: 'Grain', value: render.film?.grain ?? 0.12, min: 0, max: 1, step: 0.01, onChange: (v) => set('film.grain', v, false), onCommit: () => this.app.history.commit('Grain') }),
        slider({ label: 'Contrast', value: render.film?.contrast ?? 1, min: 0.5, max: 1.8, step: 0.01, onChange: (v) => set('film.contrast', v, false), onCommit: () => this.app.history.commit('Contrast') }),
        slider({ label: 'Saturation', value: render.film?.saturation ?? 1, min: 0, max: 2, step: 0.01, onChange: (v) => set('film.saturation', v, false), onCommit: () => this.app.history.commit('Saturation') }),
      ], { key: 'render.grade', open: false }),

      this.section('Atmosphere', [
        toggleRow('Fog', Boolean(render.fog?.enabled), (v) => set('fog.enabled', v)),
        prop('Fog colour', colorField({ value: render.fog?.color || '#0b1020', onChange: (v) => set('fog.color', v) })),
        slider({ label: 'Near', value: render.fog?.near ?? 8, min: 0, max: 80, step: 0.5, onChange: (v) => set('fog.near', v, false), onCommit: () => this.app.history.commit('Fog') }),
        slider({ label: 'Far', value: render.fog?.far ?? 40, min: 1, max: 300, step: 1, onChange: (v) => set('fog.far', v, false), onCommit: () => this.app.history.commit('Fog') }),
      ], { key: 'render.fog', open: false }),
    );
  }

  /* ============================================================ lighting */

  renderLightingTab() {
    const env = this.app.store.get('environment', {});
    const set = (path, value, commit = true) => {
      this.app.store.set(`environment.${path}`, value);
      if (commit) this.app.history.commit('Lighting');
    };
    return h(
      'div.panel',
      {},
      h('div.panel-title', {}, 'Lighting rig'),
      this.section('Preset', [
        h('div.u-col.u-gap-1', {},
          Object.entries(LIGHT_PRESETS).map(([id, preset]) =>
            h('button.btn', {
              type: 'button',
              style: { justifyContent: 'space-between', height: '30px' },
              onClick: () => this.app.applyLightPreset(id),
            },
              h('span', {}, preset.name),
              h('span.u-row.u-gap-1', {},
                h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: preset.key.color } }),
                h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: preset.fill.color } }),
                h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: preset.rim.color } }),
              ),
            ),
          ),
        ),
      ], { key: 'light.presets', open: true }),

      this.section('Key light', [
        prop('Colour', colorField({ value: env.keyColor || '#ffe6c7', onChange: (v) => set('keyColor', v) })),
        slider({ label: 'Intensity', value: env.keyIntensity ?? 2.4, min: 0, max: 8, step: 0.02, onChange: (v) => set('keyIntensity', v, false), onCommit: () => this.app.history.commit('Key light') }),
      ], { key: 'light.key', open: true }),

      this.section('Fill & Rim', [
        prop('Fill colour', colorField({ value: env.fillColor || '#334b7a', onChange: (v) => set('fillColor', v) })),
        slider({ label: 'Fill intensity', value: env.fillIntensity ?? 0.55, min: 0, max: 4, step: 0.02, onChange: (v) => set('fillIntensity', v, false) }),
        prop('Rim colour', colorField({ value: env.rimColor || '#5f9dff', onChange: (v) => set('rimColor', v) })),
        slider({ label: 'Rim intensity', value: env.rimIntensity ?? 1.1, min: 0, max: 4, step: 0.02, onChange: (v) => set('rimIntensity', v, false) }),
      ], { key: 'light.fill', open: true }),

      this.section('Sun & Sky', [
        slider({ label: 'Azimuth', value: env.sunAzimuth ?? 40, min: -180, max: 180, step: 1, onChange: (v) => set('sunAzimuth', v, false) }),
        slider({ label: 'Elevation', value: env.sunElevation ?? 48, min: -10, max: 90, step: 1, onChange: (v) => set('sunElevation', v, false) }),
        prop('Ambient', colorField({ value: env.ambientColor || '#7f9bd6', onChange: (v) => set('ambientColor', v) })),
        slider({ label: 'Ambient power', value: env.ambientIntensity ?? 0.65, min: 0, max: 3, step: 0.02, onChange: (v) => set('ambientIntensity', v, false) }),
      ], { key: 'light.sun', open: true }),

      this.section('Environment', [
        toggleRow('Contact shadows', env.contactShadows !== false, (v) => set('contactShadows', v)),
        toggleRow('Show grid', env.showGrid !== false, (v) => set('showGrid', v)),
        toggleRow('Show backdrop', env.showBackground !== false, (v) => set('showBackground', v)),
        slider({ label: 'Env intensity', value: env.environmentIntensity ?? 0.9, min: 0, max: 3, step: 0.02, onChange: (v) => set('environmentIntensity', v, false) }),
      ], { key: 'light.env', open: false }),
    );
  }

  /* ============================================================ vfx */

  renderVfxTab() {
    const records = this.app.store.get('lighting.customShaders', []);
    return h(
      'div.panel',
      {},
      h('div.panel-title', {}, 'Shader library'),
      h('button.btn.btn-shine', {
        type: 'button',
        onClick: () => this.app.openShaderLab({ fresh: true }),
      }, icon('plus', 13), 'New shader effect'),
      h('div.u-col.u-gap-1', {},
        SHADER_PRESETS.map((preset) =>
          h('button.btn', {
            type: 'button',
            style: { justifyContent: 'space-between', height: '34px' },
            title: preset.description,
            onClick: () => this.app.addPresetVfx(preset.id),
          },
            h('span.u-row.u-gap-1', {}, icon('vfx', 13), h('span', {}, preset.name)),
            h('span.badge.badge-ghost', {}, preset.category),
          ),
        ),
      ),
      records.length ? h('div.panel-title', { style: { marginTop: '6px' } }, 'Your shaders') : null,
      ...records.map((record) =>
        h('div.u-row.u-gap-1', { style: { marginBottom: '4px' } },
          h('button.btn', {
            type: 'button',
            style: { flex: '1 1 auto', justifyContent: 'flex-start' },
            onClick: () => this.app.openShaderLab({ shaderId: record.id }),
          }, icon('text', 12), h('span.u-truncate', {}, record.name)),
          h('button.icon-btn.icon-sm', {
            type: 'button',
            title: 'Place in scene',
            onClick: () => this.app.addVfxNode(record.id),
          }, icon('plus', 12)),
        ),
      ),
      this.section('Billboards', [
        emptyHint('Billboards are HTML overlays locked to 3D points — perfect for callouts and annotations.', 'billboard'),
        h('button.btn', { type: 'button', onClick: () => this.app.scene.addBillboard({ text: 'New label' }) }, icon('plus', 12), 'Add label'),
        h('button.btn', {
          type: 'button',
          onClick: () => this.app.scene.addBillboard({ text: 'Selected', targetNodeId: this.app.store.get('selection.0'), style: 'chip' }),
        }, icon('billboard', 12), 'Label selected object'),
      ], { key: 'vfx.billboards', open: true }),
    );
  }
}
