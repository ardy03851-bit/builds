/**
 * Toast notifications with progress support.
 * Toasts never stack more than 4 deep and never trap focus.
 */
import { h, icon } from './dom.js';
import { uid } from '../core/util.js';

const ICON_FOR = {
  success: { name: 'check', color: 'var(--success)' },
  error: { name: 'error', color: 'var(--danger)' },
  warn: { name: 'warn', color: 'var(--warn)' },
  info: { name: 'info', color: 'var(--info)' },
  progress: { name: 'sparkle', color: 'var(--accent)' },
};

export class Toaster {
  constructor(root) {
    this.root = root;
    this.items = new Map();
    this.max = 4;
  }

  show({ kind = 'info', title = '', message = '', timeout = null, persistent = false, actions = null }) {
    const id = uid('toast');
    const iconDef = ICON_FOR[kind] || ICON_FOR.info;
    const progress = h('i.toast-progress', { style: { width: '0%' } });

    const closeBtn = h(
      'button.toast-close',
      {
        type: 'button',
        'aria-label': 'Dismiss',
        onClick: () => this.dismiss(id),
      },
      icon('close', 13),
    );

    const el = h(
      'div.toast',
      { dataset: { kind, toastId: id }, role: kind === 'error' ? 'alert' : 'status' },
      h('span.toast-icon', { style: { color: iconDef.color } }, icon(iconDef.name, 16)),
      h(
        'div.toast-body',
        {},
        title ? h('div.toast-title', {}, title) : null,
        message ? h('div.toast-msg', {}, message) : null,
        actions ? h('div.u-row.u-gap-1.u-mt-2', {}, actions) : null,
      ),
      closeBtn,
      kind === 'progress' || persistent ? null : progress,
    );

    this.root.appendChild(el);
    this.items.set(id, { el, progress, timeout: 0 });

    // trim oldest
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      this.dismiss(oldest, { instant: true });
    }

    if (timeout) this._autoDismiss(id, timeout);
    else if (kind !== 'progress' && !persistent) this._autoDismiss(id, kind === 'error' ? 9000 : 4200);

    return {
      id,
      update: (patch) => this.update(id, patch),
      progress: (value, message) => this.setProgress(id, value, message),
      dismiss: () => this.dismiss(id),
    };
  }

  _autoDismiss(id, ms) {
    const item = this.items.get(id);
    if (!item) return;
    clearTimeout(item.timeout);
    item.timeout = setTimeout(() => this.dismiss(id), ms);
  }

  update(id, { title, message, kind }) {
    const item = this.items.get(id);
    if (!item) return;
    if (title !== undefined) {
      const node = item.el.querySelector('.toast-title');
      if (node) node.textContent = title;
    }
    if (message !== undefined) {
      const node = item.el.querySelector('.toast-msg');
      if (node) node.textContent = message;
    }
    if (kind) item.el.dataset.kind = kind;
  }

  setProgress(id, value, message) {
    const item = this.items.get(id);
    if (!item) return;
    const pct = Math.max(0, Math.min(100, Math.round(value)));
    item.progress.style.width = `${pct}%`;
    if (message !== undefined) {
      const node = item.el.querySelector('.toast-msg');
      if (node) node.textContent = message;
    }
  }

  dismiss(id, { instant = false } = {}) {
    const item = this.items.get(id);
    if (!item) return;
    clearTimeout(item.timeout);
    this.items.delete(id);
    if (instant) {
      item.el.remove();
      return;
    }
    item.el.classList.add('is-leaving');
    setTimeout(() => item.el.remove(), 220);
  }

  success(title, message = '') {
    return this.show({ kind: 'success', title, message });
  }
  error(title, message = '') {
    return this.show({ kind: 'error', title, message });
  }
  warn(title, message = '') {
    return this.show({ kind: 'warn', title, message });
  }
  info(title, message = '') {
    return this.show({ kind: 'info', title, message });
  }
  progress(title, message = '') {
    return this.show({ kind: 'progress', title, message, persistent: true });
  }

  clear() {
    for (const id of [...this.items.keys()]) this.dismiss(id, { instant: true });
  }
}
