/**
 * Small dependency-free helpers shared across the app.
 * Kept framework-agnostic so they can be unit-tested in Node.
 */

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Three.js Object3D names must be unique-ish; we use stable ids instead of names. */
let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1e9;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

export function slug(text, fallback = 'item') {
  const s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

export function formatBytes(bytes, decimals = 1) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / Math.pow(1024, i);
  const fixed = i === 0 ? 0 : decimals;
  return `${value.toFixed(fixed).replace(/\.0$/, '')} ${units[i]}`;
}

export function formatNumber(n, decimals = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** Stable JSON clone (structuredClone when available, JSON fallback). */
export function deepClone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* functions / class instances fall back to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

export function debounce(fn, wait = 150) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, wait = 60) {
  let last = 0;
  let queued = null;
  return (...args) => {
    const now = performance.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      if (queued) {
        clearTimeout(queued);
        queued = null;
      }
      fn(...args);
    } else if (!queued) {
      queued = setTimeout(() => {
        queued = null;
        last = performance.now();
        fn(...args);
      }, remaining);
    }
  };
}

/** Maps a 0..1 (or -1..1) normalised value onto a range. */
export function mapRange(value, inMin, inMax, outMin, outMax) {
  const t = (value - inMin) / (inMax - inMin || 1);
  return outMin + (outMax - outMin) * t;
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Yields to the browser so long import loops never freeze the UI. */
export function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export const isApplePlatform = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

export const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  (('ontouchstart' in window && navigator.maxTouchPoints > 1) ||
    /iPad|Tablet|Touch/.test(navigator.userAgent || ''));

export const modKey = () => (isApplePlatform() ? '⌘' : 'Ctrl');

export function humanDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
