/**
 * Left sidebar panels: asset library, scene hierarchy, material list, looks.
 */
import { $, h, icon, Panel, emptyHint } from './dom.js';
import { formatBytes, formatNumber, clamp } from '../core/util.js';
import { GRID_ENV_THEMES } from '../core/schema.js';
import { thumbnailFor } from '../assets/assetLoader.js';

const KIND_ICON = { model: 'cube', texture: 'texture', hdri: 'hdri', audio: 'audio' };

export class LeftSidebar {
  constructor(app) {
    this.app = app;
    this.root = $('#left-panel');
    this.filters = { query: '', kind: 'all', view: 'grid' };
    this.panel = new Panel(this.root, () => this.render());
    this.dragPayload = null;
    this.pendingThumbs = new Set();
    this.unsubs = [];
  }

  mount() {
    this.panel.mount();
    this.unsubs.push(
      this.app.store.subscribe(() => this.panel.invalidate(), 'assets'),
      this.app.store.subscribe(() => this.panel.invalidate(), 'objects'),
      this.app.store.subscribe(() => this.panel.invalidate(), 'materials'),
      this.app.store.subscribe(() => this.panel.invalidate(), 'selection'),
      this.app.store.subscribe(() => this.panel.invalidate(), 'ui.leftTab'),
      this.app.store.subscribe(() => this.panel.invalidate(), 'environment'),
    );
  }

  render() {
    const tab = this.app.store.get('ui.leftTab', 'assets');
    switch (tab) {
      case 'scene':
        return this.renderScene();
      case 'materials':
        return this.renderMaterials();
      case 'presets':
        return this.renderPresets();
      case 'assets':
      default:
        return this.renderAssets();
    }
  }

  /* ------------------------------------------------------------ assets */

  renderAssets() {
    const assets = this.app.store.get('assets', []);
    const models = assets.filter((a) => a.kind === 'model');
    const textures = assets.filter((a) => a.kind === 'texture');
    const hdris = assets.filter((a) => a.kind === 'hdri');
    const audio = assets.filter((a) => a.kind === 'audio');

    const q = this.filters.query.trim().toLowerCase();
    const match = (a) => !q || a.name.toLowerCase().includes(q) || (a.path || '').toLowerCase().includes(q);
    const filterKind = (list) => (this.filters.kind === 'all' ? list : list.filter((a) => a.kind === this.filters.kind)).filter(match);

    const totalBytes = assets.reduce((sum, a) => sum + (a.size || 0), 0);

    return h(
      'div',
      {},
      h(
        'div.asset-toolbar',
        {},
        h(
          'div.search-wrap',
          {},
          icon('search', 13),
          h('input.input', {
            type: 'search',
            placeholder: 'Search assets…',
            value: this.filters.query,
            'aria-label': 'Search assets',
            onInput: (e) => {
              this.filters.query = e.target.value;
              this.panel.invalidate();
            },
          }),
        ),
        h(
          'button.icon-btn.icon-sm',
          {
            type: 'button',
            title: this.filters.view === 'grid' ? 'List view' : 'Grid view',
            onClick: () => {
              this.filters.view = this.filters.view === 'grid' ? 'list' : 'grid';
              this.panel.invalidate();
            },
          },
          this.filters.view === 'grid' ? icon('layers', 13) : icon('grid', 13),
        ),
      ),
      h(
        'div.u-row.u-gap-1',
        { style: { padding: '0 8px 6px', flexWrap: 'wrap' } },
        ['all', 'model', 'texture', 'hdri', 'audio'].map((kind) =>
          h(
            `button.chip${this.filters.kind === kind ? '.is-active' : ''}`,
            {
              type: 'button',
              onClick: () => {
                this.filters.kind = kind;
                this.panel.invalidate();
              },
            },
            kind === 'all' ? 'All' : kind === 'model' ? 'Models' : kind === 'texture' ? 'Textures' : kind === 'hdri' ? 'HDRIs' : 'Audio',
          ),
        ),
      ),

      !assets.length ? emptyHint('Nothing yet — drop a model, ZIP or texture pack into the viewport.', 'upload') : null,

      models.length
        ? this.group(
            `Models · ${models.length}`,
            this.filters.view === 'grid' ? this.grid(models.filter((a) => this.filters.kind === 'all' || this.filters.kind === 'model').filter(match)) : this.list(models.filter(match)),
          )
        : null,
      textures.length ? this.group(`Textures · ${textures.length}`, this.filters.view === 'grid' ? this.grid(filterKind(textures)) : this.list(textures.filter(match))) : null,
      hdris.length ? this.group(`HDRIs · ${hdris.length}`, this.list(hdris.filter(match))) : null,
      audio.length ? this.group(`Audio · ${audio.length}`, this.list(audio.filter(match))) : null,

      h(
        'div.import-bar',
        {},
        h(
          'button.btn.btn-shine',
          { type: 'button', onClick: () => this.app.importPicker() },
          icon('plus', 14),
          'Import',
        ),
        h(
          'button.btn',
          { type: 'button', title: 'Import a .zip of models and textures', onClick: () => this.app.importPicker({ accept: '.zip' }) },
          icon('zip', 14),
          'ZIP',
        ),
      ),
      h(
        'div.u-muted',
        { style: { padding: '0 10px 12px', fontSize: '11px' } },
        `${assets.length} assets · ${formatBytes(totalBytes)}`,
      ),
    );
  }

  group(title, body) {
    return h(
      'div',
      { style: { marginBottom: '4px' } },
      h('div.panel-title', { style: { padding: '6px 10px 4px' } }, title),
      body,
    );
  }

  grid(items) {
    if (!items.length) return emptyHint('No matches', 'search');
    return h('div.asset-grid', {}, items.map((asset) => this.assetCard(asset)));
  }

  list(items) {
    if (!items.length) return emptyHint('No matches', 'search');
    return h('div.asset-list', {}, items.map((asset) => this.assetRow(asset)));
  }

  assetCard(asset) {
    const thumb = this.thumbnailFor(asset);
    return h(
      'button.asset-card',
      {
        type: 'button',
        draggable: true,
        title: `${asset.name}\n${asset.path || ''}\n${formatBytes(asset.size)}`,
        onClick: (event) => this.onAssetClick(asset, event),
        onDblClick: () => this.addAssetToScene(asset),
        onContextMenu: (event) => this.assetContextMenu(event, asset),
        onDragStart: (event) => {
          this.dragPayload = { assetId: asset.id, kind: asset.kind };
          event.dataTransfer.setData('application/x-atlas-asset', JSON.stringify(this.dragPayload));
          event.dataTransfer.effectAllowed = 'copy';
        },
        onDragEnd: () => {
          this.dragPayload = null;
        },
      },
      h(
        'div.asset-thumb',
        {},
        thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' }) : h('span.kind-icon', {}, icon(KIND_ICON[asset.kind] || 'cube', 30)),
        h('span.asset-badge', { dataset: { kind: asset.kind } }, asset.kind === 'model' ? (asset.format || 'model') : asset.kind),
      ),
      h(
        'div.asset-meta',
        {},
        h('div.asset-name', {}, asset.name),
        h(
          'div.asset-sub',
          {},
          formatBytes(asset.size || 0),
          asset.kind === 'model' && asset.stats ? ` · ${formatNumber(asset.stats.triangles)} tris` : '',
        ),
      ),
    );
  }

  assetRow(asset) {
    const selected = this.app.store.get('selection', []).includes(asset.id);
    return h(
      `div.asset-row${selected ? '.is-selected' : ''}`,
      {
        draggable: true,
        title: `${asset.name} — ${formatBytes(asset.size)}`,
        onClick: (event) => this.onAssetClick(asset, event),
        onDblClick: () => this.addAssetToScene(asset),
        onContextMenu: (event) => this.assetContextMenu(event, asset),
        onDragStart: (event) => {
          this.dragPayload = { assetId: asset.id, kind: asset.kind };
          event.dataTransfer.setData('application/x-atlas-asset', JSON.stringify(this.dragPayload));
          event.dataTransfer.effectAllowed = 'copy';
        },
      },
      h('span', { style: { opacity: 0.7 } }, icon(KIND_ICON[asset.kind] || 'cube', 13)),
      h('span.u-truncate', {}, asset.name),
      h('span.u-muted', { style: { fontSize: '10px', flex: 'none' } }, formatBytes(asset.size)),
    );
  }

  thumbnailFor(asset) {
    if (asset.kind === 'texture') {
      const cached = this.app.thumbCache.get(asset.blobId);
      if (cached) return cached;
      if (!this.pendingThumbs.has(asset.blobId)) {
        this.pendingThumbs.add(asset.blobId);
        this.app.texturePreview(asset).then((url) => {
          this.pendingThumbs.delete(asset.blobId);
          if (url) {
            this.app.thumbCache.set(asset.blobId, url);
            this.panel.invalidate();
          }
        });
      }
      return null;
    }
    if (asset.kind === 'model') {
      const cached = this.app.thumbCache.get(asset.id);
      if (cached) return cached;
      if (!this.pendingThumbs.has(asset.id)) {
        this.pendingThumbs.add(asset.id);
        this.renderModelThumb(asset);
      }
      return null;
    }
    return null;
  }

  async renderModelThumb(asset) {
    try {
      const object = this.app.scene.loadedObjects.get(asset.id);
      if (!object) return;
      const url = thumbnailFor(object, { size: 160 });
      this.app.thumbCache.set(asset.id, url);
      this.pendingThumbs.delete(asset.id);
      this.panel.invalidate();
    } catch {
      this.pendingThumbs.delete(asset.id);
    }
  }

  onAssetClick(asset, event) {
    if (asset.kind === 'hdri') {
      this.app.applyHdri(asset);
      return;
    }
    if (asset.kind === 'audio') {
      this.app.previewAudio(asset);
      return;
    }
    if (asset.kind === 'texture' && this.app.store.get('selection.0')) {
      // Click a material slot drop target first; otherwise just select.
      this.app.ui.textureTargetPrompt(asset);
      return;
    }
    if (event?.shiftKey) {
      this.addAssetToScene(asset);
      return;
    }
    this.app.toast.info(asset.name, 'Double-click to add to the scene.');
  }

  addAssetToScene(asset) {
    if (asset.kind !== 'model') {
      if (asset.kind === 'hdri') this.app.applyHdri(asset);
      return;
    }
    this.app.readdAsset(asset);
  }

  assetContextMenu(event, asset) {
    event.preventDefault();
    const items = [];
    if (asset.kind === 'model') {
      items.push({ label: 'Add to scene', icon: 'plus', action: () => this.addAssetToScene(asset) });
      items.push({ label: 'Frame camera on asset', icon: 'frame', action: () => this.addAssetToScene(asset) });
    }
    if (asset.kind === 'texture') {
      items.push({
        label: 'Assign to selected material…',
        icon: 'texture',
        action: () => this.app.ui.textureTargetPrompt(asset),
      });
      items.push({
        label: 'Copy name',
        icon: 'copy',
        action: () => navigator.clipboard?.writeText(asset.name),
      });
    }
    if (asset.kind === 'hdri') {
      items.push({ label: 'Use as environment', icon: 'hdri', action: () => this.app.applyHdri(asset) });
    }
    items.push({ label: '', separator: true });
    items.push({
      label: 'Remove from library',
      icon: 'trash',
      danger: true,
      action: () => this.app.removeAsset(asset.id),
    });
    this.app.ui.contextMenu(event, items);
  }

  /* ------------------------------------------------------------ scene */

  renderScene() {
    const objects = this.app.store.get('objects', []);
    const selection = this.app.store.get('selection', []);
    const roots = objects.filter((o) => !o.parentId);
    const childrenOf = (id) => objects.filter((o) => o.parentId === id);
    const collapsed = this.app.uiState.collapsedNodes || new Set();

    const rows = [];
    const walk = (node, depth) => {
      rows.push(this.treeRow(node, depth, selection, collapsed, childrenOf(node.id).length > 0));
      if (collapsed.has(node.id)) return;
      for (const child of childrenOf(node.id)) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);

    return h(
      'div',
      {},
      h(
        'div.panel-head',
        {},
        h('span.panel-title', {}, `${objects.length} object${objects.length === 1 ? '' : 's'}`),
        h(
          'div.u-row.u-gap-1',
          {},
          h('button.icon-btn.icon-sm', { type: 'button', title: 'Add empty group', onClick: () => this.app.scene.addBillboard({ text: 'Group', style: 'chip' }) }, icon('plus', 13)),
        ),
      ),
      h(
        'div.tree',
        {
          onDragOver: (event) => {
            if (event.target.closest('.tree-row')) return;
            event.preventDefault();
          },
          onDrop: (event) => {
            const nodeId = event.dataTransfer.getData('application/x-atlas-node');
            if (nodeId && !event.target.closest('.tree-row')) {
              event.preventDefault();
              this.app.scene.setParent(nodeId, null);
            }
          },
        },
        rows.length ? rows : emptyHint('The scene is empty. Drop a file into the viewport to begin.', 'cube'),
      ),
      h(
        'div.u-row.u-gap-1',
        { style: { padding: '4px 8px 10px', flexWrap: 'wrap' } },
        h('button.btn', { type: 'button', onClick: () => this.app.scene.addPrimitive('cube') }, icon('cube', 13), 'Cube'),
        h('button.btn', { type: 'button', onClick: () => this.app.scene.addPrimitive('sphere') }, icon('cube', 13), 'Sphere'),
        h('button.btn', { type: 'button', onClick: () => this.app.scene.addLight('point') }, icon('light', 13), 'Light'),
        h('button.btn', { type: 'button', onClick: () => this.app.scene.addBillboard({ text: 'Label' }) }, icon('billboard', 13), 'Label'),
      ),
    );
  }

  treeRow(node, depth, selection, collapsed, hasChildren) {
    const isSelected = selection.includes(node.id);
    const open = !collapsed.has(node.id);
    const row = h(
      `div.tree-row${isSelected ? '.is-selected' : ''}`,
      {
        draggable: true,
        dataset: { nodeId: node.id, open: String(open) },
        style: { paddingLeft: `${6 + depth * 13}px` },
        onClick: (event) => {
          this.app.scene.select([node.id], { additive: event.shiftKey || event.metaKey || event.ctrlKey });
        },
        onDblClick: () => this.beginRename(node, row),
        onContextMenu: (event) => this.nodeContextMenu(event, node),
        onDragStart: (event) => {
          event.dataTransfer.setData('application/x-atlas-node', node.id);
          event.dataTransfer.effectAllowed = 'move';
          row.classList.add('is-dragging');
        },
        onDragEnd: () => row.classList.remove('is-dragging'),
        onDragOver: (event) => {
          if (!event.dataTransfer.types.includes('application/x-atlas-node')) return;
          event.preventDefault();
          row.classList.add('is-drop-target');
        },
        onDragLeave: () => row.classList.remove('is-drop-target'),
        onDrop: (event) => {
          row.classList.remove('is-drop-target');
          const childId = event.dataTransfer.getData('application/x-atlas-node');
          if (childId && childId !== node.id) {
            event.preventDefault();
            event.stopPropagation();
            this.app.scene.setParent(childId, node.id);
          }
        },
      },
      h(
        'span.tree-caret',
        {
          onClick: (event) => {
            event.stopPropagation();
            if (!hasChildren) return;
            if (collapsed.has(node.id)) collapsed.delete(node.id);
            else collapsed.add(node.id);
            this.app.uiState.collapsedNodes = collapsed;
            this.panel.invalidate();
          },
          style: { visibility: hasChildren ? 'visible' : 'hidden' },
        },
        icon('chevron', 11),
      ),
      h('span.tree-icon', {}, icon(iconForKind(node), 13)),
      h('span.tree-name', { title: node.name }, node.name),
      h(
        'span.tree-actions',
        {},
        h(
          'button.tree-mini',
          {
            type: 'button',
            title: node.visible === false ? 'Show' : 'Hide',
            'aria-pressed': String(node.visible !== false),
            onClick: (event) => {
              event.stopPropagation();
              this.app.scene.toggleVisibility(node.id);
            },
          },
          icon(node.visible === false ? 'eyeOff' : 'eye', 12),
        ),
        h(
          'button.tree-mini',
          {
            type: 'button',
            title: node.locked ? 'Unlock' : 'Lock',
            'aria-pressed': String(Boolean(node.locked)),
            onClick: (event) => {
              event.stopPropagation();
              this.app.scene.toggleLock(node.id);
            },
          },
          icon(node.locked ? 'lock' : 'unlock', 12),
        ),
      ),
    );
    return row;
  }

  beginRename(node, row) {
    const nameEl = row.querySelector('.tree-name');
    if (!nameEl) return;
    const input = h('input.tree-name-input', {
      value: node.name,
      onKeyDown: (event) => {
        if (event.key === 'Enter') input.blur();
        if (event.key === 'Escape') {
          input.value = node.name;
          input.blur();
        }
      },
      onBlur: () => {
        if (input.value.trim() && input.value !== node.name) this.app.scene.rename(node.id, input.value);
        this.panel.invalidate();
      },
    });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  nodeContextMenu(event, node) {
    event.preventDefault();
    const items = [
      { label: 'Rename', icon: 'text', action: () => this.beginRename(node, event.target.closest('.tree-row')) },
      { label: 'Duplicate', icon: 'copy', action: () => this.app.scene.duplicate(node.id) },
      { label: 'Frame', icon: 'frame', action: () => this.app.scene.select([node.id]) ?? this.app.engine.frameSelection() },
      { label: '', separator: true },
      { label: 'Add billboard label', icon: 'billboard', action: () => this.app.scene.addBillboard({ text: node.name, targetNodeId: node.id }) },
      node.kind === 'light'
        ? { label: 'Duplicate light', icon: 'light', action: () => this.app.scene.duplicate(node.id) }
        : { label: '', separator: true },
      { label: 'Delete', icon: 'trash', danger: true, action: () => this.app.scene.delete(node.id) },
    ];
    this.app.ui.contextMenu(event, items);
  }

  /* ------------------------------------------------------------ materials */

  renderMaterials() {
    const materials = Object.values(this.app.store.get('materials', {}));
    const activeId = this.app.store.get('ui.activeMaterial');
    if (!materials.length) {
      return h(
        'div',
        {},
        emptyHint('No materials yet. Import a model or add a primitive to create one.', 'layers'),
        h('div.u-row', { style: { padding: '0 12px' } },
          h('button.btn', { type: 'button', onClick: () => this.app.scene.addPrimitive('cube') }, icon('plus', 13), 'Add cube'),
        ),
      );
    }
    return h(
      'div',
      {},
      h(
        'div.panel-head',
        {},
        h('span.panel-title', {}, `${materials.length} materials`),
      ),
      ...materials.map((mat) =>
        h(
          `button.mat-card${mat.id === activeId ? '.is-selected' : ''}`,
          {
            type: 'button',
            onClick: () => this.app.setActiveMaterial(mat.id),
          },
          h('span.mat-swatch', { style: { background: mat.baseColor || '#c9d4e6' } }),
          h(
            'span.mat-info',
            {},
            h('span.mat-name', {}, mat.name),
            h(
              'span.mat-sub',
              {},
              `${Object.keys(mat.textures || {}).length} textures · rough ${(mat.roughness ?? 0).toFixed(2)} · metal ${(mat.metalness ?? 0).toFixed(2)}`,
            ),
          ),
        ),
      ),
    );
  }

  /* ------------------------------------------------------------ presets */

  renderPresets() {
    const env = this.app.store.get('environment', {});
    const activeTheme = env.theme;
    const looks = [
      { id: 'night', ...GRID_ENV_THEMES.night },
      { id: 'studio', ...GRID_ENV_THEMES.studio },
      { id: 'dawn', ...GRID_ENV_THEMES.dawn },
      { id: 'mint', ...GRID_ENV_THEMES.mint },
      { id: 'paper', ...GRID_ENV_THEMES.paper },
    ];
    return h(
      'div',
      {},
      h('div.panel-title', { style: { padding: '10px 10px 6px' } }, 'Environment looks'),
      h(
        'div.preset-grid',
        {},
        looks.map((look) =>
          h(
            `button.preset-tile${activeTheme === look.id ? '.is-active' : ''}`,
            {
              type: 'button',
              onClick: () => {
                this.app.store.set('environment.theme', look.id);
                this.app.store.patch({
                  environment: {
                    ambientColor: look.ambient,
                    keyColor: look.keyColor,
                    keyIntensity: look.keyIntensity,
                    rimColor: look.rimColor,
                    rimIntensity: look.rimIntensity,
                    fillColor: look.fillColor,
                    fillIntensity: look.fillIntensity,
                  },
                });
                this.app.history.commit('Environment look');
              },
            },
            h('span.preset-swatch', {
              style: { background: `linear-gradient(135deg, ${look.sky.join(', ')})` },
            }),
            h('span.preset-name', {}, look.label),
            h('span.preset-desc', {}, look.background === 'gradient' ? 'Gradient sky' : 'Solid backdrop'),
          ),
        ),
      ),
      h('div.panel-title', { style: { padding: '10px 10px 6px' } }, 'Look presets'),
      h(
        'div.preset-grid',
        {},
        Object.entries(this.app.looks()).map(([id, look]) =>
          h(
            'button.preset-tile',
            { type: 'button', onClick: () => this.app.applyLook(id) },
            h('span.preset-swatch', { style: { background: look.swatch } }),
            h('span.preset-name', {}, look.name),
            h('span.preset-desc', {}, look.description),
          ),
        ),
      ),
    );
  }
}

function iconForKind(node) {
  switch (node.kind) {
    case 'light':
      return 'light';
    case 'vfx':
      return 'vfx';
    case 'billboard':
      return 'billboard';
    case 'group':
      return 'group';
    default:
      return node.meta?.primitive ? 'cube' : 'cube';
  }
}

export { clamp };
