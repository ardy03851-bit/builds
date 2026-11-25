/**
 * Engine: renderer, scene graph, camera, lights, post-processing, picking.
 *
 * Design notes
 *  - The store is the source of truth; the engine *listens* and syncs.
 *    That means undo/redo, undo of a drag, and project load all just work.
 *  - Everything heavy is pooled or cached; nothing allocates per frame.
 *  - Post FX lives in one composer, rebuilt only when the chain changes.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GRID_ENV_THEMES } from '../core/schema.js';
import { clamp } from '../core/util.js';

const TONE_MAPPINGS = {
  ACESFilmic: THREE.ACESFilmicToneMapping,
  AgX: THREE.AgXToneMapping,
  Neutral: THREE.NeutralToneMapping,
  Linear: THREE.LinearToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon: THREE.CineonToneMapping,
  None: THREE.NoToneMapping,
};

const FILM_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uGrain: { value: 0.0 },
    uScanlines: { value: 0.0 },
    uContrast: { value: 1.0 },
    uSaturation: { value: 1.0 },
    uTime: { value: 0 },
    uVignette: { value: 0.0 },
    uVignetteSoft: { value: 0.6 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uGrain;
    uniform float uScanlines;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTime;
    uniform float uVignette;
    uniform float uVignetteSoft;
    varying vec2 vUv;
    float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      // saturation
      float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      color.rgb = mix(vec3(luma), color.rgb, uSaturation);
      // contrast
      color.rgb = (color.rgb - 0.5) * uContrast + 0.5;
      // film grain
      float g = (rand(vUv * vec2(1920.0, 1080.0) + uTime) - 0.5) * uGrain;
      color.rgb += g;
      // scanlines
      color.rgb *= 1.0 - uScanlines * (0.5 + 0.5 * sin(vUv.y * 1200.0));
      // vignette
      float d = distance(vUv, vec2(0.5));
      color.rgb *= 1.0 - uVignette * smoothstep(0.25, uVignetteSoft, d);
      gl_FragColor = clamp(color, 0.0, 1.0);
    }
  `,
};

export class Engine {
  constructor(container, store, options = {}) {
    this.container = container;
    this.modalRoot = document.getElementById('modal-root');
    this.store = store;
    this.onSelect = options.onSelect || (() => {});
    this.onStats = options.onStats || (() => {});
    this.onFrame = options.onFrame || (() => {});
    this.onPickHover = options.onPickHover || (() => {});

    this.timer = new THREE.Timer();
    this.timer.connect(document);
    this.elapsed = 0;
    this.disposed = false;
    this.objectMap = new Map(); // id → THREE.Object3D root for that node
    this.nodeByObject = new WeakMap();
    this.materialCache = new Map();
    this.textureCache = new Map();
    this.helpers = new THREE.Group();
    this.helpers.name = '__helpers';
    this.selectionBox = new THREE.Box3();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDownAt = 0;
    this.pointerDownPos = { x: 0, y: 0 };
    this.hoverThrottle = 0;
    this.frameCount = 0;
    this.fpsWindow = [];
    this.adaptiveScale = 1;
    this.contextLost = false;

    this._initRenderer();
    this._initScene();
    this._initControls();
    this._initPost();
    this._bindEvents();

    this.store.subscribe(() => this.syncFromStore(), 'objects');
    this.store.subscribe(() => this.syncSelection(), 'selection');
    this.store.subscribe(() => this.applyRenderSettings(), 'render');
    this.store.subscribe(() => this.applyEnvironment(), 'environment');
    this.store.subscribe(() => this.applyCamera(), 'camera');
    this.store.subscribe(() => this.syncTimeline(), 'timeline');

    this.syncFromStore();
    this.applyRenderSettings();
    this.applyEnvironment();
    this.applyCamera();
    this.syncSelection();

    this.animate = this.animate.bind(this);
    this._rafId = requestAnimationFrame(this.animate);
  }

  /* ------------------------------------------------------------------ */
  /* bootstrap                                                          */
  /* ------------------------------------------------------------------ */

  _initRenderer() {
    const canvas = document.createElement('canvas');
    canvas.className = 'viewport-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '3D viewport. Drag to orbit, scroll to zoom.');
    this.container.appendChild(canvas);
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // needed for deterministic screenshots
      stencil: false,
      depth: true,
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    // Use the faster default filter; the optional soft-shadow setting can opt in to PCFSoft later.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
    this.renderer = renderer;

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      console.warn('[engine] WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.rebuildEverything();
    });
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.add(this.helpers);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 800);
    this.camera.position.set(6.5, 4.2, 8.5);

    this.root = new THREE.Group();
    this.root.name = 'scene-root';
    this.scene.add(this.root);

    this.gizmoRoot = new THREE.Group();
    this.gizmoRoot.name = 'gizmos';
    this.scene.add(this.gizmoRoot);

    // Lighting rig
    this.lighting = new THREE.Group();
    this.lighting.name = 'lighting-rig';
    this.scene.add(this.lighting);

    this.ambient = new THREE.HemisphereLight(0x7f9bd6, 0x0a0f1c, 0.65);
    this.scene.add(this.ambient);

    this.key = new THREE.DirectionalLight(0xffe6c7, 2.4);
    this.key.position.set(5, 8, 6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 0.5;
    this.key.shadow.camera.far = 60;
    this.key.shadow.camera.left = -14;
    this.key.shadow.camera.right = 14;
    this.key.shadow.camera.top = 14;
    this.key.shadow.camera.bottom = -14;
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.02;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    this.rim = new THREE.DirectionalLight(0x5f9dff, 1.1);
    this.rim.position.set(-6, 4.5, -7);
    this.scene.add(this.rim);

    this.fill = new THREE.DirectionalLight(0x334b7a, 0.55);
    this.fill.position.set(-4, 2, 6);
    this.scene.add(this.fill);

    // Grid
    this.grid = new THREE.GridHelper(40, 40, 0x3d5177, 0x2b3a5a);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.grid.material.depthWrite = false;
    this.grid.position.y = 0.001;
    this.gizmoRoot.add(this.grid);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.28, transparent: true, depthWrite: false }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.name = '__ground';
    this.scene.add(this.ground);

    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(60, 64),
      new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.94, metalness: 0.05, transparent: true, opacity: 0.86 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.002;
    this.floor.receiveShadow = true;
    this.floor.name = '__floor';
    this.scene.add(this.floor);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    this.pmrem = pmrem;
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;

    this.selectionOutline = new THREE.Box3Helper(this.selectionBox, 0x6ea8ff);
    this.selectionOutline.material.transparent = true;
    this.selectionOutline.material.opacity = 0.85;
    this.selectionOutline.material.depthTest = false;
    this.selectionOutline.renderOrder = 999;
    this.selectionOutline.visible = false;
    this.gizmoRoot.add(this.selectionOutline);

    // Billboard (HTML) layers are plain DOM overlays in the viewport; engine
    // only needs to project anchors, see `projectPoint`.
    this.pixelRatio = 1;
  }

  _initControls() {
    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.075;
    this.orbit.rotateSpeed = 0.85;
    this.orbit.zoomSpeed = 0.9;
    this.orbit.panSpeed = 0.9;
    this.orbit.screenSpacePanning = true;
    this.orbit.minDistance = 0.15;
    this.orbit.maxDistance = 400;
    this.orbit.maxPolarAngle = Math.PI * 0.995;
    this.orbit.target.set(0, 0.9, 0);
    this.orbit.addEventListener('change', () => this.persistCameraThrottled?.());

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(0.92);
    this.transform.addEventListener('dragging-changed', (event) => {
      this.orbit.enabled = !event.value;
      if (event.value) {
        this.dragStartState = this.store.snapshot().objects.find((o) => o.id === this.store.get('selection.0'));
        this.onDragStart?.();
      } else {
        this.onDragEnd?.();
        this.writeTransformToStore();
      }
    });
    this.transform.addEventListener('objectChange', () => {
      this.onTransformChange?.();
      this.updateSelectionOutline();
    });
    this.transform.addEventListener('mouseDown', () => this.orbit.enabled = false);
    this.transform.addEventListener('mouseUp', () => this.orbit.enabled = true);
    this.transformHelper = this.transform.getHelper();
    this.gizmoRoot.add(this.transformHelper);

    this.persistCameraThrottled = null;
  }

  _initPost() {
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;
    this.filmPass = null;
    this._composerKey = '';
  }

  _bindEvents() {
    this._onPointerDown = (event) => {
      if (event.button === 0) {
        this.pointerDownAt = performance.now();
        this.pointerDownPos = { x: event.clientX, y: event.clientY };
      }
    };
    this._onPointerUp = (event) => {
      if (event.button !== 0) return;
      const dt = performance.now() - this.pointerDownAt;
      const moved = Math.hypot(event.clientX - this.pointerDownPos.x, event.clientY - this.pointerDownPos.y);
      if (dt > 450 || moved > 6) return;
      if (this.transform.dragging) return;
      const hit = this.pick(event.clientX, event.clientY);
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      this.onSelect(hit ? hit.nodeId : null, { additive, type: hit?.type ?? null });
    };
    this._onPointerMove = (event) => {
      if (event.buttons) return;
      const now = performance.now();
      if (now - this.hoverThrottle < 45) return;
      this.hoverThrottle = now;
      const hit = this.pick(event.clientX, event.clientY);
      this.canvas.style.cursor = hit ? 'pointer' : '';
      this.onPickHover(hit);
    };
    this._onContextLost = () => {};

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerleave', () => this.onPickHover(null));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.container);
    this.resize();
  }

  /* ------------------------------------------------------------------ */
  /* sizing                                                             */
  /* ------------------------------------------------------------------ */

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const cap = this.store.get('render.pixelRatioCap', 2) || 2;
    const ratio = Math.min(window.devicePixelRatio || 1, cap) * this.adaptiveScale;
    this.pixelRatio = ratio;
    this.width = width;
    this.height = height;

    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.updateOrthoFrustum();
    this.camera.updateProjectionMatrix();

    if (this.composer) {
      this.composer.setPixelRatio(ratio);
      this.composer.setSize(width, height);
    }
  }

  updateOrthoFrustum() {
    if (!this.orthoCamera) return;
    const h = this.store.get('camera.orthoHeight', 6);
    const aspect = this.width / this.height;
    this.orthoCamera.left = (-h * aspect) / 2;
    this.orthoCamera.right = (h * aspect) / 2;
    this.orthoCamera.top = h / 2;
    this.orthoCamera.bottom = -h / 2;
    this.orthoCamera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------------ */
  /* store → scene                                                      */
  /* ------------------------------------------------------------------ */

  syncFromStore() {
    const objects = this.store.get('objects', []);
    const seen = new Set();

    // Create every transform group first so a child may safely appear before
    // its parent in imported or manually reordered scene data.
    for (const node of objects) {
      seen.add(node.id);
      let group = this.objectMap.get(node.id);
      if (!group) {
        group = new THREE.Group();
        group.name = node.name;
        group.userData.nodeId = node.id;
        this.objectMap.set(node.id, group);
        this.nodeByObject.set(group, node.id);
      }
    }

    for (const node of objects) {
      const group = this.objectMap.get(node.id);
      const parent = node.parentId ? this.objectMap.get(node.parentId) : null;
      let target = parent || this.root;
      // A malformed project can contain a parent cycle. Break that edge at the
      // root instead of creating an invalid Three.js object hierarchy.
      for (let cursor = target; cursor; cursor = cursor.parent) {
        if (cursor === group) {
          target = this.root;
          break;
        }
      }
      if (group.parent !== target) target.add(group);

      applyTransform(group, node);
      group.visible = node.visible !== false;
      group.name = node.name;

      if (!group.userData.built) this.buildNode(group, node);
      // Re-attach live content every sync — cheap, idempotent, and it means a
      // node whose object arrives asynchronously (import, project load) always
      // ends up in the right place without a second bookkeeping flag.
      this.onAttachNode?.(group, node);
      this.updateNode(group, node);
    }

    // remove stale
    for (const [id, group] of this.objectMap) {
      if (!seen.has(id)) {
        group.parent?.remove(group);
        disposeTree(group);
        this.objectMap.delete(id);
        this.nodeByObject.delete(group);
      }
    }

    // final ordering to match store order
    for (const node of objects) {
      const group = this.objectMap.get(node.id);
      if (group && !node.parentId) this.root.add(group);
    }
  }

  buildNode(group, node) {
    group.userData.built = true;
    if (node.kind === 'light') {
      const light = this.buildLight(node);
      if (light) group.add(light);
      return;
    }
    if (node.kind === 'vfx' || node.kind === 'billboard') {
      // VFX/billboard meshes are attached by their controllers.
      return;
    }
    // Models (imported or built-in primitives) are attached by the app on
    // every sync, which owns the live three.js instances for each node.
  }

  updateNode(group, node) {
    if (node.kind === 'light') {
      const light = group.children.find((c) => c.isLight);
      if (light && node.light) applyLight(light, node.light);
    }
  }

  buildLight(node) {
    const cfg = node.light || {};
    let light;
    switch (node.kind === 'light' ? cfg.type || 'directional' : cfg.type) {
      case 'point':
        light = new THREE.PointLight(cfg.color || '#ffffff', cfg.intensity ?? 10, cfg.distance ?? 0, cfg.decay ?? 2);
        break;
      case 'spot':
        light = new THREE.SpotLight(cfg.color || '#ffffff', cfg.intensity ?? 20, cfg.distance ?? 0, cfg.angle ?? 0.5, cfg.penumbra ?? 0.4, cfg.decay ?? 2);
        break;
      case 'area':
        light = new THREE.RectAreaLight(cfg.color || '#ffffff', cfg.intensity ?? 8, cfg.width ?? 2, cfg.height ?? 2);
        break;
      case 'ambient':
        light = new THREE.AmbientLight(cfg.color || '#ffffff', cfg.intensity ?? 0.5);
        break;
      default:
        light = new THREE.DirectionalLight(cfg.color || '#ffffff', cfg.intensity ?? 2);
    }
    light.castShadow = Boolean(cfg.castShadow);
    if (light.castShadow && 'shadow' in light) {
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.02;
    }
    applyLight(light, cfg);
    return light;
  }

  syncSelection() {
    const ids = this.store.get('selection', []);
    const first = ids[0];
    const group = first ? this.objectMap.get(first) : null;
    const node = first ? this.store.get('objects', []).find((o) => o.id === first) : null;

    // highlight every selected object
    this.clearSelectionHighlight();
    for (const id of ids) {
      const g = this.objectMap.get(id);
      if (g) highlightTree(g, true, this.nodeByObject.has(g) ? this.store.get('objects', []).find((o) => o.id === id) : null);
    }

    if (!group || node?.locked) {
      this.transform.detach();
      this.selectionOutline.visible = false;
      this.transformHelper.visible = false;
      return;
    }
    this.transformHelper.visible = true;
    this.transform.attach(group);
    this.transform.setMode(this.store.get('ui.gizmoMode', 'translate'));
    this.transform.setSpace(this.store.get('ui.gizmoSpace', 'world'));
    this.updateSelectionOutline();
  }

  clearSelectionHighlight() {
    for (const group of this.objectMap.values()) highlightTree(group, false);
  }

  updateSelectionOutline() {
    const ids = this.store.get('selection', []);
    if (!ids.length) {
      this.selectionOutline.visible = false;
      return;
    }
    const box = new THREE.Box3();
    let any = false;
    for (const id of ids) {
      const group = this.objectMap.get(id);
      if (!group) continue;
      const b = new THREE.Box3().setFromObject(group);
      if (Number.isFinite(b.min.x) && Number.isFinite(b.max.x)) {
        box.union(b);
        any = true;
      }
    }
    if (!any) {
      this.selectionOutline.visible = false;
      return;
    }
    this.selectionBox.copy(box);
    this.selectionOutline.visible = true;
    this.selectionOutline.material.color.set(ids.length > 1 ? 0xffc46b : 0x6ea8ff);
  }

  /** Reads the live gizmo transform back into the store (one history commit). */
  writeTransformToStore() {
    const ids = this.store.get('selection', []);
    const id = ids[0];
    if (!id) return;
    const group = this.objectMap.get(id);
    if (!group) return;
    const objects = this.store.get('objects', []).map((node) => {
      if (node.id !== id) return node;
      return {
        ...node,
        position: group.position.toArray().map(round6),
        rotation: [group.rotation.x, group.rotation.y, group.rotation.z].map(round6),
        scale: group.scale.toArray().map(round6),
      };
    });
    this.store.set('objects', objects);
    this.onTransformCommit?.();
  }

  /** Pushes store transforms back into the scene (undo, numeric fields). */
  syncTransforms() {
    const objects = this.store.get('objects', []);
    for (const node of objects) {
      const group = this.objectMap.get(node.id);
      if (!group) continue;
      if (this.transform?.dragging && this.store.get('selection.0') === node.id) continue;
      applyTransform(group, node);
    }
    this.updateSelectionOutline();
  }

  attachTransform() {
    this.syncSelection();
  }

  /* ------------------------------------------------------------------ */
  /* camera                                                             */
  /* ------------------------------------------------------------------ */

  applyCamera() {
    const cam = this.store.get('camera', {});
    const controls = this.orbit;
    if (!controls) return;

    if (cam.type === 'orthographic') {
      if (!this.orthoCamera) {
        const aspect = (this.width || 1) / (this.height || 1);
        const h = cam.orthoHeight || 6;
        this.orthoCamera = new THREE.OrthographicCamera((-h * aspect) / 2, (h * aspect) / 2, h / 2, -h / 2, cam.near, cam.far);
        this.orthoCamera.position.copy(this.camera.position);
        this.orthoCamera.quaternion.copy(this.camera.quaternion);
      }
      if (this.camera !== this.orthoCamera) {
        this.orthoCamera.position.copy(this.camera.position);
        this.orthoCamera.quaternion.copy(this.camera.quaternion);
        this.camera = this.orthoCamera;
        controls.object = this.camera;
        this.transform.camera = this.camera;
      }
      this.updateOrthoFrustum();
    } else {
      if (this.camera !== this.perspCamera) {
        this.perspCamera = this.perspCamera || new THREE.PerspectiveCamera(cam.fov || 45, (this.width || 1) / (this.height || 1), cam.near || 0.05, cam.far || 800);
        if (this.camera !== this.perspCamera) {
          this.perspCamera.position.copy(this.camera.position);
          this.perspCamera.quaternion.copy(this.camera.quaternion);
        }
        this.camera = this.perspCamera;
        controls.object = this.camera;
        this.transform.camera = this.camera;
      }
      this.camera.fov = cam.fov ?? 45;
      this.camera.near = cam.near ?? 0.05;
      this.camera.far = cam.far ?? 800;
      this.camera.aspect = (this.width || 1) / (this.height || 1);
      this.camera.updateProjectionMatrix();
    }

    if (this.initialCameraSet) return;
    this.setCameraPose(cam.position, cam.target);
    this.initialCameraSet = true;
  }

  setCameraPose(position, target) {
    if (position) this.camera.position.set(position[0], position[1], position[2]);
    if (target) this.orbit.target.set(target[0], target[1], target[2]);
    this.camera.lookAt(this.orbit.target);
    this.orbit.update();
  }

  /** Reads camera pose from the controls (used by the camera store sync). */
  currentPose() {
    return {
      position: this.camera.position.toArray().map(round6),
      target: this.orbit.target.toArray().map(round6),
    };
  }

  frameSelection(padding = 1.35) {
    const ids = this.store.get('selection', []);
    const box = new THREE.Box3();
    if (ids.length) {
      for (const id of ids) {
        const g = this.objectMap.get(id);
        if (g) box.union(new THREE.Box3().setFromObject(g));
      }
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(2, 2, 2));
    this.frameBox(box, padding);
  }

  frameBox(box, padding = 1.35) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 0.01);
    const fitHeightDistance = maxSize / (2 * Math.tan((Math.PI * this.camera.fov) / 360));
    const fitWidthDistance = fitHeightDistance / this.camera.aspect;
    const distance = padding * Math.max(fitHeightDistance, fitWidthDistance);

    const dir = new THREE.Vector3(0.75, 0.55, 1).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
    this.camera.near = Math.max(0.01, distance / 1000);
    this.camera.far = Math.max(200, distance * 20);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.persistCamera?.();
  }

  frameAll() {
    const box = new THREE.Box3();
    for (const group of this.objectMap.values()) {
      const b = new THREE.Box3().setFromObject(group);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(4, 2, 4));
    this.frameBox(box, 1.5);
  }

  /* ------------------------------------------------------------------ */
  /* environment / render                                               */
  /* ------------------------------------------------------------------ */

  applyEnvironment() {
    const env = this.store.get('environment', {});
    const theme = GRID_ENV_THEMES[env.theme] || GRID_ENV_THEMES.night;

    this.ambient.color.set(env.ambientColor || theme.ambient);
    this.ambient.groundColor.set(theme.ground);
    this.ambient.intensity = env.ambientIntensity ?? 0.65;

    this.key.color.set(env.keyColor || theme.keyColor);
    this.key.intensity = env.keyIntensity ?? theme.keyIntensity;
    this.rim.color.set(env.rimColor || theme.rimColor);
    this.rim.intensity = env.rimIntensity ?? theme.rimIntensity;
    this.fill.color.set(env.fillColor || theme.fillColor);
    this.fill.intensity = env.fillIntensity ?? theme.fillIntensity;

    const az = THREE.MathUtils.degToRad(env.sunAzimuth ?? 40);
    const el = THREE.MathUtils.degToRad(env.sunElevation ?? 48);
    const radius = 12;
    this.key.position.set(
      Math.cos(el) * Math.sin(az) * radius,
      Math.sin(el) * radius,
      Math.cos(el) * Math.cos(az) * radius,
    );
    this.key.target.position.set(0, 0, 0);
    this.key.target.updateMatrixWorld();

    this.grid.visible = env.showGrid !== false;
    this.ground.visible = env.contactShadows !== false;
    this.floor.visible = env.showBackground !== false;

    if (env.showBackground === false) {
      this.scene.background = null;
    } else if (theme.background === 'gradient') {
      this.scene.background = makeGradientTexture(theme.sky);
    } else {
      this.scene.background = new THREE.Color(theme.sky[0]);
    }
    this.floor.material.color.set(theme.ground);
    this.grid.material.color.set(theme.gridMajor);

    this.scene.environmentIntensity = env.environmentIntensity ?? 0.9;

    const fog = this.store.get('render.fog', {});
    if (fog.enabled) {
      this.scene.fog = new THREE.Fog(new THREE.Color(fog.color || '#0b1020'), fog.near, fog.far);
    } else {
      this.scene.fog = null;
    }
  }

  applyRenderSettings() {
    const r = this.store.get('render', {});
    this.renderer.toneMapping = TONE_MAPPINGS[r.toneMapping] ?? THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = r.exposure ?? 1;
    this.renderer.shadowMap.enabled = r.shadows !== false;
    this.renderer.shadowMap.type = r.softShadows === false ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.key.castShadow = r.shadows !== false;

    const cap = r.pixelRatioCap ?? 2;
    const wanted = Math.min(window.devicePixelRatio || 1, cap) * this.adaptiveScale;
    if (Math.abs(wanted - this.pixelRatio) > 0.01) this.resize();

    this.rebuildComposer();
  }

  rebuildComposer() {
    const r = this.store.get('render', {});
    const key = JSON.stringify({
      bloom: r.bloom?.enabled, film: r.film?.enabled, vignette: r.vignette?.enabled,
    });
    if (key === this._composerKey && this.composer) {
      this.updatePostUniforms();
      return;
    }
    this._composerKey = key;

    const wantsPost = r.bloom?.enabled || r.film?.enabled || r.vignette?.enabled;
    if (!wantsPost) {
      this.composer = null;
      this.renderPass = null;
      this.bloomPass = null;
      this.filmPass = null;
      this.outputPass = null;
      return;
    }

    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(this.pixelRatio);
    composer.setSize(this.width || 1, this.height || 1);
    const renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(renderPass);

    let bloomPass = null;
    if (r.bloom?.enabled) {
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(this.width || 1, this.height || 1),
        r.bloom.strength ?? 0.55,
        r.bloom.radius ?? 0.45,
        r.bloom.threshold ?? 0.82,
      );
      composer.addPass(bloomPass);
    }

    const filmPass = new ShaderPass(FILM_SHADER);
    composer.addPass(filmPass);

    const outputPass = new OutputPass();
    composer.addPass(outputPass);

    this.composer = composer;
    this.renderPass = renderPass;
    this.bloomPass = bloomPass;
    this.filmPass = filmPass;
    this.outputPass = outputPass;
    this.updatePostUniforms();
  }

  updatePostUniforms() {
    const r = this.store.get('render', {});
    if (this.renderPass) this.renderPass.camera = this.camera;
    if (this.bloomPass && r.bloom) {
      this.bloomPass.strength = r.bloom.strength ?? 0.55;
      this.bloomPass.radius = r.bloom.radius ?? 0.45;
      this.bloomPass.threshold = r.bloom.threshold ?? 0.82;
    }
    if (this.filmPass) {
      const u = this.filmPass.uniforms;
      u.uGrain.value = r.film?.enabled ? r.film.grain ?? 0 : 0;
      u.uScanlines.value = r.film?.enabled ? r.film.scanlines ?? 0 : 0;
      u.uContrast.value = r.film?.enabled ? r.film.contrast ?? 1 : 1;
      u.uSaturation.value = r.film?.enabled ? r.film.saturation ?? 1 : 1;
      u.uVignette.value = r.vignette?.enabled ? r.vignette.amount ?? 0 : 0;
      u.uVignetteSoft.value = r.vignette?.softness ?? 0.6;
    }
  }

  /* ------------------------------------------------------------------ */
  /* picking                                                            */
  /* ------------------------------------------------------------------ */

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = [];
    for (const group of this.objectMap.values()) {
      if (!group.visible) continue;
      const node = this.store.get('objects', []).find((o) => o.id === group.userData.nodeId);
      if (node && node.locked) continue;
      targets.push(group);
    }
    if (!targets.length) return null;
    const hits = this.raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    for (const hit of hits) {
      let obj = hit.object;
      while (obj && !obj.userData.nodeId) obj = obj.parent;
      if (obj?.userData.nodeId) {
        return { nodeId: obj.userData.nodeId, point: hit.point, distance: hit.distance, object: hit.object };
      }
    }
    return null;
  }

  projectPoint(worldPos) {
    const v = worldPos.clone().project(this.camera);
    const rect = this.container.getBoundingClientRect();
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((-v.y + 1) / 2) * rect.height,
      visible: v.z < 1 && v.z > -1,
      depth: v.z,
    };
  }

  /* ------------------------------------------------------------------ */
  /* timeline                                                           */
  /* ------------------------------------------------------------------ */

  syncTimeline() {
    // mixers are registered by the asset controller
    this.onTimelineSync?.();
  }

  /* ------------------------------------------------------------------ */
  /* frame loop                                                         */
  /* ------------------------------------------------------------------ */

  animate() {
    if (this.disposed) return;
    this._rafId = requestAnimationFrame(this.animate);
    if (this.contextLost) return;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.elapsed = this.timer.getElapsed();
    this.frameCount += 1;

    this.orbit?.update();
    this.updatePostUniforms();
    this.onFrame?.(dt);

    // billboard/projection callbacks
    this.billboardsUpdate?.(dt);

    // A modal covers the viewport; keep app time moving but skip hidden GPU work.
    if (document.hidden || (this.modalRoot && !this.modalRoot.hidden)) return;

    this.renderer.info.reset();
    if (this.composer) {
      if (this.filmPass) this.filmPass.uniforms.uTime.value += dt;
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    this.sampleStats(dt);
  }

  sampleStats(dt) {
    const now = performance.now();
    this.fpsWindow.push({ t: now, dt });
    while (this.fpsWindow.length && now - this.fpsWindow[0].t > 1000) this.fpsWindow.shift();
    if (this.frameCount % 12 !== 0) return;
    const info = this.renderer.info;
    const fps = this.fpsWindow.length;
    const gpu = this.renderer.getContext?.() ? info.memory : { geometries: 0, textures: 0 };
    this.onStats({
      fps,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: gpu.geometries || 0,
      textures: gpu.textures || 0,
      programs: info.programs?.length || 0,
      pixelRatio: this.pixelRatio,
    });
  }

  /* ------------------------------------------------------------------ */
  /* screenshots                                                        */
  /* ------------------------------------------------------------------ */

  renderToCanvas({ width, height, transparent = false, hideHelpers = true, background = null }) {
    const prevRatio = this.renderer.getPixelRatio();
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevAspect = this.camera.aspect;
    const prevBg = this.scene.background;
    const helperVisible = this.gizmoRoot.visible;

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = width / height;
    } else {
      this.updateOrthoFrustum();
    }
    this.camera.updateProjectionMatrix();
    if (hideHelpers) this.gizmoRoot.visible = false;
    if (transparent) {
      this.scene.background = null;
      this.renderer.setClearAlpha(0);
    } else if (background) {
      this.scene.background = background;
    }

    this.renderer.render(this.scene, this.camera);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.renderer.domElement, 0, 0, width, height);

    // restore
    this.renderer.setPixelRatio(prevRatio);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.gizmoRoot.visible = helperVisible;
    this.scene.background = prevBg;
    this.renderer.setClearAlpha(1);
    return canvas;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  rebuildEverything() {
    for (const [id, group] of this.objectMap) {
      disposeTree(group, { keepRoot: true });
      group.userData.built = false;
      const node = this.store.get('objects', []).find((o) => o.id === id);
      if (node) this.buildNode(group, node);
    }
    this.materialCache.clear();
    this.textureCache.clear();
    this.rebuildComposer();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._rafId);
    this._resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.transform.dispose();
    this.orbit.dispose();
    for (const group of this.objectMap.values()) disposeTree(group);
    this.objectMap.clear();
    this.composer?.dispose?.();
    this.pmrem?.dispose();
    this.envTexture?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/* -------------------------------------------------------------------- */
/* helpers                                                              */
/* -------------------------------------------------------------------- */

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function applyTransform(obj, node) {
  const [px, py, pz] = node.position || [0, 0, 0];
  const [rx, ry, rz] = node.rotation || [0, 0, 0];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  if (obj.position.x !== px || obj.position.y !== py || obj.position.z !== pz) obj.position.set(px, py, pz);
  if (obj.rotation.x !== rx || obj.rotation.y !== ry || obj.rotation.z !== rz) obj.rotation.set(rx, ry, rz);
  if (obj.scale.x !== sx || obj.scale.y !== sy || obj.scale.z !== sz) obj.scale.set(sx, sy, sz);
}

export function applyLight(light, cfg) {
  if (!light) return;
  if (cfg.color && light.color) light.color.set(cfg.color);
  if (typeof cfg.intensity === 'number') light.intensity = cfg.intensity;
  if ('distance' in light && typeof cfg.distance === 'number') light.distance = cfg.distance;
  if ('decay' in light && typeof cfg.decay === 'number') light.decay = cfg.decay;
  if ('angle' in light && typeof cfg.angle === 'number') light.angle = cfg.angle;
  if ('penumbra' in light && typeof cfg.penumbra === 'number') light.penumbra = cfg.penumbra;
  if ('width' in light && typeof cfg.width === 'number') light.width = cfg.width;
  if ('height' in light && typeof cfg.height === 'number') light.height = cfg.height;
  if (light.castShadow !== cfg.castShadow) light.castShadow = Boolean(cfg.castShadow);
}

export function highlightTree(root, on, node = null) {
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    if (child.userData.__origEmissive === undefined && child.material.emissive) {
      child.userData.__origEmissive = child.material.emissive.getHex();
      child.userData.__origEmissiveIntensity = child.material.emissiveIntensity;
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of materials) {
      if (!mat.emissive) continue;
      if (on) {
        mat.emissive.setHex(0x1d3557);
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 0, 0.12);
      } else if (child.userData.__origEmissive !== undefined) {
        mat.emissive.setHex(child.userData.__origEmissive);
        mat.emissiveIntensity = child.userData.__origEmissiveIntensity ?? mat.emissiveIntensity;
      }
    }
    if (child.userData.__outlineHelper) {
      child.userData.__outlineHelper.visible = on;
    }
  });
  if (root) root.userData.selected = on;
  return node;
}

export function disposeTree(root, { keepRoot = false } = {}) {
  root.traverse?.((child) => {
    if (child === root && keepRoot) return;
    if (child.geometry) child.geometry.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    for (const mat of materials) {
      for (const key of Object.keys(mat)) {
        const value = mat[key];
        if (value && value.isTexture) value.dispose?.();
      }
      mat.dispose?.();
    }
    child.userData = {};
  });
  root.parent?.remove(root);
}

const gradientCache = new Map();
export function makeGradientTexture(colors, size = 512) {
  const key = colors.join('|');
  if (gradientCache.has(key)) return gradientCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  colors.forEach((color, index) => {
    grad.addColorStop(index / Math.max(1, colors.length - 1), color);
  });
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  gradientCache.set(key, texture);
  return texture;
}

export { clamp };
