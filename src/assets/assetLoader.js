/**
 * Asset loading pipeline.
 *
 * Two rules keep this fast and bug-free with huge uploads:
 *  1. Bytes go through a Blob URL session (`Session`) — loaders never see a
 *     giant string, and textures are streamed from disk.
 *  2. Every import is cancellable and reports progress, so dropping a 1 GB
 *     FBX doesn't freeze the UI or leak a half-built scene.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { basename, dirname, extensionOf, normalizePath, stem } from '../core/paths.js';

const DECODER_BASE = new URL(
  typeof document !== 'undefined' ? 'decoders/' : './decoders/',
  document?.baseURI || 'http://localhost/',
).href;

/** One import session: blob URLs for a virtual file system, revoked at the end. */
export class Session {
  constructor() {
    this.urls = new Map(); // virtual path → object URL
    this.files = new Map(); // virtual path → { blob, path }
    this.blobUrls = new Set();
  }

  add(path, blob) {
    const clean = normalizePath(path);
    this.files.set(clean, { path: clean, blob, size: blob.size, type: blob.type });
    return clean;
  }

  has(path) {
    return this.files.has(normalizePath(path));
  }

  get(path) {
    return this.files.get(normalizePath(path));
  }

  url(path, { relativeTo = null } = {}) {
    const resolved = relativeTo ? resolveRelative(relativeTo, path) : normalizePath(path);
    if (this.urls.has(resolved)) return this.urls.get(resolved);
    const file = this.files.get(resolved);
    if (!file) return null;
    const url = URL.createObjectURL(file.blob);
    this.urls.set(resolved, url);
    this.blobUrls.add(url);
    return url;
  }

  list() {
    return [...this.files.values()];
  }

  /** A three.js LoadingManager that redirects every request into the session. */
  manager(onProgress) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url || /^(data:|file:)/i.test(url)) return url;

      let lookupUrl = url;
      if (/^blob:/i.test(url)) {
        if (this.blobUrls.has(url)) return url;
        if (typeof document === 'undefined') return url;
        try {
          const base = new URL(document.baseURI);
          const inner = new URL(url.slice(5), base);
          if (inner.origin !== base.origin) return url;
          lookupUrl = inner.pathname;
        } catch {
          return url;
        }
      } else if (/^https?:/i.test(url)) {
        if (typeof document === 'undefined') return url;
        try {
          const base = new URL(document.baseURI);
          const resolved = new URL(url, base);
          if (resolved.origin !== base.origin) return url;
          lookupUrl = resolved.pathname;
        } catch {
          return url;
        }
      }

      const clean = normalizePath(decodeURIComponent(lookupUrl).replace(/^(\.\/)+/, ''));
      if (this.urls.has(clean)) return this.urls.get(clean);
      const file = this.files.get(clean);
      if (file) {
        const objectUrl = URL.createObjectURL(file.blob);
        this.urls.set(clean, objectUrl);
        this.blobUrls.add(objectUrl);
        return objectUrl;
      }
      const byName = [...this.files.values()].find((f) => f.path.endsWith(`/${clean}`) || basename(f.path) === basename(clean));
      if (byName) {
        const objectUrl = URL.createObjectURL(byName.blob);
        this.urls.set(clean, objectUrl);
        this.urls.set(byName.path, objectUrl);
        this.blobUrls.add(objectUrl);
        return objectUrl;
      }
      return url;
    });
    if (onProgress) {
      manager.onProgress = (url, loaded, total) => onProgress({ url, loaded, total });
    }
    return manager;
  }

  dispose() {
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    this.urls.clear();
    this.files.clear();
  }
}

export function resolveRelative(base, path) {
  if (/^(blob:|data:|https?:)/i.test(path)) return path;
  const dir = dirname(normalizePath(base));
  const parts = `${dir}/${path}`.split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/* ------------------------------------------------------------------ */
/* Shared loaders (expensive to construct, created lazily)            */
/* ------------------------------------------------------------------ */

let shared = null;

export function getSharedLoaders(renderer) {
  if (!shared) {
    shared = {};
    shared.draco = new DRACOLoader().setDecoderPath(`${DECODER_BASE}draco/`);
    shared.ktx2 = renderer ? new KTX2Loader().setTranscoderPath(`${DECODER_BASE}basis/`) : null;
    if (shared.ktx2) shared.ktx2.detectSupport(renderer);
  } else if (renderer && !shared.ktx2) {
    shared.ktx2 = new KTX2Loader().setTranscoderPath(`${DECODER_BASE}basis/`);
    shared.ktx2.detectSupport(renderer);
  }
  return shared;
}

export function disposeSharedLoaders() {
  if (!shared) return;
  shared.draco?.dispose();
  shared.ktx2?.dispose();
  shared = null;
}

/* ------------------------------------------------------------------ */
/* Result normalisation                                               */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} AssetData
 * @property {THREE.Group} object
 * @property {Array} animations
 * @property {Array<{id:string,name:string,meshNames:string[],procedural:boolean}>} materials
 * @property {Object} stats
 */

export function normalizeResult(root, { format, path, animations = [] }) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      if (!child.name) child.name = 'Mesh';
      ensureVertexAttributes(child);
    }
  });

  const materials = [];
  const seen = new Map();
  root.traverse((child) => {
    if (!child.isMesh) return;
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of list) {
      if (!mat) continue;
      let record = seen.get(mat.uuid);
      if (!record) {
        const id = `mat_${materials.length}_${mat.uuid.slice(0, 8)}`;
        record = { id, uuid: mat.uuid, name: mat.name || `Material ${materials.length + 1}`, meshNames: [], material: mat };
        seen.set(mat.uuid, record);
        materials.push(record);
      }
      if (child.name && !record.meshNames.includes(child.name)) record.meshNames.push(child.name);
      child.userData.materialId = record.id;
    }
  });

  let triangles = 0;
  let vertices = 0;
  let meshes = 0;
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    meshes += 1;
    const geo = child.geometry;
    const pos = geo.getAttribute('position');
    vertices += pos ? pos.count : 0;
    const index = geo.getIndex();
    triangles += index ? index.count / 3 : (pos ? pos.count / 3 : 0);
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (!Number.isFinite(size.x)) size.set(0, 0, 0);

  return {
    object: root,
    animations,
    materials,
    format,
    path,
    stats: {
      meshes,
      triangles: Math.round(triangles),
      vertices,
      materials: materials.length,
      animations: animations.length,
      size: size.toArray().map((v) => Math.round(v * 1000) / 1000),
      center: center.toArray().map((v) => Math.round(v * 1000) / 1000),
    },
  };
}

/** Shared geometry fixups: aoMap needs uv2, and shadows need normals. */
export function ensureVertexAttributes(mesh) {
  const geo = mesh.geometry;
  if (!geo) return;
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv') && geo.getAttribute('uv1')) geo.setAttribute('uv', geo.getAttribute('uv1'));
  if (geo.getAttribute('uv') && !geo.getAttribute('uv2') && geo.getAttribute('uv1')) {
    geo.setAttribute('uv2', geo.getAttribute('uv1'));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.computeBoundingSphere?.();
}

/* ------------------------------------------------------------------ */
/* Loaders per format                                                 */
/* ------------------------------------------------------------------ */

export async function loadAsset({ path, blob, format, renderer, signal, onProgress, session: suppliedSession = null }) {
  const ext = (format || extensionOf(path)).toLowerCase();
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');

  const ownsSession = !suppliedSession;
  const session = suppliedSession || new Session();
  if (blob && !session.has(path)) session.add(path, blob);

  try {
    let asset;
    switch (ext) {
      case 'glb':
      case 'gltf':
        asset = await loadGLTF({ path, session, renderer, onProgress });
        break;
      case 'fbx':
        asset = await loadFBX({ path, session });
        break;
      case 'obj':
        asset = await loadOBJ({ path, session });
        break;
      case 'stl':
        asset = await loadSTL({ path, blob });
        break;
      case 'ply':
        asset = await loadPLY({ path, blob });
        break;
      case 'dae':
        asset = await loadCollada({ path, session });
        break;
      case '3mf':
        asset = await load3MF({ path, blob });
        break;
      default:
        throw new Error(`Unsupported 3D format ".${ext}". Try GLB, FBX, OBJ, STL, PLY, DAE or 3MF.`);
    }
    if (signal?.aborted) {
      disposeObject(asset.object);
      throw new DOMException('Import cancelled', 'AbortError');
    }
    return asset;
  } finally {
    if (ownsSession) session.dispose();
  }
}

async function loadGLTF({ path, session, renderer, onProgress }) {
  const manager = session.manager(onProgress);
  const loader = new GLTFLoader(manager);
  const sharedLoaders = getSharedLoaders(renderer);
  loader.setDRACOLoader(sharedLoaders.draco);
  if (sharedLoaders.ktx2) loader.setKTX2Loader(sharedLoaders.ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);

  const url = session.url(path);
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene || gltf.scenes?.[0];
  if (!root) throw new Error('The glTF file contains no scene.');
  const animations = gltf.animations || [];
  const result = normalizeResult(root, { format: 'gltf', path, animations });
  result.gltf = gltf;
  return result;
}

async function loadFBX({ path, session }) {
  const loader = new FBXLoader(session.manager());
  const url = session.url(path);
  const root = await loader.loadAsync(url);
  const animations = root.animations || [];
  const result = normalizeResult(root, { format: 'fbx', path, animations });
  return result;
}

async function loadOBJ({ path, session }) {
  const manager = session.manager();
  const mtlFile = [...session.files.values()].find(
    (f) => f.path.toLowerCase().endsWith('.mtl') && dirname(f.path) === dirname(normalizePath(path)),
  );
  let root;
  if (mtlFile) {
    const mtlLoader = new MTLLoader(manager);
    mtlLoader.setResourcePath('');
    const materialsCreator = await mtlLoader.loadAsync(session.url(mtlFile.path));
    materialsCreator.preload();
    const objLoader = new OBJLoader(manager);
    objLoader.setMaterials(materialsCreator);
    root = await objLoader.loadAsync(session.url(path));
  } else {
    root = await new OBJLoader(manager).loadAsync(session.url(path));
  }
  return normalizeResult(root, { format: 'obj', path, animations: [] });
}

async function loadSTL({ path, blob }) {
  const buffer = await blob.arrayBuffer();
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc9d4e6, roughness: 0.5, metalness: 0.1 }));
  mesh.name = stem(path);
  const group = new THREE.Group();
  group.add(mesh);
  return normalizeResult(group, { format: 'stl', path });
}

async function loadPLY({ path, blob }) {
  const buffer = await blob.arrayBuffer();
  const geometry = new PLYLoader().parse(buffer);
  geometry.computeVertexNormals();
  const hasColor = Boolean(geometry.getAttribute('color'));
  const material = new THREE.MeshStandardMaterial({
    color: hasColor ? 0xffffff : 0xc9d4e6,
    vertexColors: hasColor,
    roughness: 0.6,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = stem(path);
  const group = new THREE.Group();
  group.add(mesh);
  return normalizeResult(group, { format: 'ply', path });
}

async function loadCollada({ path, session }) {
  const loader = new ColladaLoader(session.manager());
  const collada = await loader.loadAsync(session.url(path));
  const root = collada.scene;
  const result = normalizeResult(root, { format: 'dae', path, animations: collada.animations || [] });
  return result;
}

async function load3MF({ path, blob }) {
  const buffer = await blob.arrayBuffer();
  const root = new ThreeMFLoader().parse(buffer);
  return normalizeResult(root, { format: '3mf', path });
}

/* ------------------------------------------------------------------ */
/* Textures                                                           */
/* ------------------------------------------------------------------ */

const textureLoader = new THREE.TextureLoader();

export async function loadTextureBlob({ path, blob, colorSpace = 'srgb', renderer, stripCache = new Map() }) {
  const ext = extensionOf(path);
  if (ext === 'ktx2' || ext === 'basis') {
    const sharedLoaders = getSharedLoaders(renderer);
    if (!sharedLoaders.ktx2) throw new Error('KTX2 textures need WebGL2 and a renderer.');
    const url = URL.createObjectURL(blob);
    try {
      return await sharedLoaders.ktx2.loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (ext === 'tga') {
    const url = URL.createObjectURL(blob);
    let texture;
    try {
      texture = await new TGALoader().loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    texture.colorSpace = colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return texture;
  }
  if (ext === 'hdr') {
    const url = URL.createObjectURL(blob);
    let texture;
    try {
      texture = await new RGBELoader().loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  }
  if (ext === 'exr') {
    const url = URL.createObjectURL(blob);
    let texture;
    try {
      texture = await new EXRLoader().loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  }

  const url = URL.createObjectURL(blob);
  try {
    const texture = await textureLoader.loadAsync(url);
    texture.colorSpace = colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = 8;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Renders a preview thumbnail of an object to a data URL (cached by caller). */
export function thumbnailFor(object3D, { size = 192, background = null } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  if (background) scene.background = new THREE.Color(background);
  const clone = object3D.clone(true);
  scene.add(clone);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);

  const box = new THREE.Box3().setFromObject(clone);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const dist = sphere.radius / Math.sin((35 * Math.PI) / 360) * 1.25;
  camera.position.copy(sphere.center).add(new THREE.Vector3(0.7, 0.55, 1).normalize().multiplyScalar(dist));
  camera.lookAt(sphere.center);

  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  return url;
}

export function disposeObject(root) {
  root.traverse?.((child) => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    for (const mat of materials) {
      for (const key of Object.keys(mat)) {
        const value = mat[key];
        if (value && value.isTexture) value.dispose?.();
      }
      mat.dispose?.();
    }
  });
}

export { normalizePath };
