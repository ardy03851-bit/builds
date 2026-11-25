/**
 * Scene controllers attached to the engine:
 *  · VfxController   — shader-driven meshes, live uniform editing
 *  · BillboardController — HTML labels/overlays locked to 3D anchors
 *  · AnimationController — clip playback + timeline scrubbing
 *
 * They all follow the same contract: `sync(store)` reconciles live three.js
 * objects with declarative nodes, never rebuilding what has not changed.
 */
import * as THREE from 'three';
import { DEFAULT_VERTEX_SHADER, buildFragmentSource } from '../core/shaderlib.js';
import { uid } from '../core/util.js';

const BLEND_MODES = {
  normal: THREE.NormalBlending,
  additive: THREE.AdditiveBlending,
  subtractive: THREE.SubtractiveBlending,
  multiply: THREE.MultiplyBlending,
};

/* ================================================================== */
/* VFX                                                                */
/* ================================================================== */

export class VfxController {
  constructor(engine, store) {
    this.engine = engine;
    this.store = store;
    this.meshes = new Map(); // nodeId → { mesh, materials, uniforms, configKey }
    this.geometryCache = new Map();
    this.compileInfo = new Map();
    this.onError = null;
  }

  geometry(kind, segments = 32) {
    const key = `${kind}:${segments}`;
    if (this.geometryCache.has(key)) return this.geometryCache.get(key);
    let geo;
    switch (kind) {
      case 'sphere':
        geo = new THREE.SphereGeometry(1, segments, Math.max(8, segments / 2));
        break;
      case 'box':
        geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
        break;
      case 'torus':
        geo = new THREE.TorusGeometry(0.7, 0.28, 16, segments);
        break;
      case 'cylinder':
        geo = new THREE.CylinderGeometry(0.7, 0.7, 1.6, segments, 1, true);
        break;
      case 'plane':
      default:
        geo = new THREE.PlaneGeometry(2, 2, 1, 1);
    }
    this.geometryCache.set(key, geo);
    return geo;
  }

  shaderFor(node) {
    const vfx = node.vfx || {};
    const records = this.store.get('lighting.customShaders', []);
    return records.find((r) => r.id === vfx.shaderId) || null;
  }

  sync() {
    const objects = this.store.get('objects', []);
    const vfxNodes = objects.filter((o) => o.kind === 'vfx');
    const seen = new Set();

    for (const node of vfxNodes) {
      seen.add(node.id);
      const record = this.shaderFor(node);
      if (!record) continue;
      const configKey = JSON.stringify({
        shader: record.id,
        geometry: node.vfx?.geometry,
        segments: node.vfx?.segments,
        version: record.revision || 0,
        uniforms: Object.keys(record.uniforms || {}),
      });

      let entry = this.meshes.get(node.id);
      const group = this.engine.objectMap.get(node.id);
      if (!group) continue;

      if (!entry || entry.configKey !== configKey) {
        if (entry) {
          group.remove(entry.mesh);
          entry.mesh.material.dispose();
        }
        entry = this.buildMesh(node, record, configKey);
        if (!entry) continue;
        group.add(entry.mesh);
        this.meshes.set(node.id, entry);
      }
      this.applyUniforms(entry, node, record);
      entry.mesh.visible = node.visible !== false;
    }

    for (const [id, entry] of this.meshes) {
      if (seen.has(id)) continue;
      entry.mesh.parent?.remove(entry.mesh);
      entry.mesh.material.dispose();
      this.meshes.delete(id);
    }
  }

  buildMesh(node, record, configKey) {
    const vertex = record.vertex || DEFAULT_VERTEX_SHADER;
    const fragment = buildFragmentSource(record.fragment || '', record.uniforms || {});
    const material = new THREE.ShaderMaterial({
      vertexShader: normalizeVertex(vertex),
      fragmentShader: fragment,
      uniforms: buildUniforms(record, this.store.get('lighting.customShaders', [])),
      transparent: record.transparent !== false,
      depthWrite: record.depthWrite !== false,
      side: record.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
      blending: BLEND_MODES[record.blending] || THREE.NormalBlending,
    });
    material.name = record.name;

    const geo = this.geometry(node.vfx?.geometry || 'plane', node.vfx?.segments || 32);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `VFX:${record.name}`;
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;

    // surface compile errors instead of a silent black object
    try {
      this.engine.renderer.compile(mesh, this.engine.scene, this.engine.camera);
      this.compileInfo.set(node.id, { ok: true, message: '' });
    } catch (err) {
      this.compileInfo.set(node.id, { ok: false, message: String(err?.message || err) });
      this.onError?.(node.id, String(err?.message || err));
    }

    return { mesh, material, configKey, uniforms: material.uniforms };
  }

  applyUniforms(entry, node, record) {
    const overrides = node.vfx?.uniforms || {};
    for (const [name, def] of Object.entries(record.uniforms || {})) {
      const uniform = entry.uniforms[name];
      if (!uniform) continue;
      const value = overrides[name] !== undefined ? overrides[name] : def.value;
      if (def.type === 'color') uniform.value.set(value);
      else if (def.type === 'vec2') uniform.value.set(value?.[0] ?? 0, value?.[1] ?? 0);
      else if (def.type === 'int') uniform.value = Math.round(value);
      else uniform.value = Number(value);
    }
    entry.material.opacity = node.vfx?.opacity ?? 1;
    entry.mesh.scale.setScalar(node.vfx?.scale ?? 1);
  }

  tick(elapsed) {
    for (const entry of this.meshes.values()) {
      if (entry.uniforms.uTime) entry.uniforms.uTime.value = elapsed;
    }
    // camera-facing VFX
    for (const nodeId of this.meshes.keys()) {
      const node = this.store.get('objects', []).find((o) => o.id === nodeId);
      if (node?.vfx?.billboard) {
        const group = this.engine.objectMap.get(nodeId);
        if (group) {
          group.quaternion.copy(this.engine.camera.quaternion);
          if (group.parent && group.parent !== this.engine.root) {
            group.parent.getWorldQuaternion(tmpQuat);
            group.quaternion.premultiply(tmpQuat.invert());
          }
        }
      }
    }
  }

  dispose() {
    for (const entry of this.meshes.values()) {
      entry.mesh.parent?.remove(entry.mesh);
      entry.material.dispose();
    }
    this.meshes.clear();
    for (const geo of this.geometryCache.values()) geo.dispose();
    this.geometryCache.clear();
  }
}

const tmpQuat = new THREE.Quaternion();
const tmpColor = new THREE.Color();

function buildUniforms(record, allShaders) {
  void allShaders;
  const uniforms = { uTime: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) } };
  for (const [name, def] of Object.entries(record.uniforms || {})) {
    switch (def.type) {
      case 'color':
        uniforms[name] = { value: tmpColor.set(def.value || '#ffffff').clone() };
        break;
      case 'vec2':
        uniforms[name] = { value: new THREE.Vector2(def.value?.[0] ?? 0, def.value?.[1] ?? 0) };
        break;
      case 'vec3':
        uniforms[name] = { value: new THREE.Vector3(...(def.value || [0, 0, 0])) };
        break;
      case 'vec4':
        uniforms[name] = { value: new THREE.Vector4(...(def.value || [0, 0, 0, 1])) };
        break;
      case 'int':
        uniforms[name] = { value: Math.round(def.value ?? 0) };
        break;
      default:
        uniforms[name] = { value: Number(def.value ?? 0) };
    }
  }
  return uniforms;
}

function normalizeVertex(vertex) {
  const src = String(vertex || DEFAULT_VERTEX_SHADER);
  return /precision\s/.test(src) ? src : `precision highp float;\n${src}`;
}

/* ================================================================== */
/* Billboards (DOM overlays anchored in 3D)                            */
/* ================================================================== */

export class BillboardController {
  constructor(engine, store, layer) {
    this.engine = engine;
    this.store = store;
    this.layer = layer;
    this.elements = new Map();
    this.enabled = true;
    this.tmp = new THREE.Vector3();
  }

  sync() {
    const nodes = this.store.get('objects', []).filter((o) => o.kind === 'billboard');
    const seen = new Set();
    for (const node of nodes) {
      seen.add(node.id);
      let entry = this.elements.get(node.id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'billboard';
        el.dataset.nodeId = node.id;
        this.layer.appendChild(el);
        entry = { el, cache: '' };
        this.elements.set(node.id, entry);
      }
      const cfg = node.billboard || {};
      const html = billboardHtml(node, cfg);
      if (entry.cache !== html) {
        entry.el.innerHTML = html;
        entry.cache = html;
      }
      entry.el.dataset.style = cfg.style || 'bubble';
      entry.el.classList.toggle('is-selected', this.store.get('selection', []).includes(node.id));
      entry.el.style.pointerEvents = cfg.clickable === false ? 'none' : 'auto';
    }
    for (const [id, entry] of this.elements) {
      if (seen.has(id)) continue;
      entry.el.remove();
      this.elements.delete(id);
    }
  }

  update() {
    if (!this.enabled) {
      for (const entry of this.elements.values()) entry.el.style.display = 'none';
      return;
    }
    const rect = this.engine.container.getBoundingClientRect();
    const camera = this.engine.camera;
    for (const [nodeId, entry] of this.elements) {
      const group = this.engine.objectMap.get(nodeId);
      if (!group) {
        entry.el.style.display = 'none';
        continue;
      }
      group.getWorldPosition(this.tmp);
      const cfg = this.store.get('objects', []).find((o) => o.id === nodeId)?.billboard || {};
      this.tmp.y += cfg.offsetY ?? 0.35;
      const projected = this.tmp.clone().project(camera);
      const behind = projected.z > 1;
      const x = ((projected.x + 1) / 2) * rect.width;
      const y = ((-projected.y + 1) / 2) * rect.height;
      const visible = !behind && x > -120 && x < rect.width + 120 && y > -80 && y < rect.height + 80;
      entry.el.style.display = visible ? 'block' : 'none';
      if (!visible) continue;
      const scale = cfg.scale ?? 1;
      entry.el.style.transform = `translate(-50%, -100%) scale(${scale})`;
      entry.el.style.left = `${x}px`;
      entry.el.style.top = `${y}px`;
      entry.el.style.opacity = String(cfg.opacity ?? 1);
    }
  }

  dispose() {
    for (const entry of this.elements.values()) entry.el.remove();
    this.elements.clear();
  }
}

function billboardHtml(node, cfg) {
  const text = escape(String(cfg.text ?? node.name ?? 'Label'));
  const title = cfg.title ? `<div style="font-weight:650">${escape(cfg.title)}</div>` : '';
  const subtitle = cfg.subtitle ? `<div style="opacity:.7;font-size:10px">${escape(cfg.subtitle)}</div>` : '';
  const body = `${title}<div>${text}</div>${subtitle}`;
  if (cfg.style === 'chip') return `<span>${text}</span>`;
  return body;
}

const escape = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================================================================== */
/* Animation                                                          */
/* ================================================================== */

export class AnimationController {
  constructor(engine, store, app) {
    this.engine = engine;
    this.store = store;
    this.app = app;
    this.mixers = new Map(); // nodeId → { mixer, actions, clips }
    this.elapsed = 0;
  }

  register(nodeId, object, clips) {
    if (!clips?.length) return null;
    this.unregister(nodeId);
    const mixer = new THREE.AnimationMixer(object);
    const actions = clips.map((clip) => {
      const action = mixer.clipAction(clip);
      action.clampWhenFinished = true;
      action.loop = THREE.LoopRepeat;
      return action;
    });
    const entry = { mixer, actions, clips };
    this.mixers.set(nodeId, entry);
    return entry;
  }

  unregister(nodeId) {
    const entry = this.mixers.get(nodeId);
    if (!entry) return;
    entry.mixer.stopAllAction();
    entry.mixer.uncacheRoot(entry.mixer.getRoot());
    this.mixers.delete(nodeId);
  }

  clear() {
    for (const id of [...this.mixers.keys()]) this.unregister(id);
  }

  get totalDuration() {
    let max = 0;
    for (const entry of this.mixers.values()) {
      for (const action of entry.actions) {
        const clip = action.getClip();
        if (clip.duration > max) max = clip.duration;
      }
    }
    return Math.max(max, 1);
  }

  /** Timeline-driven update: `time` is the playhead position in seconds. */
  update(dt) {
    const timeline = this.store.get('timeline', {});
    const playing = timeline.playing;
    if (playing) this.elapsed += dt * (timeline.speed ?? 1);
    const duration = timeline.duration || this.totalDuration;
    if (playing && this.elapsed > duration) {
      if (timeline.loop === false) {
        this.elapsed = duration;
        this.store.set('timeline.playing', false);
      } else {
        this.elapsed %= duration;
      }
    }
    const t = playing ? this.elapsed : timeline.time ?? 0;

    for (const entry of this.mixers.values()) {
      const wantsToRun = entry.actions.some((a) => a.isRunning());
      if (!wantsToRun && playing) {
        for (const action of entry.actions) {
          action.reset().play();
        }
      }
      if (!playing) {
        for (const action of entry.actions) action.paused = true;
        // manual scrub: set exact local time
        entry.mixer.setTime(t % Math.max(entry.clips[0]?.duration || 1, 0.0001));
        continue;
      }
      for (const action of entry.actions) {
        action.paused = false;
        action.timeScale = timeline.speed ?? 1;
      }
      entry.mixer.update(dt);
    }

    if (playing) {
      const storeTime = this.store.get('timeline.time');
      if (Math.abs(storeTime - this.elapsed) > 0.02) this.store.set('timeline.time', this.elapsed);
    }
    return t;
  }

  seek(time) {
    this.elapsed = Math.max(0, time);
    this.store.set('timeline.time', this.elapsed);
  }

  play() {
    this.store.set('timeline.playing', true);
  }

  pause() {
    this.store.set('timeline.playing', false);
  }

  toggle() {
    this.store.set('timeline.playing', !this.store.get('timeline.playing'));
  }

  /** Auto-built tracks for the timeline, derived from asset clips. */
  deriveTracks() {
    const tracks = [];
    for (const [nodeId, entry] of this.mixers) {
      entry.clips.forEach((clip, index) => {
        tracks.push({
          id: `${nodeId}:${index}`,
          nodeId,
          clipIndex: index,
          name: clip.name || `Clip ${index + 1}`,
          start: 0,
          duration: clip.duration,
          color: colorForString(nodeId),
        });
      });
    }
    return tracks;
  }
}

const palette = ['#6ea8fe', '#5eead4', '#f0883e', '#a78bfa', '#f472b6', '#facc15'];
export function colorForString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

export function createVfxNode({ shaderRecord, preset = null }) {
  return {
    kind: 'vfx',
    name: shaderRecord?.name || preset?.name || 'VFX',
    vfx: {
      shaderId: shaderRecord?.id || null,
      geometry: preset?.geometry || 'plane',
      segments: 32,
      billboard: preset?.billboard ?? false,
      opacity: 1,
      scale: 1,
      uniforms: {},
    },
  };
}

export { uid };
