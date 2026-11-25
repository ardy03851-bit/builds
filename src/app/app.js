/**
 * The App: wires the store, engine, controllers, panels, dialogs and
 * keyboard/touch input into one coherent product.
 */
import * as THREE from 'three';
import { Store, History } from '../core/store.js';
import { createInitialState, DEFAULT_CAMERA, MATERIAL_DEFAULTS, LIGHT_PRESETS, GRID_ENV_THEMES } from '../core/schema.js';
import { blobs } from '../core/blobstore.js';
import { clamp, debounce, uid, isTouchDevice } from '../core/util.js';
import { basename, extensionOf } from '../core/paths.js';
import { Engine } from '../engine/engine.js';
import { MaterialLibrary } from '../engine/materials.js';
import { VfxController, BillboardController, AnimationController } from './controllers.js';
import { SceneManager } from './scene.js';
import { Importer } from './importer.js';
import { ProjectIO } from './project.js';
import { ShotStudio } from './shots.js';
import { Toaster } from '../ui/toasts.js';
import { openModal, closeModal, confirmModal } from '../ui/modal.js';
import {
  $, $$, h, icon, clear,
} from '../ui/dom.js';
import { LeftSidebar } from '../ui/leftSidebar.js';
import { RightSidebar } from '../ui/rightSidebar.js';
import { Dock } from '../ui/dock.js';
import {
  zipReviewDialog, matchReviewDialog, exportDialog, shaderLabDialog, shortcutsDialog,
  texturePickerDialog, welcomeDialog,
} from '../ui/dialogs.js';
import { loadTextureBlob, loadAsset } from '../assets/assetLoader.js';
import { SHADER_PRESETS, PRESET_BY_ID, uniformsFromPreset } from '../core/shaderlib.js';
import { SLOT_BY_ID } from '../core/slots.js';

export class App {
  constructor() {
    this.store = new Store(createInitialState());
    this.history = new History(this.store, { limit: 90 });
    this.events = new EventTarget();
    this.events.on = (name, fn) => {
      const wrapped = (event) => fn(event.detail);
      this.events.addEventListener(name, wrapped);
      return () => this.events.removeEventListener(name, wrapped);
    };
    this.consoleLines = [];
    this.thumbCache = new Map();
    this.thumbCacheLimit = 128;
    this.texturePreviewQueue = [];
    this.texturePreviewPending = new Map();
    this.texturePreviewActive = false;
    this.pendingThumb = new Set();
    this.uiState = { collapsedNodes: new Set(), shaderId: null };
    this.touchMode = isTouchDevice();

    this._initEngine();
    this._initControllers();
    // While dragging a gizmo we must not rebuild panels; flush afterwards.
    this.events.addEventListener('transform:start', () => { this._dragging = true; });
    this.events.addEventListener('transform:end', () => { this._dragging = false; });
    this.events.addEventListener('scene:changed', () => {
      if (this._dragging) {
        this._sceneChangedPending = true;
        return;
      }
      this._sceneChanged();
    });
    this._initUI();
    this._initInput();
    this._initAutosave();
    this._announceReady();
  }

  /* ================================================================ */
  /* bootstrap                                                        */
  /* ================================================================ */

  _initEngine() {
    const viewport = $('#viewport');
    this.engine = new Engine(viewport, this.store, {
      onSelect: (id, opts) => {
        if (id) this.scene.select([id], { additive: opts?.additive });
        else if (!opts?.additive) this.scene.select([]);
      },
      onStats: (stats) => this.updateStats(stats),
      onFrame: (dt) => this.onFrame(dt),
      onPickHover: (hit) => this.onHover(hit),
    });
    this.engine.onAttachNode = (group, node) => this.attachNodeObject(group, node);
    this.engine.onTransformCommit = () => this.history.commit('Transform');
    this.engine.onDragStart = () => this.emit('transform:start');
    this.engine.onDragEnd = () => {
      this.emit('transform:end');
      this.emit('scene:changed');
      if (this._sceneChangedPending) {
        this._sceneChangedPending = false;
        this._sceneChanged();
      }
    };
    this.materials = new MaterialLibrary(this.engine);
    this.materials.onTextureError = (key, err) => {
      this.log('error', `Texture failed to load (${key}): ${err?.message || err}`);
    };

    const persistCamera = debounce(() => {
      const pose = this.engine.currentPose();
      this.store.patch({ camera: { position: pose.position, target: pose.target } });
    }, 220);
    this.engine.persistCamera = persistCamera;
  }

  _initControllers() {
    this.vfx = new VfxController(this.engine, this.store);
    this.vfx.onError = (nodeId, message) => this.log('error', `VFX compile failed: ${message}`);
    this.billboards = new BillboardController(this.engine, this.store, $('#billboard-layer'));
    this.animation = new AnimationController(this.engine, this.store, this);
    this.scene = new SceneManager(this);
    this.importer = new Importer(this);
    this.io = new ProjectIO(this);
    this.shots = new ShotStudio(this);
    this.toast = new Toaster($('#toasts'));
    this.engine.billboardsUpdate = () => {
      this.billboards.update();
      this.vfx.tick(this.engine.elapsed);
    };
    this.engine.onTimelineSync = () => this.animation.onStoreChange?.();
  }

  _initUI() {
    this.left = new LeftSidebar(this);
    this.right = new RightSidebar(this);
    this.dock = new Dock(this);
    this.left.mount();
    this.right.mount();
    this.dock.mount();

    this.ui = {
      zipReview: (plan, reader, file) => zipReviewDialog(this, plan, reader, file),
      matchReview: (payload) => matchReviewDialog(this, payload),
      contextMenu: (event, items) => this.showContextMenu(event, items),
      textureTargetPrompt: (asset) => this.textureTargetPrompt(asset),
      refreshModal: () => this.repaintModal(),
    };

    this.applyUiState();
    this.bindChrome();
  }

  _initInput() {
    this._bindDragAndDrop();
    this._bindKeyboard();
    this._bindFilePicker();
    this._bindGlobalPointer();
  }

  _initAutosave() {
    const schedule = debounce(() => this.io.scheduleAutosave(900), 450);
    // Keep asset-only projects and render/camera edits recoverable too. Avoid
    // subscribing to the whole timeline: playback time can change many times
    // per second and should not continuously serialize the document.
    const paths = [
      'objects', 'assets', 'materials', 'environment', 'render', 'camera',
      'lighting', 'snap', 'shot', 'meta.name', 'ui.theme', 'timeline.duration',
      'timeline.loop', 'timeline.speed', 'timeline.tracks',
    ];
    for (const path of paths) this.store.subscribe(schedule, path);
  }

  _announceReady() {
    // Offer to restore an autosave, but never block first paint.
    setTimeout(async () => {
      try {
        const autosave = await this.io.loadAutosave();
        if (autosave && (autosave.objects?.length || autosave.assets?.length)) {
          const restoreToast = this.toast.show({
            kind: 'info',
            title: 'Restore your last session?',
            message: `${autosave.objects?.length || 0} objects · saved ${new Date(autosave.savedAt || Date.now()).toLocaleTimeString()}`,
            persistent: true,
            actions: [
              h('button.btn.btn-primary', {
                type: 'button',
                style: { height: '24px', fontSize: '11px' },
                onClick: async () => {
                  await this.io.applyDocument(autosave, { source: 'autosave', silent: true });
                  restoreToast?.dismiss();
                  this.toast.success('Session restored');
                },
              }, 'Restore'),
              h('button.btn', {
                type: 'button',
                style: { height: '24px', fontSize: '11px' },
                onClick: async () => {
                  await this.io.clearAutosave();
                  restoreToast?.dismiss();
                },
              }, 'Start fresh'),
            ],
          });
          this.lastRestoreToast = restoreToast;
        }
      } catch {
        /* ignore */
      }
    }, 900);
  }

  /* ================================================================ */
  /* chrome + events                                                  */
  /* ================================================================ */

  bindChrome() {
    const on = (selector, event, handler) => {
      const el = $(selector);
      if (el) el.addEventListener(event, handler);
    };

    on('#btn-undo', 'click', () => this.undo());
    on('#btn-redo', 'click', () => this.redo());
    on('#btn-save', 'click', () => this.io.save());
    on('#btn-export', 'click', () => exportDialog(this));
    on('#btn-command', 'click', () => this.openCommandPalette());
    on('#btn-help', 'click', () => shortcutsDialog(this));
    on('#btn-import-empty', 'click', () => this.importPicker());
    on('#btn-samples', 'click', () => this.loadSampleScene());
    on('#btn-stats-toggle', 'click', () => this.toggleStats());
    on('#btn-theme-toggle', 'click', () => this.toggleTheme());
    on('#btn-touch-toggle', 'click', () => this.toggleTouchMode());
    on('#btn-dock-collapse', 'click', () => this.toggleDock());
    on('#btn-frame', 'click', () => this.engine.frameSelection());
    on('#btn-snap', 'click', () => this.toggleSnap());
    on('#btn-orbit-auto', 'click', () => this.toggleAutoOrbit());
    on('#chip-ortho', 'click', () => this.toggleOrtho());
    on('#btn-project-name', 'click', () => this.renameProject());
    on('#btn-brand', 'click', () => this.openFileMenu());

    $$('.seg-btn[data-space]').forEach((btn) => {
      btn.addEventListener('click', () => this.setSpace(btn.dataset.space));
    });
    $$('.side-tab[data-left-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.set('ui.leftTab', btn.dataset.leftTab);
        $$('.side-tab[data-left-tab]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        this.left.panel.invalidate();
      });
    });
    $$('.side-tab[data-right-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.set('ui.rightTab', btn.dataset.rightTab);
        $$('.side-tab[data-right-tab]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        this.right.panel.invalidate();
      });
    });
    $$('.dock-tab[data-bottom-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.set('ui.bottomTab', btn.dataset.bottomTab);
        $$('.dock-tab[data-bottom-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
        this.dock.panel.invalidate();
      });
    });
    $$('[data-gizmo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.set('ui.gizmoMode', btn.dataset.gizmo);
        $$('[data-gizmo]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        this.engine.transform.setMode(btn.dataset.gizmo);
      });
    });
    $$('[data-space-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.set('ui.gizmoSpace', btn.dataset.spaceMode);
        $$('[data-space-mode]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        this.engine.transform.setSpace(btn.dataset.spaceMode);
      });
    });
    $$('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => this.setView(btn.dataset.view));
    });

    this.unsubs = [
      this.store.subscribe(() => this.updateStatusBar(), 'selection'),
      this.store.subscribe(() => this.updateStatusBar(), 'objects'),
      this.store.subscribe(() => this.updateEmptyState(), 'objects'),
      this.store.subscribe(() => this.updateProjectName(), 'meta.name'),
      this.store.subscribe(() => this.refreshUndoButtons(), 'ui.gizmoMode'),
      this.store.subscribe(() => {
        if (!this.store.get('timeline.playing')) this.animation.seek(this.store.get('timeline.time', 0));
      }, 'timeline.time'),
      this.store.subscribe(() => this.vfx.sync(), 'objects'),
      this.store.subscribe(() => this.vfx.sync(), 'lighting'),
      this.store.subscribe(() => this.billboards.sync(), 'objects'),
      this.store.subscribe(() => this.billboards.sync(), 'selection'),
    ];

    this.events.addEventListener('console:changed', () => this.refreshConsoleBadge());
    this.updateStatusBar();
    this.updateEmptyState();
    this.updateProjectName();
    this.refreshUndoButtons();
  }

  _sceneChanged() {
    this.left.panel.invalidate();
    this.right.panel.invalidate();
    this.updateStatusBar();
    this.updateEmptyState();
  }

  emit(name, detail = null) {
    this.events.dispatchEvent(new CustomEvent(name, { detail }));
    return this;
  }

  on(name, fn) {
    this.events.addEventListener(name, fn);
    return () => this.events.removeEventListener(name, fn);
  }

  /* ================================================================ */
  /* console                                                          */
  /* ================================================================ */

  log(level, message) {
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    this.consoleLines.push({ level, message, time: stamp });
    if (this.consoleLines.length > 400) this.consoleLines.shift();
    if (level === 'error') console.error('[atlas]', message);
    else if (level === 'warn') console.warn('[atlas]', message);
    this.emit('console:changed');
  }

  refreshConsoleBadge() {
    const badge = $('#console-count');
    if (!badge) return;
    const problems = this.consoleLines.filter((l) => l.level === 'error' || l.level === 'warn').length;
    badge.hidden = problems === 0;
    badge.textContent = String(problems);
  }

  /* ================================================================ */
  /* frame loop                                                       */
  /* ================================================================ */

  onFrame(dt) {
    if (this.store.get('timeline.playing')) {
      this.animation.update(dt);
      this.dock?.updatePlayhead(this.animation.elapsed);
    }
    if (this.autoOrbit) {
      this.engine.orbit.autoRotate = true;
      this.engine.orbit.autoRotateSpeed = 1.1;
    }
  }

  onHover(hit) {
    if (!hit) {
      this.canvasTitle?.remove?.();
      return;
    }
    const node = this.store.get('objects', []).find((o) => o.id === hit.nodeId);
    if (node) this.engine.canvas.title = node.name;
  }

  updateStats(stats) {
    this.store.set('stats', {
      ...stats,
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
    });
    if ($('#stats-overlay')?.hidden) return;
    const set = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };
    set('#stat-fps', stats.fps);
    set('#stat-calls', stats.drawCalls);
    set('#stat-tris', stats.triangles.toLocaleString());
    set('#stat-tex', stats.textures);
    set('#stat-geo', stats.geometries);
    set('#stat-dpi', `${stats.pixelRatio.toFixed(2)}×`);
  }

  /* ================================================================ */
  /* UI state                                                         */
  /* ================================================================ */

  applyUiState() {
    const app = $('#app');
    const ui = this.store.get('ui', {});
    document.documentElement.dataset.theme = ui.theme || 'dark';
    document.documentElement.dataset.accent = ui.accent || 'aurora';
    document.documentElement.dataset.touch = String(Boolean(this.touchMode));
    document.documentElement.dataset.contrast = ui.highContrast ? 'high' : 'normal';
    app.dataset.loading = 'false';
    app.dataset.sidebar = ui.sidebarCollapsed ? 'collapsed' : 'expanded';
    app.dataset.dock = this.dockCollapsed ? 'collapsed' : 'expanded';
    $('#stats-overlay').hidden = !ui.showStats;
    if (this.engine) {
      this.engine.transform.setMode(ui.gizmoMode || 'translate');
      this.engine.transform.setSpace(ui.gizmoSpace || 'world');
    }
    this.updateEmptyState();
    const sse = $('.app');
    if (sse) sse.style.setProperty('--left-w', `${ui.leftWidth || 288}px`);
  }

  setSpace(space) {
    if (space === 'shader') {
      this.openShaderLab({ shaderId: this.store.get('lighting.customShaders.0.id') || null, fresh: !this.store.get('lighting.customShaders.0.id') });
      this.store.set('ui.bottomTab', 'shader');
      this.syncDockTabs();
      return;
    }
    if (space === 'shot') {
      exportDialog(this);
      return;
    }
    this.store.set('ui.space', space);
  }

  syncDockTabs() {
    const tab = this.store.get('ui.bottomTab', 'timeline');
    $$('.dock-tab[data-bottom-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.bottomTab === tab));
    this.dock.panel.invalidate();
  }

  updateEmptyState() {
    const empty = !this.store.get('objects', []).length;
    const el = $('#empty-state');
    if (el) el.hidden = !empty;
  }

  updateProjectName() {
    const name = this.store.get('meta.name', 'Untitled Scene');
    const btn = $('#btn-project-name');
    if (btn) btn.textContent = name;
    document.title = `${name} — Atlas Scene Studio`;
  }

  updateStatusBar() {
    const objects = this.store.get('objects', []);
    const selection = this.store.get('selection', []);
    const label = $('#status-selection');
    const counts = $('#status-counts');
    if (label) {
      if (!selection.length) label.textContent = 'Nothing selected';
      else if (selection.length === 1) {
        const node = objects.find((o) => o.id === selection[0]);
        label.textContent = node ? `${node.name} · ${node.kind}` : '1 selected';
      } else label.textContent = `${selection.length} objects selected`;
    }
    if (counts) {
      const summary = this.scene.summary();
      counts.textContent = `${summary.objects} objects · ${summary.triangles.toLocaleString()} tris · ${summary.lights} lights`;
    }
    this.refreshUndoButtons();
  }

  refreshUndoButtons() {
    const undo = $('#btn-undo');
    const redo = $('#btn-redo');
    if (undo) undo.disabled = !this.history.canUndo;
    if (redo) redo.disabled = !this.history.canRedo;
    const saveState = $('#save-state');
    if (saveState) saveState.textContent = this.history.canUndo ? 'edited' : 'saved';
  }

  repaintModal() {
    // Modal content is rebuilt by re-opening the picker with fresh thumbs
    // instead of surgically patching; simplest correct behaviour.
    this.emit('modal:repaint');
  }

  /* ================================================================ */
  /* selection-independent actions                                    */
  /* ================================================================ */

  undo() {
    const label = this.history.undo();
    if (!label) return;
    this.afterHistory();
    this.toast.info('Undo', label);
  }

  redo() {
    const label = this.history.redo();
    if (!label) return;
    this.afterHistory();
    this.toast.info('Redo', label);
  }

  afterHistory() {
    this.engine.syncFromStore();
    this.engine.syncTransforms();
    this.engine.syncSelection();
    this.vfx.sync();
    this.billboards.sync();
    this.left.panel.invalidate();
    this.right.panel.invalidate();
    this.updateStatusBar();
    this.updateEmptyState();
    this.refreshUndoButtons();
  }

  toggleStats() {
    const next = !this.store.get('ui.showStats');
    this.store.set('ui.showStats', next);
    $('#stats-overlay').hidden = !next;
    const btn = $('#btn-stats-toggle');
    if (btn) btn.classList.toggle('is-active', next);
  }

  toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    this.store.set('ui.theme', next);
    this.engine?.applyEnvironment();
  }

  toggleTouchMode() {
    this.touchMode = !this.touchMode;
    document.documentElement.dataset.touch = String(this.touchMode);
    const btn = $('#btn-touch-toggle');
    if (btn) btn.classList.toggle('is-active', this.touchMode);
    this.toast.info(this.touchMode ? 'Touch mode on' : 'Touch mode off', 'Larger tap targets and panels.');
    setTimeout(() => this.engine.resize(), 240);
  }

  toggleDock() {
    this.dockCollapsed = !this.dockCollapsed;
    $('#app').dataset.dock = this.dockCollapsed ? 'collapsed' : 'expanded';
    setTimeout(() => this.engine.resize(), 240);
  }

  toggleSnap() {
    const next = !this.store.get('snap.enabled');
    this.store.set('snap.enabled', next);
    this.applySnap();
    $('#btn-snap')?.toggleAttribute('data-on', next);
    $('#btn-snap')?.setAttribute('aria-pressed', String(next));
  }

  applySnap() {
    const snap = this.store.get('snap', {});
    if (snap.enabled === false) {
      this.engine.transform.setTranslationSnap(null);
      this.engine.transform.setRotationSnap(null);
      this.engine.transform.setScaleSnap(null);
      return;
    }
    this.engine.transform.setTranslationSnap(snap.translate || 0.25);
    this.engine.transform.setRotationSnap(snap.rotate || Math.PI / 12);
    this.engine.transform.setScaleSnap(snap.scale || 0.1);
  }

  toggleAutoOrbit() {
    this.autoOrbit = !this.autoOrbit;
    this.engine.orbit.autoRotate = this.autoOrbit;
    $('#btn-orbit-auto')?.classList.toggle('is-active', this.autoOrbit);
    $('#btn-orbit-auto')?.setAttribute('aria-pressed', String(this.autoOrbit));
  }

  toggleOrtho() {
    const next = this.store.get('camera.type') === 'orthographic' ? 'perspective' : 'orthographic';
    this.store.set('camera.type', next);
    this.engine.initialCameraSet = true;
    this.engine.applyCamera();
    $('#chip-ortho')?.classList.toggle('is-active', next === 'orthographic');
    $('#chip-ortho')?.setAttribute('aria-pressed', String(next === 'orthographic'));
  }

  resetCamera() {
    this.store.set('camera.type', 'perspective');
    this.engine.initialCameraSet = true;
    this.engine.applyCamera();
    this.engine.setCameraPose(DEFAULT_CAMERA.position, DEFAULT_CAMERA.target);
    this.engine.persistCamera?.();
    $('#chip-ortho')?.classList.remove('is-active');
    $('#chip-ortho')?.setAttribute('aria-pressed', 'false');
  }

  setView(view) {
    const orbit = this.engine.orbit;
    const target = orbit.target.clone();
    const distance = Math.max(3, this.engine.camera.position.distanceTo(target));
    const poses = {
      iso: [1, 1, 1],
      top: [0, 1, 0.0001],
      front: [0, 0.12, 1],
      perspective: [0.72, 0.5, 1],
    };
    const dir = new THREE.Vector3(...(poses[view] || poses.perspective)).normalize();
    this.engine.camera.position.copy(target.clone().add(dir.multiplyScalar(distance)));
    orbit.update();
    this.engine.persistCamera?.();
    $$('[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  }

  renameProject() {
    const current = this.store.get('meta.name', 'Untitled Scene');
    const input = h('input.input', { type: 'text', value: current, 'data-autofocus': '' });
    const save = () => {
      const name = input.value.trim();
      if (!name) {
        input.value = current;
        input.focus();
        return;
      }
      this.store.set('meta.name', name);
      this.history.commit('Rename project');
      closeModal();
    };
    openModal({
      title: 'Rename project',
      body: h('div.u-col.u-gap-2', {}, h('span.prop-label', {}, 'Project name'), input),
      footer: [
        h('button.btn', { type: 'button', onClick: () => closeModal() }, 'Cancel'),
        h('button.btn.btn-primary', { type: 'button', onClick: save }, 'Save'),
      ],
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        save();
      }
    });
  }

  openFileMenu() {
    const rect = $('#btn-brand').getBoundingClientRect();
    this.showContextMenu(
      { clientX: rect.left, clientY: rect.bottom + 6, preventDefault() {} },
      [
        { label: 'New scene', icon: 'plus', action: () => this.newScene() },
        { label: 'Open project…', icon: 'upload', action: () => $('#project-input').click() },
        { label: 'Save project', icon: 'download', action: () => this.io.save() },
        { label: 'Save portable bundle…', icon: 'zip', action: () => this.io.saveBundle() },
        { label: '', separator: true },
        { label: 'Import files…', icon: 'upload', action: () => this.importPicker() },
        { label: 'Export…', icon: 'camera', action: () => exportDialog(this) },
        { label: '', separator: true },
        { label: 'Shortcuts', icon: 'info', action: () => shortcutsDialog(this) },
        { label: 'Welcome tour', icon: 'sparkle', action: () => welcomeDialog(this) },
        { label: 'Command palette…', icon: 'search', action: () => this.openCommandPalette() },
        { label: 'Clean unused assets', icon: 'trash', action: () => this.io.garbageCollect() },
      ],
    );
  }

  openCommandPalette() {
    const input = h('input.input', {
      type: 'search',
      placeholder: 'Search commands, actions and tools…',
      'aria-label': 'Search commands',
      'data-autofocus': '',
    });
    const results = h('div.command-list', { role: 'listbox', 'aria-label': 'Commands' });
    const modifier = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
    const commands = [
      { label: 'Save project', category: 'Project', shortcut: `${modifier} S`, icon: 'download', keywords: 'atlascene download', action: () => this.io.save() },
      { label: 'Save portable bundle', category: 'Project', icon: 'zip', keywords: 'atlaszip zip assets backup', action: () => this.io.saveBundle() },
      { label: 'Open project', category: 'Project', icon: 'upload', keywords: 'load atlascene atlaszip', action: () => $('#project-input').click() },
      { label: 'Import files', category: 'Project', shortcut: `${modifier} O`, icon: 'upload', keywords: 'model texture zip asset', action: () => this.importPicker() },
      { label: 'Export scene or screenshot', category: 'Project', shortcut: `${modifier} E`, icon: 'camera', keywords: 'glb png render', action: () => exportDialog(this) },
      { label: 'Add cube', category: 'Create', icon: 'cube', keywords: 'primitive box mesh', action: () => this.scene.addPrimitive('cube') },
      { label: 'Add sphere', category: 'Create', icon: 'cube', keywords: 'primitive ball mesh', action: () => this.scene.addPrimitive('sphere') },
      { label: 'Add empty group', category: 'Create', icon: 'group', keywords: 'parent folder', action: () => this.scene.addGroup() },
      { label: 'Group selection', category: 'Scene', icon: 'group', keywords: 'parent combine organize', action: () => this.scene.groupSelection() },
      { label: 'Ungroup selection', category: 'Scene', icon: 'group', keywords: 'ungroup separate parent', action: () => this.scene.ungroup() },
      { label: 'Add point light', category: 'Create', icon: 'light', keywords: 'lighting lamp', action: () => this.scene.addLight('point') },
      { label: 'Add billboard label', category: 'Create', icon: 'billboard', keywords: 'text annotation gui', action: () => this.scene.addBillboard({ text: 'Label' }) },
      { label: 'Duplicate selection', category: 'Scene', shortcut: `${modifier} D`, icon: 'copy', keywords: 'clone copy', action: () => this.scene.duplicate() },
      { label: 'Delete selection', category: 'Scene', icon: 'trash', keywords: 'remove erase', action: () => this.scene.delete() },
      { label: 'Frame selection', category: 'Viewport', shortcut: 'F', icon: 'frame', keywords: 'focus zoom camera', action: () => this.engine.frameSelection() },
      { label: 'Frame all objects', category: 'Viewport', shortcut: '⇧ F', icon: 'frame', keywords: 'focus zoom camera', action: () => this.engine.frameAll() },
      { label: 'Reset camera', category: 'Viewport', shortcut: `${modifier} 0`, icon: 'reset', keywords: 'home default view', action: () => this.resetCamera() },
      { label: 'Toggle theme', category: 'Workspace', shortcut: `${modifier} J`, icon: 'sparkle', keywords: 'dark light appearance', action: () => this.toggleTheme() },
      { label: 'Toggle touch mode', category: 'Workspace', icon: 'move', keywords: 'tablet ipad larger controls', action: () => this.toggleTouchMode() },
      { label: 'Toggle stats overlay', category: 'Workspace', shortcut: `${modifier} I`, icon: 'info', keywords: 'fps performance diagnostics', action: () => this.toggleStats() },
      { label: 'Toggle orthographic camera', category: 'Viewport', icon: 'camera', keywords: 'perspective parallel', action: () => this.toggleOrtho() },
      { label: 'Toggle grid', category: 'Viewport', icon: 'grid', keywords: 'floor lines', action: () => this.store.set('environment.showGrid', !this.store.get('environment.showGrid')) },
      { label: 'Toggle background', category: 'Viewport', icon: 'sparkle', keywords: 'environment backdrop', action: () => this.store.set('environment.showBackground', !this.store.get('environment.showBackground')) },
      { label: 'Open Assets panel', category: 'Workspace', icon: 'texture', keywords: 'library files', action: () => $('[data-left-tab="assets"]')?.click() },
      { label: 'Open Scene hierarchy', category: 'Workspace', icon: 'group', keywords: 'tree objects', action: () => $('[data-left-tab="scene"]')?.click() },
      { label: 'Open Materials panel', category: 'Workspace', icon: 'layers', keywords: 'shader surface', action: () => $('[data-left-tab="materials"]')?.click() },
      { label: 'Open Lighting controls', category: 'Workspace', icon: 'light', keywords: 'render illumination', action: () => $('[data-right-tab="lighting"]')?.click() },
      { label: 'Open Render settings', category: 'Workspace', icon: 'sparkle', keywords: 'effects quality', action: () => $('[data-right-tab="render"]')?.click() },
      { label: 'Open timeline', category: 'Workspace', icon: 'film', keywords: 'animation playback', action: () => $('[data-bottom-tab="timeline"]')?.click() },
      { label: 'Keyboard shortcuts', category: 'Help', shortcut: '?', icon: 'info', keywords: 'help guide', action: () => shortcutsDialog(this) },
    ];

    let filtered = [];
    let activeIndex = 0;
    const run = (command) => {
      if (!command) return;
      modal?.close();
      try {
        const result = command.action();
        result?.catch?.((error) => this.toast.error('Command failed', error.message));
      } catch (error) {
        this.toast.error('Command failed', error.message);
      }
    };
    const syncActive = () => {
      const buttons = results.querySelectorAll('.command-option');
      buttons.forEach((button, index) => {
        button.classList.toggle('is-active', index === activeIndex);
        button.setAttribute('aria-selected', String(index === activeIndex));
      });
      buttons[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };
    const renderResults = () => {
      const query = input.value.trim().toLowerCase();
      filtered = commands.filter((command) => (
        `${command.label} ${command.category} ${command.keywords || ''}`.toLowerCase().includes(query)
      ));
      activeIndex = 0;
      clear(results);
      if (!filtered.length) {
        results.appendChild(h('div.command-empty', {}, 'No commands match that search.'));
        return;
      }
      filtered.forEach((command, index) => {
        results.appendChild(h(
          `button.command-option${index === activeIndex ? '.is-active' : ''}`,
          {
            type: 'button',
            role: 'option',
            'aria-selected': String(index === activeIndex),
            onMouseEnter: () => { activeIndex = index; syncActive(); },
            onClick: () => run(command),
          },
          h('span.command-icon', {}, icon(command.icon, 15)),
          h('span.command-copy', {},
            h('span.command-label', {}, command.label),
            h('span.command-category', {}, command.category),
          ),
          command.shortcut ? h('kbd.command-shortcut', {}, command.shortcut) : null,
        ));
      });
    };

    input.addEventListener('input', renderResults);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && filtered.length) {
        event.preventDefault();
        activeIndex = (activeIndex + 1) % filtered.length;
        syncActive();
      } else if (event.key === 'ArrowUp' && filtered.length) {
        event.preventDefault();
        activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
        syncActive();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        run(filtered[activeIndex]);
      }
    });
    renderResults();
    const modal = openModal({
      title: 'Command palette',
      subtitle: 'Search and run an action',
      className: 'command-modal',
      body: h('div.command-palette', {},
        h('div.command-search', {}, icon('search', 14), input),
        results,
        h('div.command-hint', {}, '↑ ↓ to navigate · Enter to run · Esc to close'),
      ),
    });
    return modal;
  }

  async newScene() {
    const ok = await confirmModal({
      title: 'Start a new scene?',
      message: 'Your current scene will be replaced. Save it first if you want to keep it.',
      confirmLabel: 'New scene',
    });
    if (!ok) return;
    this.scene.reset();
    this.store.replace(createInitialState());
    this.history.reset();
    this.thumbCache.clear();
    this.engine.frameAll();
    this.applyUiState();
    this.left.panel.invalidate();
    this.right.panel.invalidate();
    this.dock.panel.invalidate();
    this.toast.success('New scene', 'A clean slate.');
  }

  /* ================================================================ */
  /* files                                                            */
  /* ================================================================ */

  importPicker({ accept = null, texturesOnly = false, target = null } = {}) {
    this._pickerAccept = accept;
    this._pickerTarget = target;
    this._pickerTexturesOnly = texturesOnly;
    const input = $('#file-input');
    input.value = '';
    input.accept = accept || (texturesOnly
      ? '.png,.jpg,.jpeg,.webp,.avif,.ktx2,.basis,.tga'
      : '.glb,.gltf,.fbx,.obj,.mtl,.stl,.ply,.dae,.3mf,.bin,.png,.jpg,.jpeg,.webp,.avif,.ktx2,.basis,.hdr,.exr,.tga,.zip,.atlaszip,.atlascene,.mp3,.ogg,.wav');
    input.click();
  }

  _bindFilePicker() {
    $('#file-input').addEventListener('change', async (event) => {
      const files = [...event.target.files];
      if (!files.length) return;
      const target = this._pickerTarget;
      if (target && files.length === 1) {
        await this.importer.assignTextureFile(target.materialId, target.slotId, files[0]);
        return;
      }
      if (this._pickerTexturesOnly) {
        await this.importer.ingestFiles(files);
        return;
      }
      await this.importer.ingestFiles(files);
    });
    $('#project-input').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (file) await this.io.openProjectFile(file);
    });
  }

  /* ================================================================ */
  /* drag & drop                                                      */
  /* ================================================================ */

  _bindDragAndDrop() {
    const viewport = $('#viewport');
    const overlay = $('#dropzone');
    let depth = 0;

    const show = () => {
      overlay.hidden = false;
    };
    const hide = () => {
      overlay.hidden = true;
      depth = 0;
    };

    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      depth += 1;
      if (event.target.closest('#viewport') || depth === 1) show();
    });
    window.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) hide();
    });
    window.addEventListener('drop', async (event) => {
      if (!event.dataTransfer?.files?.length) {
        hide();
        return;
      }
      event.preventDefault();
      hide();
      const files = [...event.dataTransfer.files];
      const items = event.dataTransfer.items ? [...event.dataTransfer.items] : [];
      // Prefer directory traversal when available (Chrome/Edge)
      const dirs = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory);
      if (dirs.length) {
        const collected = [];
        for (const item of items) {
          const entry = item.webkitGetAsEntry?.();
          if (entry) await walkEntry(entry, '', collected);
        }
        if (collected.length) {
          await this.importer.ingestFiles(collected.map((c) => c.file), { fromFolder: true });
          return;
        }
      }
      await this.importer.ingestFiles(files, { fromFolder: files.some((f) => f.webkitRelativePath) });
    });

    // Drop an asset card directly on the viewport → add at cursor
    viewport.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes('application/x-atlas-asset')) event.preventDefault();
    });
    viewport.addEventListener('drop', async (event) => {
      const payload = event.dataTransfer?.getData('application/x-atlas-asset');
      if (!payload) return;
      event.preventDefault();
      try {
        const { assetId } = JSON.parse(payload);
        const asset = this.store.get('assets', []).find((a) => a.id === assetId);
        if (asset) this.readdAsset(asset);
      } catch {
        /* ignore */
      }
    });
  }

  /* ================================================================ */
  /* keyboard                                                         */
  /* ================================================================ */

  _bindKeyboard() {
    this._keyHandler = (event) => {
      const tag = event.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable;
      const mod = event.metaKey || event.ctrlKey;

      if (event.key === 'Escape') {
        if (document.activeElement?.closest('.modal-root')) return;
        if (!typing) this.scene.select([]);
        return;
      }
      if (typing) return;

      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.openCommandPalette();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        shortcutsDialog(this);
        return;
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (event.shiftKey) exportDialog(this);
        else this.io.save();
        return;
      }
      if (mod && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        exportDialog(this);
        return;
      }
      if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        this.importPicker();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        this.scene.duplicate();
        return;
      }
      if (mod && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        this.toggleTheme();
        return;
      }
      if (mod && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        this.toggleStats();
        return;
      }
      if (mod && event.key === '0') {
        event.preventDefault();
        this.resetCamera();
        return;
      }
      switch (event.key.toLowerCase()) {
        case 'w':
          this.setGizmo('translate');
          break;
        case 'e':
          this.setGizmo('rotate');
          break;
        case 'r':
          this.setGizmo('scale');
          break;
        case 'x':
          this.engine.transform.setSpace(this.engine.transform.space === 'local' ? 'world' : 'local');
          break;
        case 'f':
          if (event.shiftKey) this.engine.frameAll();
          else this.engine.frameSelection();
          break;
        case 's':
          if (event.shiftKey) this.toggleSnap();
          break;
        case 'g':
          this.toggleAutoOrbit();
          break;
        case 'delete':
        case 'backspace':
          if (this.store.get('selection', []).length) {
            event.preventDefault();
            this.scene.delete();
          }
          break;
        case ' ':
          event.preventDefault();
          this.animation.toggle();
          break;
        case 'arrowleft':
          if (this.store.get('timeline.playing') === false) {
            this.animation.seek(Math.max(0, this.store.get('timeline.time', 0) - 1 / 30));
          }
          break;
        case 'arrowright':
          if (this.store.get('timeline.playing') === false) {
            this.animation.seek(this.store.get('timeline.time', 0) + 1 / 30);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', this._keyHandler);
  }

  setGizmo(mode) {
    this.store.set('ui.gizmoMode', mode);
    this.engine.transform.setMode(mode);
    $$('[data-gizmo]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.gizmo === mode);
      b.setAttribute('aria-pressed', String(b.dataset.gizmo === mode));
    });
  }

  _bindGlobalPointer() {
    document.addEventListener('pointerdown', (event) => {
      const menu = $('#context-menu');
      if (!menu.hidden && !event.target.closest('#context-menu') && !event.target.closest('.modal')) {
        menu.hidden = true;
      }
    });
    window.addEventListener('resize', () => {
      this.engine.resize();
      const menu = $('#context-menu');
      if (menu) menu.hidden = true;
    });
  }

  /* ================================================================ */
  /* context menu                                                     */
  /* ================================================================ */

  showContextMenu(event, items) {
    const menu = $('#context-menu');
    clear(menu);
    for (const item of items) {
      if (!item) continue;
      if (item.separator) {
        menu.appendChild(h('div.menu-sep'));
        continue;
      }
      menu.appendChild(
        h(
          `button.menu-item${item.danger ? '.is-danger' : ''}`,
          {
            type: 'button',
            role: 'menuitem',
            onClick: () => {
              menu.hidden = true;
              item.action?.();
            },
          },
          item.icon ? icon(item.icon, 13) : null,
          h('span', {}, item.label),
        ),
      );
    }
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const x = clamp(event.clientX, 6, window.innerWidth - rect.width - 6);
    const y = clamp(event.clientY, 6, window.innerHeight - rect.height - 6);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.querySelector('.menu-item')?.focus({ preventScroll: true });
  }

  /* ================================================================ */
  /* assets & materials                                               */
  /* ================================================================ */

  getThumbnail(key) {
    const value = this.thumbCache.get(key);
    if (value) {
      this.thumbCache.delete(key);
      this.thumbCache.set(key, value);
    }
    return value || null;
  }

  cacheThumbnail(key, value) {
    if (!value) return null;
    this.thumbCache.delete(key);
    this.thumbCache.set(key, value);
    while (this.thumbCache.size > this.thumbCacheLimit) {
      this.thumbCache.delete(this.thumbCache.keys().next().value);
    }
    return value;
  }

  texturePreview(asset) {
    const key = asset.blobId || asset.path || asset.name;
    const cached = this.getThumbnail(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.texturePreviewPending.get(key);
    if (pending) return pending;

    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    this.texturePreviewPending.set(key, promise);
    this.texturePreviewQueue.push({ asset, key, resolve });
    this.drainTexturePreviews();
    return promise;
  }

  async drainTexturePreviews() {
    if (this.texturePreviewActive) return;
    this.texturePreviewActive = true;
    try {
      while (this.texturePreviewQueue.length) {
        const item = this.texturePreviewQueue.shift();
        try {
          const url = await this.renderTexturePreview(item.asset);
          this.cacheThumbnail(item.key, url);
          item.resolve(url);
        } catch {
          item.resolve(null);
        } finally {
          this.texturePreviewPending.delete(item.key);
        }
        // Decode a single texture at a time and yield between large images.
        if (this.texturePreviewQueue.length) await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    } finally {
      this.texturePreviewActive = false;
    }
  }

  async renderTexturePreview(asset) {
    const blob = asset.blobId ? await blobs.get(asset.blobId) : null;
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return null;
    try {
      const size = 160;
      const canvas = document.createElement('canvas');
      const ratio = Math.min(size / bitmap.width, size / bitmap.height);
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally {
      bitmap.close?.();
    }
  }

  async readdAsset(asset) {
    const cached = this.scene.loadedObjects.get(asset.id);
    const materialIds = (asset.materials || []).map((m) => m.id);
    if (cached) {
      const clone = cached.clone(true);
      return this.scene.addAssetToScene({ asset, object: clone, animations: [], materialIds, frame: true });
    }
    const blob = await blobs.get(asset.blobId);
    if (!blob) {
      this.toast.error('Asset bytes missing', 'Re-import the file to restore it.');
      return null;
    }
    try {
      const result = await loadAsset({
        path: asset.path || asset.name,
        blob,
        format: asset.format || extensionOf(asset.path),
        renderer: this.engine.renderer,
      });
      this.rebindMaterials(result, { meta: { materialIds } });
      return this.scene.addAssetToScene({
        asset,
        object: result.object,
        animations: result.animations,
        materialIds,
        frame: true,
      });
    } catch (err) {
      this.toast.error('Could not add asset', err.message);
      return null;
    }
  }

  async rehydrateModel(node, group = null) {
    if (!node.assetId) return;
    const asset = this.store.get('assets', []).find((a) => a.id === node.assetId);
    if (!asset) return;
    if (this.scene.nodeObjects.has(node.id)) return;
    const blob = await blobs.get(asset.blobId);
    if (!blob) {
      this.log('warn', `Missing bytes for ${asset.name}`);
      return;
    }
    try {
      const file = new File([blob], basename(asset.path || asset.name));
      const result = await loadAsset({
        path: asset.path || asset.name,
        blob: file,
        format: asset.format || extensionOf(asset.path),
        renderer: this.engine.renderer,
      });
      // Rebind materials from the store
      this.rebindMaterials(result, node);
      this.scene.loadedObjects.set(asset.id, result.object);
      this.scene.nodeObjects.set(node.id, result.object);
      const target = group || this.engine.objectMap.get(node.id);
      if (target) {
        target.add(result.object);
        target.userData.built = true;
      }
      if (result.animations.length) {
        this.animation.register(node.id, result.object, result.animations);
        this.store.set('timeline.tracks', this.animation.deriveTracks());
      }
      this.engine.updateSelectionOutline();
    } catch (err) {
      this.log('error', `Could not restore ${asset.name}: ${err.message}`);
    }
  }

  /** Puts a node's live three.js object into its engine group. */
  attachNodeObject(group, node) {
    const object = this.scene.nodeObjects.get(node.id);
    if (object) {
      if (object.parent !== group) group.add(object);
      this.engine.updateSelectionOutline();
      return;
    }
    if (node.assetId) this.rehydrateModel(node, group);
  }

  /**
   * Maps an imported object's meshes onto the node's library materials.
   * Material order is deterministic for a given file (same traversal), so the
   * record's `importedIndex` is the reliable join key; we fall back to id
   * matching (for older projects) and finally to the first material.
   */
  rebindMaterials(result, node) {
    const ids = node.meta?.materialIds || [];
    if (!ids.length) return;
    const byImportedId = new Map();
    for (const recordId of ids) {
      const record = this.store.get(`materials.${recordId}`);
      if (!record) continue;
      const libMat = this.materials.build(record);
      if (typeof record.importedIndex === 'number') byImportedId.set(`#${record.importedIndex}`, libMat);
      if (record.importedName) byImportedId.set(`n:${record.importedName}`, libMat);
    }
    const fallback = byImportedId.get('#0') || [...byImportedId.values()][0];
    result.materials.forEach((imported, index) => {
      const libMat =
        byImportedId.get(`#${index}`) ||
        byImportedId.get(`n:${imported.name}`) ||
        fallback;
      if (!libMat) return;
      result.object.traverse((child) => {
        if (child.userData.materialId === imported.id) child.material = libMat;
      });
    });
  }

  removeAsset(assetId) {
    this.store.update('assets', (assets) => assets.filter((a) => a.id !== assetId));
    this.thumbCache.delete(assetId);
    this.history.commit('Remove asset');
    this.left.panel.invalidate();
  }

  setActiveMaterial(materialId) {
    this.store.set('ui.activeMaterial', materialId);
    this.store.set('ui.rightTab', 'inspector');
    $$('.side-tab[data-right-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.rightTab === 'inspector'));
    this.right.panel.invalidate();
  }

  pickTextureFor(materialId, slotId) {
    texturePickerDialog(this, {
      materialId,
      slotId,
      onPick: (tex) => this.assignAssetToSlot(tex.id, materialId, slotId),
    });
  }

  assignAssetToSlot(assetId, materialId, slotId) {
    const tex = this.store.get('assets', []).find((a) => a.id === assetId);
    const record = { ...this.store.get(`materials.${materialId}`) };
    if (!tex || !record) return;
    record.textures = { ...(record.textures || {}) };
    record.textures[slotId] = {
      blobId: tex.blobId,
      assetId: tex.id,
      name: tex.name,
      path: tex.path,
      repeat: [1, 1],
      offset: [0, 0],
      rotation: 0,
    };
    this.store.set(`materials.${materialId}`, record);
    const mat = this.materials.build(record);
    this.scene.refreshMaterial(materialId, mat);
    this.history.commit('Assign texture');
    this.right.panel.invalidate();
    this.toast.success('Texture applied', `${tex.name} → ${SLOT_BY_ID.get(slotId)?.label || slotId}`);
  }

  removeTexture(materialId, slotId) {
    const record = { ...this.store.get(`materials.${materialId}`) };
    if (!record?.textures?.[slotId]) return;
    record.textures = { ...record.textures };
    delete record.textures[slotId];
    this.store.set(`materials.${materialId}`, record);
    const mat = this.materials.build(record);
    this.scene.refreshMaterial(materialId, mat);
    this.history.commit('Remove texture');
    this.right.panel.invalidate();
  }

  textureTargetPrompt(asset) {
    const node = this.store.get('objects', []).find((o) => o.id === this.store.get('selection.0'));
    const materials = Object.values(this.store.get('materials', {}));
    if (!materials.length) {
      this.toast.info('No materials yet', 'Import a model first.');
      return;
    }
    let materialId = this.store.get('ui.activeMaterial') || node?.meta?.materialIds?.[0] || materials[0].id;
    const select = h('select.select', {
      onChange: (e) => { materialId = e.target.value; },
    }, materials.map((m) => h('option', { value: m.id, selected: m.id === materialId }, m.name)));
    const slotSelect = h('select.select', {}, Object.values(SLOT_BY_ID).filter((s) => !s.packed).map((s) => h('option', { value: s.id }, s.label)));

    openModal({
      title: 'Assign texture',
      subtitle: asset.name,
      body: h('div.u-col.u-gap-2', {},
        h('span.prop-label', {}, 'Material'), select,
        h('span.prop-label', {}, 'Slot'), slotSelect,
      ),
      footer: [
        h('button.btn', { type: 'button', onClick: () => closeModal() }, 'Cancel'),
        h('button.btn.btn-primary', {
          type: 'button',
          onClick: () => {
            this.assignAssetToSlot(asset.id, materialId, slotSelect.value);
            closeModal();
          },
        }, 'Apply'),
      ],
    });
  }

  autoBindMaterial(materialId) {
    const record = this.store.get(`materials.${materialId}`);
    if (!record) return;
    const textures = this.store.get('assets', []).filter((a) => a.kind === 'texture');
    if (!textures.length) {
      this.toast.info('No textures in the library', 'Import a texture pack or ZIP first.');
      return;
    }
    this.importer.runSmartMatch({
      nodeId: null,
      assetRecord: { id: materialId, path: record.name },
      materials: [{ id: materialId, name: record.name, meshNames: record.meshNames || [] }],
      textures,
      preview: true,
    });
  }

  applyHdri(asset) {
    this.toast.info('Environment HDRI', `${asset.name} — applying as background radiance.`);
    blobs.get(asset.blobId).then(async (blob) => {
      if (!blob) return;
      try {
        const texture = await loadTextureBlob({ path: asset.path || `${asset.name}.hdr`, blob, renderer: this.engine.renderer });
        this.engine.scene.background = texture;
        this.engine.scene.environment = texture;
        this.log('success', `Environment set to ${asset.name}`);
      } catch (err) {
        this.log('error', `HDRI failed: ${err.message}`);
      }
    });
  }

  previewAudio(asset) {
    if (this.audioEl) {
      this.audioEl.pause();
      URL.revokeObjectURL(this.audioEl.src);
    }
    blobs.get(asset.blobId).then((blob) => {
      if (!blob) return;
      this.audioEl = new Audio(URL.createObjectURL(blob));
      this.audioEl.volume = 0.7;
      this.audioEl.play().catch(() => {});
      this.toast.info('Previewing audio', asset.name);
    });
  }

  /* ================================================================ */
  /* shaders                                                          */
  /* ================================================================ */

  openShaderLab({ shaderId = null, fresh = false, fullscreen = false } = {}) {
    void fullscreen;
    shaderLabDialog(this, { shaderId, fresh });
  }

  newShaderFrom(fragment, patch = {}) {
    const record = {
      id: uid('shader'),
      name: patch.name || `Effect ${this.store.get('lighting.customShaders', []).length + 1}`,
      fragment,
      vertex: patch.vertex || null,
      uniforms: patch.uniforms || { uColor: { type: 'color', value: '#7c8bff', label: 'Color' } },
      blending: patch.blending || 'normal',
      transparent: patch.transparent ?? true,
      depthWrite: patch.depthWrite ?? false,
      revision: 0,
      createdAt: Date.now(),
    };
    this.store.update('lighting.customShaders', (list) => [...(list || []), record]);
    this.uiState.shaderId = record.id;
    this.log('success', `Created shader "${record.name}"`);
    this.toast.success('Shader saved', record.name);
    this.emit('shader:changed');
    this.dock.panel.invalidate();
    this.right.panel.invalidate();
    return record;
  }

  updateShader(id, patch) {
    this.store.update('lighting.customShaders', (list) =>
      (list || []).map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
    this.vfx.sync();
    this.emit('shader:changed');
    this.dock.panel.invalidate();
    this.right.panel.invalidate();
    this.log('success', `Shader "${this.store.get('lighting.customShaders', []).find((s) => s.id === id)?.name}" updated`);
  }

  addPresetVfx(presetId) {
    const preset = PRESET_BY_ID.get(presetId) || SHADER_PRESETS[0];
    const record = this.newShaderFrom(preset.fragment, {
      name: preset.name,
      uniforms: uniformsFromPreset(preset),
      blending: preset.blend,
      transparent: preset.transparent,
    });
    this.addVfxNode(record.id);
  }

  addVfxNode(shaderId) {
    const record = this.store.get('lighting.customShaders', []).find((s) => s.id === shaderId);
    if (!record) return;
    const node = {
      id: uid('obj'),
      name: record.name,
      kind: 'vfx',
      parentId: null,
      visible: true,
      locked: false,
      position: [0, 1.6, 0],
      rotation: [-Math.PI / 2, 0, 0],
      scale: [1, 1, 1],
      vfx: { shaderId, geometry: 'plane', segments: 32, scale: 2.6, billboard: false, opacity: 1, uniforms: {} },
    };
    this.store.batch(() => {
      this.store.push('objects', node);
      this.store.set('selection', [node.id]);
    });
    this.engine.syncFromStore();
    this.vfx.sync();
    this.scene.select([node.id]);
    this.history.commit('Add VFX');
    this.toast.success('Effect added', record.name);
  }

  /* ================================================================ */
  /* looks & templates                                                */
  /* ================================================================ */

  looks() {
    return {
      product: {
        name: 'Product',
        description: 'Softbox key + contact shadow',
        swatch: 'linear-gradient(135deg,#f6f7fb,#b8c4d8)',
        apply: (app) => {
          app.applyLightPreset('softbox');
          app.store.patch({
            environment: { theme: 'paper', showGrid: false, contactShadows: true },
            render: { toneMapping: 'Neutral', exposure: 1.05, bloom: { ...app.store.get('render.bloom'), enabled: false } },
          });
        },
      },
      cinematic: {
        name: 'Cinematic',
        description: 'Teal shadows, warm highlights, bloom',
        swatch: 'linear-gradient(135deg,#0b2e3a,#f0a55a)',
        apply: (app) => {
          app.applyLightPreset('dramatic');
          app.store.patch({
            environment: { theme: 'night' },
            render: {
              toneMapping: 'ACESFilmic',
              exposure: 1.15,
              bloom: { enabled: true, strength: 0.7, radius: 0.6, threshold: 0.72 },
              vignette: { enabled: true, amount: 0.42, softness: 0.62 },
            },
          });
        },
      },
      anime: {
        name: 'Anime',
        description: 'Bright flat lighting, soft bloom',
        swatch: 'linear-gradient(135deg,#8ff0ff,#ffb3e6)',
        apply: (app) => {
          app.applyLightPreset('neutral');
          app.store.patch({
            environment: { theme: 'dawn', showGrid: false },
            render: { toneMapping: 'Neutral', exposure: 1.2, bloom: { enabled: true, strength: 0.35, radius: 0.7, threshold: 0.9 } },
          });
        },
      },
      noir: {
        name: 'Noir',
        description: 'Hard key, deep shadows, grain',
        swatch: 'linear-gradient(135deg,#0a0a0a,#9aa0a6)',
        apply: (app) => {
          app.applyLightPreset('dramatic');
          app.store.patch({
            environment: { theme: 'studio', showGrid: false, ambientIntensity: 0.18 },
            render: {
              toneMapping: 'Cineon',
              exposure: 1,
              film: { enabled: true, grain: 0.24, scanlines: 0.02, contrast: 1.12, saturation: 0.15 },
              vignette: { enabled: true, amount: 0.5, softness: 0.55 },
            },
          });
        },
      },
    };
  }

  applyLook(id) {
    const look = this.looks()[id];
    if (!look) return;
    look.apply(this);
    this.history.commit(`Look · ${look.name}`);
    this.toast.success(`${look.name} look applied`);
    this.right.panel.invalidate();
  }

  applyLightPreset(id) {
    const preset = LIGHT_PRESETS[id];
    if (!preset) return;
    this.store.patch({
      environment: {
        keyColor: preset.key.color,
        keyIntensity: preset.key.intensity,
        fillColor: preset.fill.color,
        fillIntensity: preset.fill.intensity,
        rimColor: preset.rim.color,
        rimIntensity: preset.rim.intensity,
      },
    });
    this.history.commit('Light preset');
  }

  /* ================================================================ */
  /* selection helpers                                                */
  /* ================================================================ */

  alignSelection(axis) {
    const ids = this.store.get('selection', []);
    if (ids.length < 2) return;
    const objects = this.store.get('objects', []);
    const nodes = ids.map((id) => objects.find((o) => o.id === id)).filter(Boolean);
    const avg = nodes.reduce((sum, n) => sum + n.position['xyz'.indexOf(axis)], 0) / nodes.length;
    this.store.update('objects', (list) =>
      list.map((o) => {
        if (!ids.includes(o.id)) return o;
        const position = [...o.position];
        position['xyz'.indexOf(axis)] = avg;
        return { ...o, position };
      }),
    );
    this.engine.syncTransforms();
    this.history.commit('Align');
  }

  distributeSelection(axis) {
    const ids = this.store.get('selection', []);
    if (ids.length < 3) return;
    const objects = this.store.get('objects', []);
    const index = 'xyz'.indexOf(axis);
    const nodes = ids
      .map((id) => objects.find((o) => o.id === id))
      .filter(Boolean)
      .sort((a, b) => a.position[index] - b.position[index]);
    const min = nodes[0].position[index];
    const max = nodes[nodes.length - 1].position[index];
    const step = (max - min) / (nodes.length - 1);
    const map = new Map(nodes.map((n, i) => [n.id, min + step * i]));
    this.store.update('objects', (list) =>
      list.map((o) => {
        if (!map.has(o.id)) return o;
        const position = [...o.position];
        position[index] = map.get(o.id);
        return { ...o, position };
      }),
    );
    this.engine.syncTransforms();
    this.history.commit('Distribute');
  }

  groupSelection() {
    this.toast.info('Groups', 'Parent objects in the scene tree by dragging one onto another.');
  }

  eyedropper() {
    this.toast.info('Eyedropper', 'Hover the viewport and click to sample a colour (coming from the colour field picker).');
  }

  captureTurntable() {
    this.shots.downloadTurntable({ frames: 4, size: 1080 }).then((files) => {
      files.forEach((file, i) => {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        setTimeout(() => {
          a.click();
          URL.revokeObjectURL(url);
        }, i * 350);
      });
      this.toast.success('Turntable captured', `${files.length} angles`);
    }).catch((err) => this.toast.error('Turntable failed', err.message));
  }

  /* ================================================================ */
  /* samples                                                          */
  /* ================================================================ */

  loadSampleScene() {
    // A small, hand-built showcase — no network needed, no giant backdrop plane
    // that would swallow the frame.
    this.scene.reset();
    this.store.replace(createInitialState());
    this.history.reset();

    const pedestal = this.scene.addPrimitive('cylinder');
    this.scene.rename(pedestal.id, 'Pedestal');
    this.scene.setTransform(pedestal.id, { position: [0, 0.28, 0], scale: [1.5, 0.56, 1.5] });

    const hero = this.scene.addPrimitive('torus');
    this.scene.rename(hero.id, 'Hero Ring');
    this.scene.setTransform(hero.id, { position: [0, 1.38, 0], rotation: [Math.PI / 2.2, 0.35, 0], scale: [1.45, 1.45, 1.45] });

    const plinth = this.scene.addPrimitive('cube');
    this.scene.rename(plinth.id, 'Plinth');
    this.scene.setTransform(plinth.id, { position: [1.55, 0.14, 0.35], rotation: [0, 0.4, 0], scale: [0.5, 0.28, 0.5] });

    const objects = this.store.get('objects', []);
    const matIdFor = (name) => objects.find((o) => o.name === name)?.material;

    const heroMat = matIdFor('Hero Ring');
    if (heroMat) {
      this.store.set(`materials.${heroMat}`, {
        ...this.store.get(`materials.${heroMat}`),
        name: 'Brushed Gold',
        baseColor: '#e6b264',
        metalness: 1,
        roughness: 0.18,
        emissive: '#ff9d3d',
        emissiveIntensity: 0.12,
      });
      this.materials.build(this.store.get(`materials.${heroMat}`));
    }

    const pedMat = matIdFor('Pedestal');
    if (pedMat) {
      this.store.set(`materials.${pedMat}`, {
        ...this.store.get(`materials.${pedMat}`),
        name: 'Slate',
        baseColor: '#2a3550',
        metalness: 0.28,
        roughness: 0.52,
      });
      this.materials.build(this.store.get(`materials.${pedMat}`));
    }

    const plinthMat = matIdFor('Plinth');
    if (plinthMat) {
      this.store.set(`materials.${plinthMat}`, {
        ...this.store.get(`materials.${plinthMat}`),
        name: 'Warm Stone',
        baseColor: '#d8cbb4',
        metalness: 0.02,
        roughness: 0.78,
      });
      this.materials.build(this.store.get(`materials.${plinthMat}`));
    }

    this.scene.addBillboard({ text: 'Hero Ring', targetNodeId: hero.id, style: 'chip' });

    this.store.patch({
      environment: { theme: 'night', showGrid: true, ambientIntensity: 0.42, keyIntensity: 2.2 },
      render: { bloom: { enabled: true, strength: 0.34, radius: 0.55, threshold: 0.86 } },
    });

    this.engine.syncFromStore();
    this.store.set('ui.rightTab', 'inspector');
    this.engine.frameAll();
    this.scene.select([hero.id]);
    this.applyUiState();
    this.left.panel.invalidate();
    this.right.panel.invalidate();
    this.updateStatusBar();
    this.updateEmptyState();
    this.toast.success('Sample scene loaded', 'Try dragging the gold ring, or open the Shader Lab.');
  }
}

/* ------------------------------------------------------------------ */
/* directory traversal for folder drops                               */
/* ------------------------------------------------------------------ */

async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: `${prefix}${file.name}` });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const readBatch = () =>
      new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
    let batch = await readBatch();
    while (batch.length) {
      for (const child of batch) {
        await walkEntry(child, `${prefix}${entry.name}/`, out);
      }
      batch = await readBatch();
    }
  }
}

export { GRID_ENV_THEMES, MATERIAL_DEFAULTS };
