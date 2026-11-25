/**
 * Accessible modal manager: focus trap, Escape to close, scroll lock.
 * Only one modal at a time; stacked modals are not needed anywhere.
 */
import { h, icon } from './dom.js';

const root = () => document.getElementById('modal-root');

let current = null;
let lastFocused = null;

export function openModal({
  title,
  subtitle = '',
  body,
  footer = null,
  wide = false,
  closable = true,
  onClose = null,
  className = '',
}) {
  closeModal({ silent: true });
  lastFocused = document.activeElement;

  const container = root();
  const modalEl = h(
    `div.modal${wide ? '.modal-wide' : ''}${className ? `.${className}` : ''}`,
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': String(title) },
    h(
      'div.modal-head',
      {},
      h('div.u-grow', {}, h('div.modal-title', {}, title), subtitle ? h('div.modal-sub', {}, subtitle) : null),
      closable
        ? h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onClick: () => closeModal() }, icon('close', 16))
        : null,
    ),
    h('div.modal-body', {}, body),
    footer ? h('div.modal-foot', {}, footer) : null,
  );

  container.hidden = false;
  container.replaceChildren(modalEl);
  document.body.style.overflow = 'hidden';

  const focusables = () =>
    [...modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.disabled && el.offsetParent !== null,
    );

  const onKey = (event) => {
    if (event.key === 'Escape' && closable) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onBackdrop = (event) => {
    if (event.target === container && closable) closeModal();
  };

  document.addEventListener('keydown', onKey, true);
  container.addEventListener('pointerdown', onBackdrop);

  current = {
    el: modalEl,
    onClose,
    cleanup: () => {
      document.removeEventListener('keydown', onKey, true);
      container.removeEventListener('pointerdown', onBackdrop);
    },
  };

  requestAnimationFrame(() => {
    const target = modalEl.querySelector('[data-autofocus]') || focusables()[0] || modalEl;
    target.focus?.({ preventScroll: true });
  });

  return {
    el: modalEl,
    close: () => closeModal(),
    setBody: (next) => {
      const bodyEl = modalEl.querySelector('.modal-body');
      bodyEl.replaceChildren(next);
    },
  };
}

export function closeModal({ silent = false } = {}) {
  const container = root();
  if (!current) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  const { el, onClose, cleanup } = current;
  current = null;
  cleanup();
  container.hidden = true;
  container.replaceChildren();
  document.body.style.overflow = '';
  if (!silent) onClose?.();
  if (lastFocused?.isConnected) lastFocused.focus({ preventScroll: true });
  el.remove();
}

export const isModalOpen = () => Boolean(current);

/** Convenience confirm dialog. */
export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      closeModal({ silent: true });
    };
    const api = openModal({
      title,
      body: h('p', { style: { margin: 0, color: 'var(--fg-muted)' } }, message),
      footer: [
        h('button.btn', { type: 'button', onClick: () => finish(false) }, 'Cancel'),
        h(
          `button.btn.${danger ? 'btn-danger' : 'btn-primary'}`,
          { type: 'button', 'data-autofocus': '', onClick: () => finish(true) },
          confirmLabel,
        ),
      ],
      onClose: () => finish(false),
    });
    void api;
  });
}
