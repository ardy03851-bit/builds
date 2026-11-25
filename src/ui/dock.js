/**
 * Bottom dock: Timeline (with transport + keyframes), Animation clip list,
 * VFX source editor, and the Console.
 */
import {
  $, h, icon, Panel, emptyHint, slider, toggleSwitch, selectField,
} from './dom.js';
import { formatTime, clamp } from '../core/util.js';
import { SHADER_PRESETS, PRESET_BY_ID, validateShader, buildFragmentSource, DEFAULT_VERTEX_SHADER, syncUniformDeclarations } from '../core/shaderlib.js';

export class Dock {
  constructor(app) {
    this.app = app;
    this.root = $('#bottom-panel');
    this.panel = new Panel(this.root, () => this.render());
    this.codeDraft = null;
    this.draftShaderId = null;
    this.shaderError = null;
    this.shaderWarnings = [];
    this.scrubbing = false;
  }

  mount() {
    this.panel.mount();
    const invalidate = () => this.panel.invalidate();
    this.app.store.subscribe(invalidate, 'timeline');
    this.app.store.subscribe(invalidate, 'ui.bottomTab');
    this.app.store.subscribe(invalidate, 'selection');
    this.app.store.subscribe(invalidate, 'objects');
    this.app.store.subscribe(invalidate, 'lighting');
    this.app.events.on('console:changed', invalidate);
    this.app.events.on('shader:changed', invalidate);
  }

  render() {
    const tab = this.app.store.get('ui.bottomTab', 'timeline');
    switch (tab) {
      case 'animation':
        return this.renderAnimation();
      case 'shader':
        return this.renderShader();
      case 'console':
        return this.renderConsole();
      case 'timeline':
      default:
        return this.renderTimeline();
    }
  }

  /* -------------------------------------------------------------- timeline */

  renderTimeline() {
    const timeline = this.app.store.get('timeline', {});
    const duration = Math.max(1, timeline.duration || 12);
    const time = clamp(timeline.time ?? 0, 0, duration);
    const tracks = timeline.tracks || [];

    const ruler = this.buildRuler(duration);
    const lanes = h('div.u-col', { style: { gap: 0 } });
    const laneWidths = [];

    // Rebuild on resize/scroll: we use percentage positioning, so no measuring.
    for (const track of tracks) {
      const left = (track.start / duration) * 100;
      const width = Math.max(0.6, (track.duration / duration) * 100);
      lanes.appendChild(
        h('div.track-row', {},
          h('div.track-label', { title: track.name },
            h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: track.color, flex: 'none' } }),
            h('span.u-truncate', {}, track.name),
          ),
          h('div.track-lane', {},
            h('div.track-bar', {
              style: { left: `${left}%`, width: `${width}%` },
              title: `${track.name} · ${track.duration.toFixed(2)}s`,
              onClick: () => this.app.animation.seek(track.start),
            }, track.name),
          ),
        ),
      );
      laneWidths.push(laneWidths.length);
    }

    const playheadLeft = `${(time / duration) * 100}%`;

    return h(
      'div.timeline-wrap',
      {},
      h('div.transport', {},
        h('button.play-btn', {
          type: 'button',
          title: timeline.playing ? 'Pause (Space)' : 'Play (Space)',
          onClick: () => this.app.animation.toggle(),
        }, icon(timeline.playing ? 'pause' : 'play', 14)),
        h('button.icon-btn.icon-sm', { type: 'button', title: 'Stop and rewind', onClick: () => { this.app.animation.pause(); this.app.animation.seek(0); } }, icon('stop', 12)),
        h('button.icon-btn.icon-sm', {
          type: 'button',
          title: 'Loop',
          'aria-pressed': String(timeline.loop !== false),
          class: timeline.loop !== false ? 'is-active' : '',
          onClick: () => this.app.store.set('timeline.loop', !(timeline.loop !== false)),
        }, icon('loop', 13)),
        h('span.transport-time', {}, formatTime(time)),
        h('span.u-muted', { style: { fontSize: '11px' } }, '/', formatTime(duration)),
        h('div.transport-sep'),
        h('div.u-row.u-gap-1', { style: { width: '150px' } },
          h('span.u-muted', { style: { fontSize: '10px' } }, 'SPEED'),
          h('input.slider', {
            type: 'range', min: 0.1, max: 3, step: 0.05, value: timeline.speed ?? 1,
            style: { '--fill': `${((timeline.speed ?? 1) / 3) * 100}%` },
            onInput: (e) => this.app.store.set('timeline.speed', Number(e.target.value)),
          }),
          h('span.u-mono', { style: { fontSize: '10px', minWidth: '28px' } }, `${(timeline.speed ?? 1).toFixed(2)}×`),
        ),
        h('div.transport-sep'),
        h('div.u-row.u-gap-1', { style: { width: '140px' } },
          h('span.u-muted', { style: { fontSize: '10px' } }, 'DUR'),
          h('input.input', {
            type: 'number', min: 1, max: 600, step: 0.5, value: duration,
            style: { height: '22px', fontSize: '11px', width: '64px' },
            onChange: (e) => {
              const v = clamp(Number(e.target.value) || 12, 1, 600);
              this.app.store.set('timeline.duration', v);
            },
          }),
        ),
        h('div.dock-spacer'),
        h('button.btn', {
          type: 'button',
          style: { height: '24px', fontSize: '11px' },
          title: 'Capture a 4-angle contact sheet',
          onClick: () => this.app.captureTurntable(),
        }, icon('camera', 12), 'Turntable'),
      ),
      h('div.ruler', {
        onPointerDown: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const seek = (clientX) => {
            const t = clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
            this.app.animation.seek(t);
          };
          seek(event.clientX);
          const move = (ev) => seek(ev.clientX);
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        },
        style: { paddingLeft: '152px' },
      },
        h('div', { style: { position: 'relative', flex: '1 1 auto', height: '100%' } }, ruler, h('div.playhead', { style: { left: playheadLeft } })),
      ),
      h('div.tracks', { style: { paddingBottom: '8px' } },
        tracks.length ? lanes : emptyHint('Import a model with animations to see its clips here, or scrub the ruler to preview playback.', 'film'),
      ),
    );
  }

  buildRuler(duration) {
    const ticks = [];
    const major = chooseStep(duration);
    const minor = major / 5;
    const fmt = (t) => (major < 1 ? t.toFixed(2).replace(/0$/, '') : String(Math.round(t)));
    for (let t = 0; t <= duration + 1e-6; t += minor) {
      const left = (t / duration) * 100;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ticks.push(h(`div.ruler-tick${isMajor ? '.major' : ''}`, { style: { left: `${left}%` } }));
      if (isMajor) ticks.push(h('div.ruler-label', { style: { left: `${left}%` } }, fmt(t)));
    }
    return h('div', { style: { position: 'absolute', inset: 0 } }, ticks);
  }

  /* -------------------------------------------------------------- animation */

  renderAnimation() {
    const objects = this.app.store.get('objects', []);
    const withClips = objects.filter((o) => o.animations?.length);
    const selected = this.app.store.get('selection.0');
    const node = objects.find((o) => o.id === selected);
    const entry = node ? this.app.animation.mixers.get(node.id) : null;

    return h(
      'div.panel',
      { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px' } },
      h('div',
        {},
        h('div.panel-title', {}, 'Animatable objects'),
        withClips.length
          ? h('div.u-col.u-gap-1', {},
              withClips.map((obj) =>
                h('button.btn', {
                  type: 'button',
                  style: { justifyContent: 'space-between', height: '30px' },
                  onClick: () => this.app.scene.select([obj.id]),
                },
                  h('span.u-truncate', {}, obj.name),
                  h('span.badge.badge-ghost', {}, `${obj.animations.length} clips`),
                ),
              ),
            )
          : emptyHint('No animated assets yet. FBX and glTF files with keyframes work best.', 'film'),
      ),
      h('div',
        {},
        h('div.panel-title', {}, node ? `Clips · ${node.name}` : 'Clips'),
        entry
          ? h('div.u-col.u-gap-1', {},
              entry.clips.map((clip, index) =>
                h('div.u-row.u-gap-2', { style: { padding: '4px 0' } },
                  h('button.btn', {
                    type: 'button',
                    style: { flex: '1 1 auto', justifyContent: 'space-between' },
                    onClick: () => {
                      entry.actions.forEach((action, i) => {
                        if (i === index) action.reset().play();
                        else action.stop();
                      });
                      this.app.animation.play();
                    },
                  }, h('span.u-truncate', {}, clip.name || `Clip ${index + 1}`), h('span.u-muted', {}, `${clip.duration.toFixed(2)}s`)),
                  h('button.icon-btn.icon-sm', {
                    type: 'button',
                    title: 'Solo & seek to start',
                    onClick: () => {
                      this.app.animation.pause();
                      this.app.animation.seek(0);
                    },
                  }, icon('reset', 12)),
                ),
              ),
            )
          : emptyHint(node ? 'This object has no animation clips.' : 'Select an animated object.', 'film'),
      ),
    );
  }

  /* -------------------------------------------------------------- shader */

  renderShader() {
    const records = this.app.store.get('lighting.customShaders', []);
    const activeId = this.app.uiState.shaderId || records[0]?.id || null;
    const record = records.find((r) => r.id === activeId) || null;

    if (this.draftShaderId !== activeId) {
      this.draftShaderId = activeId;
      this.codeDraft = record ? record.fragment : SHADER_PRESETS[0].fragment;
      this.shaderError = null;
      this.shaderWarnings = [];
    }

    const source = this.codeDraft ?? '';
    const validation = validateShader(source, { uniforms: record?.uniforms || {} });

    const gutter = h('div.code-gutter', {}, source.split('\n').map((_, i) => h('div', {}, String(i + 1))).join('\n'));
    const textarea = h('textarea.code-input', {
      spellcheck: false,
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      value: source,
      'aria-label': 'Fragment shader source',
      onInput: (event) => {
        this.codeDraft = event.target.value;
        gutter.textContent = this.codeDraft.split('\n').map((_, i) => String(i + 1)).join('\n');
      },
      onScroll: (event) => {
        gutter.scrollTop = event.target.scrollTop;
      },
      onKeyDown: (event) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          const el = event.target;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          el.value = `${el.value.slice(0, start)}  ${el.value.slice(end)}`;
          el.selectionStart = el.selectionEnd = start + 2;
          this.codeDraft = el.value;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault();
          this.applyShader(record, textarea);
        }
      },
    });

    return h(
      'div.code-wrap',
      {},
      h('div.code-toolbar', {},
        h('span.panel-title', {}, record ? record.name : 'New shader'),
        selectField({
          value: activeId || '',
          options: [{ value: '', label: 'Preset starter…' }, ...SHADER_PRESETS.map((p) => ({ value: `preset:${p.id}`, label: p.name }))],
          onChange: (value) => {
            if (!value.startsWith('preset:')) return;
            const preset = PRESET_BY_ID.get(value.slice(7));
            if (preset) {
              this.codeDraft = preset.fragment;
              this.panel.invalidate();
            }
          },
        }),
        h('div.dock-spacer'),
        h('button.btn', {
          type: 'button',
          onClick: () => {
            this.codeDraft = source;
            this.app.newShaderFrom(this.codeDraft);
          },
        }, icon('plus', 12), 'Save as effect'),
        h('button.btn.btn-primary', {
          type: 'button',
          disabled: !record || !validation.ok,
          onClick: () => this.applyShader(record, textarea),
        }, icon('check', 12), 'Apply'),
        h('button.btn', {
          type: 'button',
          onClick: () => this.app.openShaderLab({ shaderId: activeId, fullscreen: true }),
        }, 'Full editor'),
      ),
      h('div.code-area', {}, gutter, textarea),
      h(
        `div.code-status`,
        { dataset: { state: validation.ok ? (this.shaderWarnings.length ? 'warn' : 'ok') : 'error' } },
        validation.ok ? icon('check', 12) : icon('error', 12),
        h('span.u-truncate', {
          style: { flex: '1 1 auto' },
        }, validation.ok ? `Valid GLSL · ${source.split('\n').length} lines` : validation.problems[0]),
        validation.warnings.length ? h('span.badge.badge-warn', {}, `${validation.warnings.length} warnings`) : null,
      ),
    );
  }

  applyShader(record, textarea) {
    const source = textarea?.value ?? this.codeDraft ?? '';
    const validation = validateShader(source, { uniforms: record?.uniforms || {} });
    if (!validation.ok) {
      this.app.toast.error('Shader has errors', validation.problems[0]);
      this.app.log('error', validation.problems.join(' · '));
      return;
    }
    if (!record) {
      this.app.newShaderFrom(source);
      return;
    }
    this.app.updateShader(record.id, {
      fragment: source,
      revision: (record.revision || 0) + 1,
    });
    this.app.toast.success('Shader applied', record.name);
  }

  /* -------------------------------------------------------------- console */

  renderConsole() {
    const lines = this.app.consoleLines;
    if (!lines.length) return emptyHint('Import messages, warnings and shader errors appear here.', 'info');
    return h(
      'div.console',
      {},
      ...lines.slice(-200).map((line) =>
        h(`div.console-line`, { dataset: { level: line.level } },
          h('span.console-time', {}, line.time),
          h('span.console-level', {}, line.level),
          h('span.console-msg', {}, line.message),
        ),
      ),
    );
  }
}

/** Picks a "nice" label interval so the ruler always reads 0, 1, 2, 3… */
function chooseStep(duration) {
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const step of candidates) {
    if (duration / step <= 10) return step;
  }
  return 600;
}

export { buildFragmentSource, DEFAULT_VERTEX_SHADER, syncUniformDeclarations, toggleSwitch, slider };
