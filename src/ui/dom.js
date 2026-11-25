/**
 * Tiny DOM toolkit: `h()` builder, declarative panel rendering, and the
 * control widgets the inspector is made of (sliders, colour fields, vec3
 * scrubbers). No framework, no virtual DOM — panels render on demand and
 * widgets patch themselves, which keeps drag interactions at 60fps.
 */

import { clamp, escapeHtml } from '../core/util.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * h('div.card#id', { onClick, dataset, attrs }, ...children)
 * Children may be strings, nodes, arrays, null or false.
 */
export function h(tag, props = {}, ...children) {
  const match = String(tag).match(/^([a-zA-Z0-9-]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/);
  const name = (match && match[1]) || 'div';
  const el = document.createElement(name);
  if (match?.[2]) el.id = match[2].slice(1);
  if (match?.[3]) el.className = match[3].slice(1).split('.').filter(Boolean).join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = {};
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = [el.className, value].filter(Boolean).join(' ');
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) {
        if (dv === undefined || dv === null) continue;
        el.dataset[dk] = String(dv);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key === 'text') {
      el.textContent = value;
    } else if (key === 'ref' && typeof value === 'function') {
      value(el);
    } else if (key in el && !key.includes('-')) {
      try {
        el[key] = value;
      } catch {
        el.setAttribute(key, String(value));
      }
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function svg(paths, { size = 16, viewBox = '0 0 16 16', fill = 'none', stroke = 'currentColor', strokeWidth = 1.4 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('fill', fill);
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', strokeWidth);
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = paths;
  return el;
}

export const ICONS = {
  cube: '<path d="M8 1.6l5.6 3.2v6.4L8 14.4 2.4 11.2V4.8z"/><path d="M8 1.6v12.8M2.4 4.8L8 8l5.6-3.2"/>',
  texture: '<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6"/><circle cx="6" cy="6" r="1.2"/><path d="M2.6 11.2l3.2-3 2.4 2.2 2-1.8 3.2 2.8"/>',
  hdri: '<circle cx="8" cy="8" r="5.8"/><path d="M2.4 9.4c3.6-2 7.8-2 11.2 0"/>',
  light: '<path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1"/><circle cx="8" cy="8" r="2.8"/>',
  audio: '<path d="M6 11.4V4.2l5-1.2v7.2"/><circle cx="4.6" cy="11.8" r="1.5"/><circle cx="9.6" cy="10.6" r="1.5"/>',
  group: '<path d="M2.4 4.4h4l1.4 1.8h5.8v5.6H2.4z"/>',
  vfx: '<path d="M8 1.8l1.6 3.9 4.2.3-3.2 2.7 1 4.1L8 10.6l-3.6 2.2 1-4.1L2.2 6l4.2-.3z"/>',
  billboard: '<rect x="2" y="3" width="12" height="7" rx="1.6"/><path d="M8 10v3.4M5.6 13.4h4.8"/>',
  eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>',
  eyeOff: '<path d="M2.6 2.6l10.8 10.8"/><path d="M6.2 4.2A6.7 6.7 0 018 3.8c4 0 6.2 4.2 6.2 4.2a12 12 0 01-2.3 2.9M4.2 5.1A11.5 11.5 0 001.8 8S4 12.2 8 12.2a6.6 6.6 0 002.2-.4"/>',
  lock: '<rect x="3.4" y="6.8" width="9.2" height="6.6" rx="1.4"/><path d="M5.6 6.8V5.2a2.4 2.4 0 014.8 0v1.6"/>',
  unlock: '<rect x="3.4" y="6.8" width="9.2" height="6.6" rx="1.4"/><path d="M5.6 6.8V5.2A2.4 2.4 0 0110 4"/>',
  trash: '<path d="M3.2 4.4h9.6M6.4 4.4V3.2h3.2v1.2M4.4 4.4l.7 8.4h5.8l.7-8.4"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  copy: '<rect x="5.4" y="5.4" width="8" height="8" rx="1.4"/><path d="M10.6 5.4V3.8a1.4 1.4 0 00-1.4-1.4H3.8a1.4 1.4 0 00-1.4 1.4v5.4a1.4 1.4 0 001.4 1.4h1.6"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L13.4 13.4"/>',
  chevron: '<path d="M4.4 6.1L8 9.7l3.6-3.6"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3.2 8.4l3 3 6.6-7"/>',
  warn: '<path d="M8 2.4l6 11.2H2z"/><path d="M8 6.4v3.2"/><circle cx="8" cy="11.6" r=".6" fill="currentColor"/>',
  error: '<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8L5.8 10.2"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><circle cx="8" cy="5" r=".7" fill="currentColor"/>',
  camera: '<path d="M2 5.6h2.6l1.2-1.8h4.4l1.2 1.8H14v7.2H2z"/><circle cx="8" cy="8.8" r="2.2"/>',
  grid: '<path d="M2.4 6h11.2M2.4 10h11.2M6 2.4v11.2M10 2.4v11.2"/>',
  reset: '<path d="M13 8a5 5 0 11-1.6-3.7"/><path d="M13.6 1.8v3.2h-3.2"/>',
  upload: '<path d="M8 11V3.6M8 3.6L4.8 6.8M8 3.6l3.2 3.2M2.6 12.4v1h10.8v-1"/>',
  download: '<path d="M8 3v7.4M8 10.4L4.8 7.2M8 10.4l3.2-3.2M2.6 12.4v1h10.8v-1"/>',
  zip: '<path d="M3.4 2.4h9.2v11.2H3.4z"/><path d="M6.6 2.4v2.4h2.8V2.4M8 6.4v1.4M8 9v1.4"/>',
  sparkle: '<path d="M8 1.8l1.3 3.4 3.4 1.3-3.4 1.3L8 11.2 6.7 7.8 3.3 6.5l3.4-1.3zM12.4 10.6l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  wand: '<path d="M2.6 13.4l7.2-7.2M9.8 3.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  layers: '<path d="M8 2.2l5.6 2.8L8 7.8 2.4 5zM2.4 8L8 10.8 13.6 8M2.4 11L8 13.8 13.6 11"/>',
  move: '<path d="M8 1.8v12.4M1.8 8h12.4M8 1.8L6 3.9M8 1.8l2 2.1M8 14.2L6 12.1M8 14.2l2-2.1M1.8 8L3.9 6M1.8 8l2.1 2M14.2 8L12.1 6M14.2 8l-2.1 2"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1"/>',
  film: '<rect x="2" y="3.4" width="12" height="9.2" rx="1.4"/><path d="M5 3.4v9.2M11 3.4v9.2M2 8h12"/>',
  text: '<path d="M3.2 3.6h9.6M8 3.6v8.8M6 12.4h4"/>',
  play: '<path d="M5.2 3.4l7.2 4.6-7.2 4.6z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M5.6 3.6h1.8v8.8H5.6zM8.6 3.6h1.8v8.8H8.6z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1" fill="currentColor" stroke="none"/>',
  loop: '<path d="M3.2 6.4a4 4 0 016.8-1.6M12.8 9.6a4 4 0 01-6.8 1.6"/><path d="M10.4 4.2h1.6v1.6M5.6 11.8H4v-1.6"/>',
  frame: '<path d="M2 5.5V2h3.5M14 5.5V2h-3.5M2 10.5V14h3.5M14 10.5V14h-3.5"/>',
  scale: '<rect x="2.5" y="7" width="6" height="6"/><path d="M8 8l5-5M9.5 3h3.5v3.5"/>',
  rotate: '<path d="M13 8a5 5 0 11-1.6-3.7"/><path d="M13.6 1.8v3.2h-3.2"/>',
};

export const icon = (name, size = 16, extra = {}) => svg(ICONS[name] || '', { size, ...extra });

/* ------------------------------------------------------------------ */
/* Panel registry + rendering                                         */
/* ------------------------------------------------------------------ */

export class Panel {
  constructor(root, render) {
    this.root = root;
    this.render = render;
    this.raf = 0;
    this.dirty = false;
  }

  /** Coalesces multiple invalidations into one paint. */
  invalidate() {
    if (this.dirty) return;
    this.dirty = true;
    this.raf = requestAnimationFrame(() => {
      this.dirty = false;
      this.paint();
    });
  }

  paint() {
    if (!this.root.isConnected) return;
    const scroll = this.root.scrollTop;
    const active = document.activeElement;
    const focusId = active && this.root.contains(active) ? active.dataset.focusKey : null;
    const selectionStart = active?.selectionStart;
    try {
      const next = this.render();
      clear(this.root);
      if (next) this.root.appendChild(next);
      this.root.scrollTop = scroll;
      if (focusId) {
        const target = this.root.querySelector(`[data-focus-key="${CSS.escape(focusId)}"]`);
        if (target) {
          target.focus({ preventScroll: true });
          if (selectionStart !== undefined && target.setSelectionRange) {
            try { target.setSelectionRange(selectionStart, selectionStart); } catch { /* not a text input */ }
          }
        }
      }
    } catch (err) {
      console.error('[panel] render failed', err);
      clear(this.root);
      this.root.appendChild(h('div.empty-hint', {}, `Panel failed to render: ${err.message}`));
    }
  }

  mount() {
    this.invalidate();
    return this;
  }
}

/* ------------------------------------------------------------------ */
/* Widgets                                                            */
/* ------------------------------------------------------------------ */

/** Collapsible section. `open` persists through the returned element. */
export function section(title, children, { open = true, actions = null, key = null } = {}) {
  const body = h('div.section-body', {}, children);
  const stateKey = key || `section:${title}`;
  const stored = sessionStorage.getItem(stateKey);
  const isOpen = stored === null ? open : stored === '1';

  const head = h(
    'button.section-head',
    {
      type: 'button',
      onClick: (event) => {
        if (event.target.closest('[data-action]')) return;
        const wrap = head.parentElement;
        const next = wrap.dataset.open !== 'true';
        wrap.dataset.open = String(next);
        sessionStorage.setItem(stateKey, next ? '1' : '0');
      },
    },
    title,
    actions ? h('span.u-row.u-gap-1', {}, actions) : null,
    icon('chevron', 13, { class: 'caret' }),
  );
  return h('div.section', { dataset: { open: String(isOpen) } }, head, body);
}

/** Labelled row. */
export function prop(label, control, { wide = false, title = null } = {}) {
  return h(
    `div.prop${wide ? '.prop-wide' : ''}`,
    { title: title || label },
    wide ? null : h('div.prop-label', {}, label),
    control,
  );
}

/**
 * Range slider paired with a numeric input. `onChange` fires live,
 * `onCommit` once on release (used for history commits).
 */
export function slider({ label, value = 0, min = 0, max = 1, step = 0.01, unit = '', onChange, onCommit, format }) {
  const decimals = decimalsFor(step);
  const shown = (v) => (format ? format(v) : Number(v).toFixed(decimals).replace(/\.0+$/, unit ? '' : '$&'));

  const input = h('input.slider', {
    type: 'range',
    min,
    max,
    step,
    value,
    onInput: (e) => {
      const v = Number(e.target.value);
      num.value = shown(v);
      input.style.setProperty('--fill', `${((v - min) / (max - min || 1)) * 100}%`);
      onChange?.(v);
    },
    onChange: () => onCommit?.(Number(input.value)),
  });
  input.style.setProperty('--fill', `${((value - min) / (max - min || 1)) * 100}%`);

  const num = h('input.slider-val', {
    type: 'text',
    value: shown(value),
    onChange: (e) => {
      const parsed = parseFloat(e.target.value);
      if (Number.isFinite(parsed)) {
        const v = clamp(parsed, min, max);
        input.value = String(v);
        input.style.setProperty('--fill', `${((v - min) / (max - min || 1)) * 100}%`);
        e.target.value = shown(v);
        onChange?.(v);
        onCommit?.(v);
      } else {
        e.target.value = shown(Number(input.value));
      }
    },
  });

  return prop(
    label,
    h('div.slider-row', {}, input, num),
  );
}

function decimalsFor(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Numeric field with drag-to-scrub. */
export function numberInput({ value = 0, step = 0.1, min = -Infinity, max = Infinity, axis = null, onChange, onCommit, title }) {
  const wrap = h('div.num-wrap', { title });
  if (axis) wrap.appendChild(h('span.num-axis', { dataset: { axis }, text: axis.toUpperCase() }));
  const input = h('input.num-input', {
    type: 'text',
    inputMode: 'decimal',
    value: formatNum(value),
    onChange: (e) => {
      const v = clamp(parseFloat(e.target.value), min, max);
      if (Number.isFinite(v)) {
        e.target.value = formatNum(v);
        onChange?.(v);
        onCommit?.(v);
      } else {
        e.target.value = formatNum(value);
      }
    },
    onFocus: (e) => e.target.select(),
  });

  let dragging = false;
  let startX = 0;
  let startVal = 0;
  const onDown = (event) => {
    if (document.activeElement === input) return;
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startVal = parseFloat(input.value) || 0;
    wrap.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = 'ew-resize';
  };
  const onMove = (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const speed = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
    const v = clamp(roundTo(startVal + dx * step * speed, step), min, max);
    input.value = formatNum(v);
    onChange?.(v);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    onCommit?.(parseFloat(input.value) || 0);
  };
  input.addEventListener('pointerdown', onDown);
  input.addEventListener('pointermove', onMove);
  input.addEventListener('pointerup', onUp);
  input.addEventListener('pointercancel', onUp);
  input.addEventListener('lostpointercapture', onUp);

  wrap.appendChild(input);
  wrap.getValue = () => parseFloat(input.value) || 0;
  wrap.setValue = (v) => {
    if (document.activeElement !== input) input.value = formatNum(v);
  };
  return wrap;
}

const formatNum = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 1000) / 1000);
};

const roundTo = (v, step) => (step ? Math.round(v / step) * step : v);

/** vec3 editor (position / rotation / scale). */
export function vec3({ value = [0, 0, 0], step = 0.1, min = -Infinity, max = Infinity, onChange, onCommit, unit = '' }) {
  const wrap = h('div.vec3');
  const inputs = ['x', 'y', 'z'].map((axis, index) =>
    numberInput({
      value: value[index],
      step,
      min,
      max,
      axis,
      title: `${axis.toUpperCase()} ${unit}`,
      onChange: (v) => {
        const next = [...wrap.value];
        next[index] = v;
        wrap.value = next;
        onChange?.(next);
      },
      onCommit: () => onCommit?.(wrap.value),
    }),
  );
  wrap.append(...inputs);
  wrap.value = [...value];
  wrap.setValue = (v) => inputs.forEach((inp, i) => inp.setValue(v[i]));
  return wrap;
}

/** Colour swatch + native picker. */
export function colorField({ value = '#ffffff', onChange, onCommit, label = null }) {
  const picker = h('input', { type: 'color', value: normalizeHex(value) });
  const swatch = h('span.color-swatch', {}, h('i', { style: { background: value } }));
  const hex = h('span.color-hex', {}, value.replace('#', '').toUpperCase());
  const field = h(
    'button.color-field',
    {
      type: 'button',
      title: `${label || 'Colour'} — ${value}`,
      onClick: (event) => {
        if (event.target === picker) return;
        picker.click();
      },
    },
    swatch,
    hex,
    picker,
  );
  picker.addEventListener('input', () => {
    const v = picker.value;
    swatch.firstChild.style.background = v;
    hex.textContent = v.replace('#', '').toUpperCase();
    field.title = `${label || 'Colour'} — ${v}`;
    onChange?.(v);
  });
  picker.addEventListener('change', () => onCommit?.(picker.value));
  field.setValue = (v) => {
    picker.value = normalizeHex(v);
    swatch.firstChild.style.background = v;
    hex.textContent = String(v).replace('#', '').toUpperCase();
  };
  field.getValue = () => picker.value;
  return field;
}

const normalizeHex = (v) => {
  const s = String(v || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return '#ffffff';
};

/** iOS-style switch backed by aria-checked. */
export function toggleSwitch({ checked = false, onChange, label = null, disabled = false }) {
  const btn = h('button.switch', {
    type: 'button',
    role: 'switch',
    ariaChecked: String(Boolean(checked)),
    'aria-label': label || 'Toggle',
    disabled,
    onClick: () => {
      const next = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(next));
      onChange?.(next);
    },
  });
  btn.setChecked = (v) => btn.setAttribute('aria-checked', String(Boolean(v)));
  return btn;
}

/** Switch row. */
export function toggleRow(label, checked, onChange, { hint = null } = {}) {
  return h(
    'div.prop-inline',
    { title: hint || '' },
    h('span.prop-label', {}, label),
    toggleSwitch({ checked, onChange, label }),
  );
}

/** Select dropdown. */
export function selectField({ options, value, onChange, label = null }) {
  const select = h(
    'select.select',
    {
      onChange: (e) => onChange?.(e.target.value),
      'aria-label': label || 'Select',
    },
    options.map((opt) => {
      const value_ = typeof opt === 'string' ? opt : opt.value;
      const text = typeof opt === 'string' ? opt : opt.label;
      return h('option', { value: value_, selected: value_ === value }, text);
    }),
  );
  select.setValue = (v) => { select.value = v; };
  return select;
}

/** Segmented button group. */
export function segmented({ options, value, onChange, small = false }) {
  const el = h('div.segmented', { style: small ? { padding: '2px' } : null });
  const buttons = options.map((opt) => {
    const v = typeof opt === 'string' ? opt : opt.value;
    const text = typeof opt === 'string' ? opt : opt.label;
    const btn = h(
      `button.seg-btn${v === value ? '.is-active' : ''}`,
      {
        type: 'button',
        onClick: () => {
          buttons.forEach((b) => b.classList.toggle('is-active', b === btn));
          onChange?.(v);
        },
        style: small ? { height: '22px', padding: '0 8px', fontSize: '11px' } : null,
      },
      text,
    );
    return btn;
  });
  el.append(...buttons);
  return el;
}

/** Text input with debounce-free live change + commit. */
export function textInput({ value = '', placeholder = '', onChange, onCommit, mono = false }) {
  const input = h(`input.input${mono ? '.u-mono' : ''}`, {
    type: 'text',
    value,
    placeholder,
    onChange: (e) => {
      onChange?.(e.target.value);
      onCommit?.(e.target.value);
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter') e.target.blur();
    },
    'data-focus-key': placeholder || 'text',
  });
  input.setValue = (v) => { if (document.activeElement !== input) input.value = v; };
  return input;
}

/** Checkbox with an accessible label. */
export function checkbox({ checked = false, onChange, label = null }) {
  const input = h('input', {
    type: 'checkbox',
    checked,
    'aria-label': label || 'Toggle',
    onChange: (event) => onChange?.(event.target.checked),
    style: { accentColor: 'var(--accent)', width: '15px', height: '15px' },
  });
  input.setChecked = (v) => { input.checked = Boolean(v); };
  return input;
}

/** Empty state block. */
export function emptyHint(text, iconName = 'info') {
  return h('div.empty-hint', {}, icon(iconName, 22), h('span', {}, text));
}

export { escapeHtml };
