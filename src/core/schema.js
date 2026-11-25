/**
 * The whole scene document schema + defaults.
 *
 * One plain JSON object. Everything (undo, autosave, export, import) works off
 * this and nothing else, so there is exactly one source of truth.
 */
import { uid } from './util.js';

export const APP_NAME = 'Atlas Scene Studio';
export const SCHEMA_VERSION = 1;

export const DEFAULT_RENDER = {
  ambient: 0.5,
  exposure: 0.98,
  toneMapping: 'ACESFilmic',
  shadows: true,
  softShadows: false,
  pixelRatioCap: 2,
  msaa: true,
  antialias: 'smaa',
  bloom: { enabled: false, strength: 0.55, radius: 0.45, threshold: 0.82 },
  vignette: { enabled: false, amount: 0.35, softness: 0.6 },
  film: { enabled: false, grain: 0.12, scanlines: 0.0, contrast: 1.0, saturation: 1.0 },
  ssao: { enabled: false, radius: 0.22, intensity: 0.8 },
  fog: { enabled: false, color: '#0b1020', near: 8, far: 40 },
  dof: { enabled: false, focus: 6, aperture: 0.008, maxblur: 0.006 },
};

export const DEFAULT_CAMERA = {
  type: 'perspective',
  fov: 45,
  position: [6.5, 4.2, 8.5],
  target: [0, 0.9, 0],
  near: 0.05,
  far: 800,
  orthoHeight: 6,
};

export const DEFAULT_POST = { hdr: true };

export const GRID_ENV_THEMES = {
  night: {
    id: 'night',
    label: 'Midnight',
    background: 'gradient',
    sky: ['#0a0f1c', '#131d33', '#1a2744'],
    ground: '#0d1424',
    grid: '#2b3a5a',
    gridMajor: '#3d5177',
    ambient: '#7f9bd6',
    keyColor: '#ffe6c7',
    keyIntensity: 2.4,
    rimColor: '#5f9dff',
    rimIntensity: 1.1,
    fillColor: '#334b7a',
    fillIntensity: 0.55,
  },
  studio: {
    id: 'studio',
    label: 'Soft Studio',
    background: 'solid',
    sky: ['#2b2f37', '#23262c', '#1b1e23'],
    ground: '#23262c',
    grid: '#3a3f49',
    gridMajor: '#565d6b',
    ambient: '#cfd8e6',
    keyColor: '#ffffff',
    keyIntensity: 2.9,
    rimColor: '#dbe6ff',
    rimIntensity: 1.4,
    fillColor: '#8a94a6',
    fillIntensity: 0.9,
  },
  dawn: {
    id: 'dawn',
    label: 'Golden Hour',
    background: 'gradient',
    sky: ['#f9c9a0', '#e79a86', '#8b6a9c'],
    ground: '#3a2a3e',
    grid: '#6b4a5a',
    gridMajor: '#8a6273',
    ambient: '#ffd9bd',
    keyColor: '#ffd2a1',
    keyIntensity: 3.1,
    rimColor: '#ff9c6e',
    rimIntensity: 1.6,
    fillColor: '#7d6a9c',
    fillIntensity: 0.8,
  },
  mint: {
    id: 'mint',
    label: 'Mint Lab',
    background: 'gradient',
    sky: ['#0f2b28', '#123a34', '#17493f'],
    ground: '#102420',
    grid: '#1f4a42',
    gridMajor: '#2c6759',
    ambient: '#a8f0dc',
    keyColor: '#eafff6',
    keyIntensity: 2.6,
    rimColor: '#43d6a8',
    rimIntensity: 1.3,
    fillColor: '#2a6d5e',
    fillIntensity: 0.7,
  },
  paper: {
    id: 'paper',
    label: 'Paper White',
    background: 'solid',
    sky: ['#f7f8fa', '#eff1f5', '#e6e9ef'],
    ground: '#eef0f4',
    grid: '#d3d8e2',
    gridMajor: '#bfc6d4',
    ambient: '#ffffff',
    keyColor: '#ffffff',
    keyIntensity: 2.2,
    rimColor: '#dfe6f5',
    rimIntensity: 0.8,
    fillColor: '#c7d0e0',
    fillIntensity: 0.8,
  },
};

export const DEFAULT_ENVIRONMENT = {
  theme: 'night',
  showGrid: true,
  showBackground: true,
  environmentIntensity: 0.62,
  keyIntensity: 2.05,
  keyColor: '#ffe6c7',
  rimIntensity: 0.95,
  rimColor: '#5f9dff',
  fillIntensity: 0.5,
  fillColor: '#334b7a',
  ambientColor: '#7f9bd6',
  ambientIntensity: 0.5,
  contactShadows: true,
  sunAzimuth: 40,
  sunElevation: 48,
};

export const DEFAULT_SNAP = {
  translate: 0.25,
  rotate: Math.PI / 12,
  scale: 0.1,
  enabled: true,
};

export const DEFAULT_SHOT = {
  width: 1920,
  height: 1080,
  scale: 1,
  format: 'png',
  quality: 0.94,
  transparent: false,
  shadow: 'soft',
  frame: true,
  grid: false,
  watermark: '',
  focalLength: 50,
  aspectPreset: '16:9',
};

export function createObjectNode(partial = {}) {
  return {
    id: partial.id || uid('obj'),
    name: partial.name || 'Object',
    kind: partial.kind || 'mesh', // mesh | group | light | vfx | billboard | camera | model
    assetId: partial.assetId || null,
    parentId: partial.parentId || null,
    visible: partial.visible !== false,
    locked: Boolean(partial.locked),
    position: partial.position || [0, 0, 0],
    rotation: partial.rotation || [0, 0, 0],
    scale: partial.scale || [1, 1, 1],
    material: partial.material || null,
    vfx: partial.vfx || null,
    billboard: partial.billboard || null,
    light: partial.light || null,
    animations: partial.animations || [],
    clips: partial.clips || [],
    meta: partial.meta || {},
  };
}

export function createInitialState() {
  return {
    meta: {
      name: 'Untitled Scene',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      version: SCHEMA_VERSION,
      app: APP_NAME,
    },
    assets: [], // AssetManifest entries
    objects: [],
    materials: {}, // materialId → material record
    selection: [],
    camera: { ...DEFAULT_CAMERA },
    render: structuredCloneSafe(DEFAULT_RENDER),
    environment: { ...DEFAULT_ENVIRONMENT },
    snap: { ...DEFAULT_SNAP },
    shot: { ...DEFAULT_SHOT },
    ui: {
      leftWidth: 288,
      rightWidth: 336,
      bottomHeight: 232,
      leftTab: 'assets',
      rightTab: 'inspector',
      bottomTab: 'timeline',
      theme: 'dark',
      accent: 'aurora',
      highContrast: false,
      showStats: false,
      space: '3d',
      gizmoMode: 'translate',
      gizmoSpace: 'world',
      sidebarCollapsed: false,
      focusMode: false,
      beginnerMode: false,
      onboardingSeen: false,
    },
    timeline: {
      time: 0,
      playing: false,
      loop: true,
      speed: 1,
      duration: 12,
      tracks: [],
      activeClip: null,
    },
    lighting: { presetId: null, customShaders: [] },
    vfx: [],
    history: [],
    stats: { drawCalls: 0, triangles: 0, textures: 0, geometries: 0, fps: 0, gpuMemory: 0 },
  };
}

export function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export const MATERIAL_DEFAULTS = {
  baseColor: '#c9d4e6',
  metalness: 0.08,
  roughness: 0.55,
  emissive: '#000000',
  emissiveIntensity: 0,
  opacity: 1,
  transparent: false,
  clearcoat: 0,
  clearcoatRoughness: 0.1,
  transmission: 0,
  ior: 1.5,
  sheen: 0,
  sheenColor: '#ffffff',
  iridescence: 0,
  flatShading: false,
  doubleSided: false,
  wireframe: false,
  aoMapIntensity: 1,
  displacementScale: 0.05,
  bumpScale: 0.02,
  normalScale: 1,
  envMapIntensity: 1,
  textures: {},
  // node-graph-ish shader tweak
  customShaderId: null,
};

export const LIGHT_PRESETS = {
  'three-point': { name: 'Three Point', key: { intensity: 2.6, color: '#fff3e2' }, fill: { intensity: 0.7, color: '#9fc0ff' }, rim: { intensity: 1.4, color: '#ffd8a8' } },
  'softbox': { name: 'Softbox', key: { intensity: 2.1, color: '#ffffff' }, fill: { intensity: 1.2, color: '#dfe8ff' }, rim: { intensity: 0.9, color: '#ffffff' } },
  'dramatic': { name: 'Dramatic', key: { intensity: 3.4, color: '#ffe0b0' }, fill: { intensity: 0.2, color: '#3c5aa6' }, rim: { intensity: 2.1, color: '#7fb2ff' } },
  'neutral': { name: 'Neutral', key: { intensity: 2.2, color: '#ffffff' }, fill: { intensity: 0.9, color: '#c8d4e6' }, rim: { intensity: 1.0, color: '#ffffff' } },
  'neon': { name: 'Neon Night', key: { intensity: 2.2, color: '#ff3d9a' }, fill: { intensity: 0.8, color: '#2ad8ff' }, rim: { intensity: 1.8, color: '#8b5cf6' } },
};

export const SCENE_TEMPLATES = [
  {
    id: 'empty',
    name: 'Empty Space',
    description: 'A clean grid and three-point lighting. Start from nothing.',
    icon: 'blank',
  },
  {
    id: 'showcase',
    name: 'Product Showcase',
    description: 'Pedestal, soft studio lighting and a subtle contact shadow.',
    icon: 'pedestal',
  },
  {
    id: 'cinematic',
    name: 'Cinematic Set',
    description: 'Volumetric fog, strong rim light and an anamorphic feel.',
    icon: 'film',
  },
  {
    id: 'turntable',
    name: 'Turntable',
    description: 'Centre-stage prop with a looping 360° turntable animation.',
    icon: 'turntable',
  },
];
