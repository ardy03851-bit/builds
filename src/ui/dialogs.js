/**
 * Modal workflows: ZIP review, smart-match review, shader lab, export,
 * shortcuts, texture picker, welcome.
 */
import {
  h, icon, prop, slider, colorField, toggleSwitch, toggleRow, selectField, segmented,
  emptyHint, textInput, checkbox,
} from './dom.js';
import { openModal, closeModal, confirmModal } from './modal.js';
import { formatBytes, formatNumber, clamp, slug } from '../core/util.js';
import { SLOT_BY_ID, SLOTS, SLOT_PRIORITY } from '../core/slots.js';
import { basename, stem } from '../core/paths.js';
import {
  SHADER_PRESETS, validateShader, PRESET_BY_ID, uniformsFromPreset,
} from '../core/shaderlib.js';
import { ASPECT_PRESETS, sizeForPreset, triggerDownload, stamp } from '../app/shots.js';

/* ================================================================== */
/* ZIP review                                                         */
/* ================================================================== */

export function zipReviewDialog(app, plan, reader, file) {
  return new Promise((resolve) => {
    const selectedModels = new Set(plan.models.map((m) => m.path));
    const selectedTextures = new Set(plan.textures.map((t) => t.path));
    let smartMatch = true;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      closeModal({ silent: true });
    };

    const modelList = h('div.u-col', { style: { gap: '2px', maxHeight: '210px', overflow: 'auto' } });
    const paintModels = () => {
      modelList.replaceChildren(
        ...plan.models.map((model) =>
          h('label.u-row.u-gap-2', { style: { padding: '4px 6px', borderRadius: '6px', cursor: 'pointer' } },
            checkbox({
              checked: selectedModels.has(model.path),
              onChange: (checked) => {
                if (checked) selectedModels.add(model.path);
                else selectedModels.delete(model.path);
                updateCounts();
              },
            }),
            h('span', { style: { opacity: 0.6 } }, icon('cube', 13)),
            h('span.u-grow.u-truncate', { title: model.path }, basename(model.path)),
            h('span.u-muted', { style: { fontSize: '10px' } }, `${model.texturePaths?.length || 0} textures`),
          ),
        ),
      );
      if (!plan.models.length) modelList.appendChild(emptyHint('No 3D models in this archive.', 'cube'));
    };

    const textureList = h('div.u-col', { style: { gap: '2px', maxHeight: '210px', overflow: 'auto' } });
    const paintTextures = () => {
      textureList.replaceChildren(
        ...plan.textures.map((tex) =>
          h('label.u-row.u-gap-2', { style: { padding: '4px 6px', borderRadius: '6px', cursor: 'pointer' } },
            checkbox({
              checked: selectedTextures.has(tex.path),
              onChange: (checked) => {
                if (checked) selectedTextures.add(tex.path);
                else selectedTextures.delete(tex.path);
                updateCounts();
              },
            }),
            h('span', { style: { opacity: 0.6 } }, icon('texture', 13)),
            h('span.u-grow.u-truncate', { title: tex.path }, basename(tex.path)),
            tex.owner ? h('span.badge.badge-accent', { title: `Auto-paired with ${tex.owner}` }, stem(basename(tex.owner))) : h('span.badge.badge-ghost', {}, 'loose'),
          ),
        ),
      );
      if (!plan.textures.length) textureList.appendChild(emptyHint('No textures in this archive.', 'texture'));
    };

    const countEl = h('span.badge.badge-accent', {});
    const updateCounts = () => {
      countEl.textContent = `${selectedModels.size} models · ${selectedTextures.size} textures`;
    };

    paintModels();
    paintTextures();
    updateCounts();

    const smartToggle = h('button.switch', {
      type: 'button',
      role: 'switch',
      ariaChecked: 'true',
      onClick: (e) => {
        const next = e.currentTarget.getAttribute('aria-checked') !== 'true';
        e.currentTarget.setAttribute('aria-checked', String(next));
        smartMatch = next;
      },
    });

    const body = h(
      'div.u-col.u-gap-3',
      {},
      h('div.u-row.u-gap-2', {},
        h('span.badge.badge-accent', {}, icon('zip', 11), basename(file.name)),
        h('span.u-muted', { style: { fontSize: '11px' } }, `${formatBytes(plan.stats.estimatedBytes)} · ${plan.stats.files} files`),
        h('div.u-grow'),
        countEl,
      ),
      plan.notes.length ? h('div.u-col.u-gap-1', {},
        plan.notes.map((note) => h('div.u-row.u-gap-1', { style: { fontSize: '11px', color: 'var(--fg-muted)' } }, icon('info', 12), h('span', {}, note))),
      ) : null,
      plan.skipped.length ? h('div.u-row.u-gap-1', { style: { fontSize: '11px', color: 'var(--fg-subtle)' } },
        icon('warn', 12), h('span', {}, `${plan.skipped.length} files skipped (system files, unsupported types)`),
      ) : null,
      h('div.u-col.u-gap-1', {}, h('div.panel-title', {}, 'Models'), modelList),
      h('div.u-col.u-gap-1', {}, h('div.panel-title', {}, 'Textures'), textureList),
      h('div.prop-inline', { style: { padding: '10px', border: '1px solid var(--border-muted)', borderRadius: '8px', background: 'var(--bg-hover)' } },
        h('div.u-col', { style: { gap: '1px' } },
          h('div', { style: { fontSize: '12px', fontWeight: 600 } }, 'Smart texture matching'),
          h('div.u-muted', { style: { fontSize: '11px' } }, 'Run the name/folder/slot detector and let you review before applying.'),
        ),
        smartToggle,
      ),
    );

    openModal({
      title: 'Archive ready',
      subtitle: `${plan.stats.models} models · ${plan.stats.textures} textures — everything stays read straight from the ZIP`,
      wide: true,
      body,
      footer: [
        h('button.btn', { type: 'button', onClick: () => finish(null) }, 'Cancel'),
        h('button.btn', {
          type: 'button',
          onClick: () => {
            plan.models.forEach((m) => selectedModels.add(m.path));
            plan.textures.forEach((t) => selectedTextures.add(t.path));
            paintModels();
            paintTextures();
            updateCounts();
          },
        }, 'Select all'),
        h('button.btn.btn-primary', {
          type: 'button',
          onClick: () =>
            finish({
              importModels: selectedModels.size > 0,
              importTextures: selectedTextures.size > 0,
              modelPaths: [...selectedModels],
              texturePaths: [...selectedTextures],
              smartMatch,
            }),
        }, icon('download', 13), 'Import selected'),
      ],
      onClose: () => finish(null),
    });
    void reader;
  });
}

/* ================================================================== */
/* Smart-match review                                                 */
/* ================================================================== */

export function matchReviewDialog(app, { assetRecord, result, textures, materials, modelPath }) {
  return new Promise((resolve) => {
    const accepted = new Set();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      closeModal({ silent: true });
    };

    const textureById = new Map(textures.map((t) => [t.id, t]));
    const materialById = new Map(materials.map((m) => [m.id, m]));

    const rows = result.assignments.map((assignment) => {
      accepted.add(assignment.textureId);
      const texture = textureById.get(assignment.textureId);
      const material = materialById.get(assignment.materialId);
      const slot = SLOT_BY_ID.get(assignment.slot);
      const confClass = assignment.confidence >= 70 ? 'conf-high' : assignment.confidence >= 45 ? 'conf-med' : 'conf-low';

      return h('div.match-row', {},
        h('div.u-col', { style: { gap: '1px', minWidth: 0 } },
          h('span.u-truncate', { title: assignment.texturePath }, texture?.name || basename(assignment.texturePath)),
          h('span.u-muted', { style: { fontSize: '10px' } }, `${slot?.label || assignment.slot}${assignment.inverted ? ' (inverted gloss)' : ''}${assignment.udim ? ` · UDIM ${assignment.udim.tile}` : ''}`),
        ),
        h('div.u-col', { style: { gap: '2px', alignItems: 'center' } },
          h('span.arrow', {}, '→'),
          h(`span.confidence.${confClass}`, {}, h('span.confidence-bar', {}, h('i', { style: { width: `${assignment.confidence}%` } })), `${assignment.confidence}%`),
        ),
        h('div.u-col', { style: { gap: '1px', minWidth: 0 } },
          h('span.u-truncate', { title: material?.name }, material?.name || assignment.materialId),
          h('span.u-muted', { style: { fontSize: '10px' } }, assignment.reason),
        ),
      );
    });

    const unassignedCount = result.unassigned.length;

    openModal({
      title: 'Smart texture match',
      subtitle: `${basename(modelPath)} — ${result.assignments.length} textures matched`,
      wide: true,
      body: h('div.u-col.u-gap-3', {},
        h('p.u-muted', { style: { margin: 0, fontSize: '12px' } },
          'We compared material names, mesh names, folders and map-type keywords. Everything below is applied to the model when you confirm — and stays undoable.',
        ),
        rows.length ? h('div.match-list', {}, rows) : emptyHint('No confident matches found. You can still assign textures by hand.', 'warn'),
        unassignedCount ? h('div.u-muted', { style: { fontSize: '11px' } },
          `${unassignedCount} texture${unassignedCount > 1 ? 's' : ''} had no confident match and stay in the library.`,
        ) : null,
      ),
      footer: [
        h('button.btn', { type: 'button', onClick: () => finish(null) }, 'Skip'),
        h('button.btn.btn-primary', {
          type: 'button',
          disabled: !rows.length,
          onClick: () => finish(result.assignments),
        }, icon('check', 13), `Apply ${result.assignments.length}`),
      ],
      onClose: () => finish(null),
    });
  });
}

/* ================================================================== */
/* Export                                                             */
/* ================================================================== */

export function exportDialog(app) {
  let format = 'png';
  let width = app.store.get('shot.width', 1920);
  let height = app.store.get('shot.height', 1080);
  let scale = 1;
  let transparent = false;
  let frame = true;
  let watermark = app.store.get('shot.watermark', '');
  let exportGLB = false;

  const previewEl = h('div.shot-preview', { style: { minHeight: '180px' } }, emptyHint('Press “Render preview” to see the shot.', 'camera'));
  const infoEl = h('span.u-muted', { style: { fontSize: '11px' } }, '');

  const api = openModal({
    title: 'Export',
    subtitle: 'Screenshots, project files and 3D output',
    wide: true,
    body: h('div.u-col.u-gap-3', {},
      h('div.u-col.u-gap-1', {},
        h('div.panel-title', {}, 'Screenshot'),
        h('div.u-row.u-gap-2', { style: { flexWrap: 'wrap' } },
          h('div.u-col.u-gap-1', { style: { flex: '1 1 120px' } },
            h('span.prop-label', {}, 'Width'),
            h('input.input', { type: 'number', min: 16, max: 8192, value: width, onChange: (e) => { width = clamp(Number(e.target.value) || 1920, 16, 8192); } }),
          ),
          h('div.u-col.u-gap-1', { style: { flex: '1 1 120px' } },
            h('span.prop-label', {}, 'Height'),
            h('input.input', { type: 'number', min: 16, max: 8192, value: height, onChange: (e) => { height = clamp(Number(e.target.value) || 1080, 16, 8192); } }),
          ),
          h('div.u-col.u-gap-1', { style: { flex: '0 0 110px' } },
            h('span.prop-label', {}, 'Format'),
            selectField({ value: format, options: ['png', 'jpeg', 'webp'], onChange: (v) => { format = v; } }),
          ),
          h('div.u-col.u-gap-1', { style: { flex: '0 0 110px' } },
            h('span.prop-label', {}, 'Supersample'),
            selectField({ value: String(scale), options: ['1', '2', '4'], onChange: (v) => { scale = Number(v); } }),
          ),
        ),
        h('div.aspect-chips', {}, ASPECT_PRESETS.filter((p) => p.id !== 'custom').map((preset) =>
          h('button.aspect-chip', {
            type: 'button',
            onClick: () => {
              const size = sizeForPreset(preset.id, 1920);
              width = size.width;
              height = size.height;
              app.ui.refreshModal?.();
              api.close();
              exportDialog(app);
            },
          }, preset.label),
        )),
        h('div.u-row.u-gap-3', { style: { flexWrap: 'wrap', marginTop: '4px' } },
          h('label.check', {}, h('input', { type: 'checkbox', checked: transparent, onChange: (e) => { transparent = e.target.checked; } }), 'Transparent background'),
          h('label.check', {}, h('input', { type: 'checkbox', checked: frame, onChange: (e) => { frame = e.target.checked; } }), 'Frame & matte'),
        ),
        h('div.u-col.u-gap-1', {},
          h('span.prop-label', {}, 'Watermark'),
          h('input.input', { type: 'text', placeholder: 'e.g. studio.atlas', value: watermark, onInput: (e) => { watermark = e.target.value; } }),
        ),
      ),
      h('div.u-row.u-gap-2', {},
        h('button.btn', {
          type: 'button',
          onClick: async () => {
            previewEl.replaceChildren(emptyHint('Rendering…', 'camera'));
            const shot = await app.shots.capture({ width: 960, height: Math.round((960 * height) / width), scale: 0.5, format: 'png', transparent, frame, watermark });
            const url = URL.createObjectURL(shot.blob);
            previewEl.replaceChildren(h('img', { src: url, alt: 'Shot preview' }));
            infoEl.textContent = `${shot.width}×${shot.height}`;
          },
        }, icon('camera', 13), 'Render preview'),
        h('button.btn.btn-shine', {
          type: 'button',
          onClick: async () => {
            const shot = await app.shots.capture({ width, height, scale, format, transparent, frame, watermark });
            const ext = format === 'jpeg' ? 'jpg' : format;
            triggerDownload(shot.blob, `${slug(app.store.get('meta.name', 'scene'))}-${stamp()}.${ext}`);
            app.toast.success('Screenshot saved', `${width}×${height} · ${format.toUpperCase()}`);
          },
        }, icon('download', 13), 'Save screenshot'),
        h('button.btn', {
          type: 'button',
          onClick: async () => {
            const files = await app.shots.downloadTurntable({ frames: 4, size: 1080 });
            files.forEach((file, index) => setTimeout(() => triggerDownload(file, file.name), index * 400));
            app.toast.info('Turntable queued', `${files.length} angles`);
          },
        }, icon('rotate', 13), '4-angle turntable'),
      ),
      previewEl,
      infoEl,
      h('div.u-col.u-gap-1', { style: { marginTop: '4px' } },
        h('div.panel-title', {}, 'Scene files'),
        h('div.u-row.u-gap-2', { style: { flexWrap: 'wrap' } },
          h('button.btn', { type: 'button', onClick: () => app.io.save() }, icon('download', 13), 'Project (.atlascene)'),
          h('button.btn', { type: 'button', onClick: () => app.io.exportManifest() }, icon('download', 13), 'Manifest JSON'),
          h('label.check', {}, h('input', { type: 'checkbox', checked: exportGLB, onChange: (e) => { exportGLB = e.target.checked; } }), 'also export GLB'),
        ),
      ),
    ),
    footer: [
      h('button.btn', { type: 'button', onClick: () => closeModal() }, 'Close'),
      h('button.btn.btn-primary', {
        type: 'button',
        onClick: async () => {
          if (exportGLB) {
            try {
              const blob = await app.scene.exportGLB();
              triggerDownload(blob, `${slug(app.store.get('meta.name', 'scene'))}.glb`);
              app.toast.success('GLB exported', formatBytes(blob.size));
            } catch (err) {
              app.toast.error('GLB export failed', err.message);
            }
          }
          closeModal();
        },
      }, icon('download', 13), 'Done'),
    ],
  });
}

/* ================================================================== */
/* Shader lab                                                         */
/* ================================================================== */

export function shaderLabDialog(app, { shaderId = null, fresh = false } = {}) {
  const records = app.store.get('lighting.customShaders', []);
  const existing = records.find((r) => r.id === shaderId) || null;
  const preset = SHADER_PRESETS[0];

  const state = {
    name: existing?.name || (fresh ? 'My Effect' : preset.name),
    fragment: existing?.fragment || preset.fragment,
    vertex: existing?.vertex || '',
    uniforms: existing?.uniforms ? { ...existing.uniforms } : uniformsFromPreset(preset),
    blending: existing?.blending || preset.blend || 'normal',
    transparent: existing?.transparent ?? true,
    depthWrite: existing?.depthWrite ?? false,
  };

  const statusEl = h('div.code-status', { dataset: { state: 'ok' } }, 'Ready');
  const uniformList = h('div.u-col.u-gap-2');

  const gutter = h('div.code-gutter');
  const textarea = h('textarea.code-input', {
    spellcheck: false,
    value: state.fragment,
    onInput: (e) => {
      state.fragment = e.target.value;
      paintGutter();
      validate();
    },
    onScroll: (e) => { gutter.scrollTop = e.target.scrollTop; },
  });

  const paintGutter = () => {
    gutter.textContent = state.fragment.split('\n').map((_, i) => String(i + 1)).join('\n');
  };

  const validate = () => {
    const result = validateShader(state.fragment, { uniforms: state.uniforms });
    statusEl.dataset.state = result.ok ? (result.warnings.length ? 'warn' : 'ok') : 'error';
    statusEl.replaceChildren(
      icon(result.ok ? 'check' : 'error', 12),
      h('span', { style: { flex: '1 1 auto' } }, result.ok ? `Valid · ${result.warnings.length} warnings` : result.problems.join(' · ')),
    );
    saveBtn.disabled = !result.ok;
    return result;
  };

  const paintUniforms = () => {
    uniformList.replaceChildren(
      ...Object.entries(state.uniforms).map(([name, def]) =>
        h('div.u-row.u-gap-1', { style: { padding: '2px 0' } },
          h('span.u-mono', { style: { fontSize: '10.5px', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
          def.type === 'color'
            ? colorField({ value: def.value, onChange: (v) => { def.value = v; validate(); } })
            : h('input.input', {
                type: 'range',
                style: { width: '90px', height: '22px' },
                min: def.min ?? 0,
                max: def.max ?? 1,
                step: def.step ?? 0.01,
                value: def.value,
                onInput: (e) => { def.value = Number(e.target.value); },
              }),
        ),
      ),
      h('button.btn', {
        type: 'button',
        style: { height: '24px', fontSize: '11px' },
        onClick: () => {
          const name = prompt('Uniform name (camelCase, e.g. uGlow)');
          if (!name) return;
          const clean = name.startsWith('u') ? name : `u${name[0].toUpperCase()}${name.slice(1)}`;
          state.uniforms[clean] = { type: 'float', value: 0.5, min: 0, max: 1, label: clean };
          paintUniforms();
          validate();
        },
      }, icon('plus', 11), 'Add uniform'),
    );
  };

  const saveBtn = h('button.btn.btn-primary', {
    type: 'button',
    onClick: () => {
      const payload = {
        name: state.name,
        fragment: state.fragment,
        vertex: state.vertex || undefined,
        uniforms: state.uniforms,
        blending: state.blending,
        transparent: state.transparent,
        depthWrite: state.depthWrite,
      };
      if (existing) app.updateShader(existing.id, { ...payload, revision: (existing.revision || 0) + 1 });
      else app.newShaderFrom(state.fragment, payload);
      closeModal();
    },
  }, icon('check', 13), existing ? 'Save shader' : 'Create effect');

  paintGutter();
  paintUniforms();
  validate();

  openModal({
    title: existing ? `Shader · ${existing.name}` : 'Shader Lab',
    subtitle: 'Write GLSL for the fragment stage. uTime and vUv are always available.',
    wide: true,
    body: h('div.u-col.u-gap-2', { style: { minHeight: '420px' } },
      h('div.u-row.u-gap-2', {},
        h('input.input', { type: 'text', value: state.name, onInput: (e) => { state.name = e.target.value; }, style: { flex: '1 1 auto' } }),
        selectField({
          value: state.blending,
          options: ['normal', 'additive', 'subtractive', 'multiply'],
          onChange: (v) => { state.blending = v; },
        }),
      ),
      h('div.u-row.u-gap-2', { style: { flexWrap: 'wrap' } },
        h('label.check', {}, h('input', { type: 'checkbox', checked: state.transparent, onChange: (e) => { state.transparent = e.target.checked; } }), 'Transparent'),
        h('label.check', {}, h('input', { type: 'checkbox', checked: state.depthWrite, onChange: (e) => { state.depthWrite = e.target.checked; } }), 'Write depth'),
        h('div.u-grow'),
        selectField({
          value: '',
          options: [{ value: '', label: 'Load preset…' }, ...SHADER_PRESETS.map((p) => ({ value: p.id, label: p.name }))],
          onChange: (v) => {
            const p = PRESET_BY_ID.get(v);
            if (!p) return;
            state.fragment = p.fragment;
            state.uniforms = uniformsFromPreset(p);
            state.blending = p.blend;
            textarea.value = p.fragment;
            paintGutter();
            paintUniforms();
            validate();
          },
        }),
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 250px', gap: '10px', flex: '1 1 auto', minHeight: '300px' } },
        h('div.code-area', { style: { border: '1px solid var(--border-default)', borderRadius: '8px', height: '100%' } }, gutter, textarea),
        h('div.u-col.u-gap-2', { style: { overflow: 'auto', maxHeight: '340px' } },
          h('div.panel-title', {}, 'Uniforms'),
          uniformList,
        ),
      ),
      statusEl,
    ),
    footer: [
      h('button.btn', { type: 'button', onClick: () => closeModal() }, 'Cancel'),
      saveBtn,
    ],
  });
}

/* ================================================================== */
/* Shortcuts                                                          */
/* ================================================================== */

export function shortcutsDialog(app) {
  const groups = [
    {
      title: 'Viewport',
      items: [
        ['Orbit', ['Drag']],
        ['Pan', ['⇧', 'Drag']],
        ['Zoom', ['Scroll']],
        ['Frame selection', ['F']],
        ['Frame all', ['⇧', 'F']],
        ['Reset camera', ['⌘', '0']],
      ],
    },
    {
      title: 'Transform',
      items: [
        ['Move', ['W']],
        ['Rotate', ['E']],
        ['Scale', ['R']],
        ['World / local axis', ['X']],
        ['Snap toggle', ['⇧', 'S']],
        ['Duplicate', ['⌘', 'D']],
        ['Delete', ['Del']],
      ],
    },
    {
      title: 'Project',
      items: [
        ['Save project', ['⌘', 'S']],
        ['Export screenshot', ['⇧', '⌘', 'E']],
        ['Undo', ['⌘', 'Z']],
        ['Redo', ['⇧', '⌘', 'Z']],
        ['Import files', ['⌘', 'O']],
        ['Toggle theme', ['⌘', 'J']],
      ],
    },
    {
      title: 'Playback',
      items: [
        ['Play / pause', ['Space']],
        ['Step frame', ['←', '→']],
        ['Toggle stats', ['⌘', 'I']],
        ['Shortcut sheet', ['?']],
      ],
    },
  ];

  openModal({
    title: 'Keyboard shortcuts',
    subtitle: 'Everything is reachable by touch too — this sheet is for when you have a keyboard.',
    wide: true,
    body: h('div.shortcuts', {}, groups.map((group) =>
      h('div.shortcut-group', {},
        h('h4', {}, group.title),
        ...group.items.map(([label, keys]) =>
          h('div.shortcut-row', {},
            h('span', {}, label),
            h('span.shortcut-keys', {}, keys.map((k) => h('kbd', {}, k))),
          ),
        ),
      ),
    )),
    footer: [h('button.btn.btn-primary', { type: 'button', onClick: () => closeModal() }, 'Got it')],
  });
}

/* ================================================================== */
/* Texture picker                                                     */
/* ================================================================== */

export function texturePickerDialog(app, { materialId, slotId, onPick }) {
  const textures = app.store.get('assets', []).filter((a) => a.kind === 'texture');
  const slot = SLOT_BY_ID.get(slotId);
  if (!textures.length) {
    app.toast.info('No textures yet', 'Import a texture image or a ZIP pack first.');
    return;
  }
  const grid = h('div.asset-grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' } },
    textures.map((tex) => {
      const thumb = app.thumbCache.get(tex.blobId);
      if (!thumb && !app.pendingThumb.has(tex.blobId)) {
        app.pendingThumb.add(tex.blobId);
        app.texturePreview(tex).then((url) => {
          app.pendingThumb.delete(tex.blobId);
          if (url) {
            app.thumbCache.set(tex.blobId, url);
            app.ui.refreshModal?.();
          }
        });
      }
      return h('button.asset-card', {
        type: 'button',
        title: tex.path,
        onClick: () => {
          onPick(tex);
          closeModal();
        },
      },
        h('div.asset-thumb', {}, thumb ? h('img', { src: thumb, alt: '' }) : icon('texture', 22)),
        h('div.asset-meta', {}, h('div.asset-name', {}, tex.name)),
      );
    }),
  );

  openModal({
    title: `Choose ${slot?.label || 'texture'}`,
    subtitle: `${textures.length} textures in the library`,
    wide: true,
    body: grid,
    footer: [
      h('button.btn', { type: 'button', onClick: () => closeModal() }, 'Cancel'),
      h('button.btn', { type: 'button', onClick: () => { closeModal(); app.importPicker({ texturesOnly: true, target: { materialId, slotId } }); } }, icon('upload', 13), 'Import new…'),
    ],
  });
}

/* ================================================================== */
/* Welcome / onboarding                                               */
/* ================================================================== */

export function welcomeDialog(app) {
  openModal({
    title: 'Welcome to Atlas Scene Studio',
    subtitle: 'A comfy scene builder for desktop and iPad',
    wide: true,
    body: h('div.u-col.u-gap-3', {},
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' } },
        featureCard('Drop anything', 'GLB, glTF, FBX, OBJ, STL, PLY, DAE, 3MF — plus textures, HDRIs and audio. Drag a whole folder or a ZIP.', 'upload'),
        featureCard('Smart matching', 'Textures find their model by name, folder and map type. Review every guess before it applies.', 'sparkle'),
        featureCard('Shader Lab', 'Write WebGL fragment shaders right here, with sliders generated from your uniforms.', 'vfx'),
        featureCard('Shot Studio', 'Supersampled screenshots up to 8K, transparent backgrounds, framing and turntables.', 'camera'),
      ),
      h('p.u-muted', { style: { margin: 0, fontSize: '12px' } },
        'Everything runs locally in your browser. Your models never leave this device.',
      ),
    ),
    footer: [
      h('button.btn', { type: 'button', onClick: () => { closeModal(); shortcutsDialog(app); } }, 'Shortcuts'),
      h('button.btn.btn-primary', {
        type: 'button',
        onClick: () => {
          closeModal();
          app.store.set('ui.onboardingSeen', true);
        },
      }, icon('sparkle', 13), 'Start building'),
    ],
  });
}

function featureCard(title, body, iconName) {
  return h('div', {
    style: {
      padding: '12px',
      borderRadius: '10px',
      border: '1px solid var(--border-muted)',
      background: 'var(--bg-hover)',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
    },
  },
    h('span', { style: { color: 'var(--accent)' } }, icon(iconName, 18)),
    h('strong', { style: { fontSize: '12.5px' } }, title),
    h('span.u-muted', { style: { fontSize: '11px', lineHeight: 1.5 } }, body),
  );
}

export { confirmModal, checkbox, prop, slider, toggleSwitch, toggleRow, segmented, textInput, formatNumber, SLOTS, SLOT_PRIORITY };
