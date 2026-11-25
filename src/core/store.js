/**
 * Tiny reactive store with path-based subscriptions.
 * The whole app state is a plain JSON object — undo/redo snapshots it, the
 * exporter serialises it, and every panel subscribes to just what it needs.
 */

import { deepClone, deepEqual } from './util.js';

export class Store {
  constructor(initialState = {}) {
    this.state = initialState;
    this.listeners = new Set();
    this.pathListeners = new Map(); // "a.b" → Set<fn>
    this.batchDepth = 0;
    this.pendingPaths = new Set();
    this.pendingGlobal = false;
  }

  get(path, fallback) {
    if (path === undefined || path === null || path === '') return this.state;
    const parts = String(path).split('.');
    let node = this.state;
    for (const part of parts) {
      if (node === null || node === undefined) return fallback;
      node = node[part];
    }
    return node === undefined ? fallback : node;
  }

  set(path, value) {
    if (typeof path === 'object' && path !== null) {
      return this.patch(path);
    }
    const parts = String(path).split('.');
    const last = parts.pop();
    let node = this.state;
    for (const part of parts) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part];
    }
    if (deepEqual(node[last], value)) return value;
    node[last] = value;
    this.notify(path);
    return value;
  }

  patch(object, prefix = '') {
    const changed = [];
    for (const [key, value] of Object.entries(object || {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      const current = this.get(path);
      if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
        this.patch(value, path);
        continue;
      }
      if (deepEqual(current, value)) continue;
      this.set(path, value);
      changed.push(path);
    }
    return changed;
  }

  /** Immutable-ish update helper: `update('scene', s => ({...s, x: 1}))`. */
  update(path, updater) {
    const current = this.get(path);
    const next = updater(current);
    if (next === undefined) return current;
    this.set(path, next);
    return next;
  }

  push(path, item) {
    const list = this.get(path, []);
    const next = [...list, item];
    this.set(path, next);
    return next;
  }

  removeWhere(path, predicate) {
    const list = this.get(path, []);
    const next = list.filter((item) => !predicate(item));
    this.set(path, next);
    return next;
  }

  subscribe(fn, path = null) {
    if (!path) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    const key = String(path);
    if (!this.pathListeners.has(key)) this.pathListeners.set(key, new Set());
    this.pathListeners.get(key).add(fn);
    return () => this.pathListeners.get(key)?.delete(fn);
  }

  /** Runs several mutations and notifies once per animation frame. */
  batch(fn) {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) this.flush();
    }
  }

  notify(path) {
    if (this.batchDepth > 0) {
      if (path) this.pendingPaths.add(String(path));
      else this.pendingGlobal = true;
      return;
    }
    this.emit(path);
  }

  emit(path) {
    const matched = new Set();
    if (path) {
      const key = String(path);
      // exact + ancestor + descendant listeners
      for (const [listenPath, fns] of this.pathListeners) {
        if (listenPath === key || key.startsWith(`${listenPath}.`) || listenPath.startsWith(`${key}.`)) {
          for (const fn of fns) matched.add(fn);
        }
      }
    } else {
      for (const fns of this.pathListeners.values()) for (const fn of fns) matched.add(fn);
    }
    for (const fn of matched) safeCall(fn, this.state, path);
    for (const fn of this.listeners) safeCall(fn, this.state, path);
  }

  flush() {
    if (!this.pendingPaths.size && !this.pendingGlobal) return;
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    const global = this.pendingGlobal;
    this.pendingGlobal = false;
    if (global) this.emit(null);
    else for (const path of paths) this.emit(path);
    // path listeners already trigger the global ones via emit(); avoid doubles
  }

  snapshot() {
    return deepClone(this.state);
  }

  replace(next) {
    this.state = deepClone(next);
    this.emit(null);
  }
}

function safeCall(fn, ...args) {
  try {
    fn(...args);
  } catch (err) {
    console.error('[store] listener failed', err);
  }
}

/** Undo/redo with structural sharing-free snapshots (state stays small). */
export class History {
  constructor(store, { limit = 80 } = {}) {
    this.store = store;
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.last = store.snapshot();
  }

  /** Call after a meaningful change; `label` shows up in the history panel. */
  commit(label = 'Edit') {
    const next = this.store.snapshot();
    if (deepEqual(this.last, next)) return false;
    this.past.push({ state: this.last, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
    this.last = next;
    return true;
  }

  /** Ignores drift (e.g. camera-only changes) without pushing history. */
  sync() {
    this.last = this.store.snapshot();
  }

  undo() {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ state: this.last, label: entry.label });
    this.last = entry.state;
    this.store.replace(entry.state);
    return entry.label;
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ state: this.last, label: entry.label });
    this.last = entry.state;
    this.store.replace(entry.state);
    return entry.label;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  reset() {
    this.past.length = 0;
    this.future.length = 0;
    this.last = this.store.snapshot();
  }
}
