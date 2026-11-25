/**
 * Shader / VFX presets and the GLSL editing helpers.
 *
 * Every fragment shader here is a plain three.js `ShaderMaterial` body, so the
 * user can open it in the node-style editor, tweak uniforms live, and export
 * the exact source. `validateShader` catches the common mistakes before we
 * hand the source to the GPU (three.js reports those asynchronously and poorly).
 */

export const PRESET_CATEGORIES = ['Atmosphere', 'Surface', 'Energy', 'Utility'];

/**
 * Presets use a tiny uniform DSL:
 *   { type: 'float'|'color'|'vec2', value, min, max, label }
 * The editor renders sliders from this automatically.
 */
export const SHADER_PRESETS = [
  {
    id: 'soft-fog',
    name: 'Volumetric Fog',
    category: 'Atmosphere',
    icon: 'fog',
    description: 'Layered drifting fog with a horizon glow. Great on a floor plane.',
    blend: 'normal',
    transparent: true,
    uniforms: {
      uColorA: { type: 'color', value: '#8fb8ff', label: 'Fog Color' },
      uColorB: { type: 'color', value: '#f6d7ff', label: 'Glow Color' },
      uDensity: { type: 'float', value: 0.55, min: 0, max: 1.5, label: 'Density' },
      uSpeed: { type: 'float', value: 0.18, min: 0, max: 2, label: 'Drift Speed' },
      uScale: { type: 'float', value: 2.4, min: 0.2, max: 12, label: 'Noise Scale' },
    },
    fragment: `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uDensity;
uniform float uSpeed;
uniform float uScale;
varying vec2 vUv;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}

void main(){
  vec2 p = vUv * uScale;
  float t = uTime * uSpeed;
  float f = fbm(p + vec2(t, t * 0.6));
  f = smoothstep(0.25, 0.95, f);
  float horizon = smoothstep(0.0, 0.55, vUv.y) * smoothstep(1.0, 0.45, vUv.y);
  vec3 col = mix(uColorA, uColorB, f);
  float alpha = clamp(f * uDensity * horizon, 0.0, 0.92);
  gl_FragColor = vec4(col, alpha);
}`,
  },
  {
    id: 'holo-grid',
    name: 'Holographic Grid',
    category: 'Surface',
    icon: 'grid',
    description: 'Scanner-style grid with a sweeping highlight and rim glow.',
    blend: 'additive',
    transparent: true,
    uniforms: {
      uColor: { type: 'color', value: '#39d3ff', label: 'Line Color' },
      uCells: { type: 'float', value: 18, min: 2, max: 80, step: 1, label: 'Cells' },
      uThickness: { type: 'float', value: 0.035, min: 0.002, max: 0.2, label: 'Line Width' },
      uScan: { type: 'float', value: 1.2, min: 0, max: 4, label: 'Scan Speed' },
    },
    fragment: `
uniform vec3 uColor;
uniform float uCells;
uniform float uThickness;
uniform float uScan;
varying vec2 vUv;

void main(){
  vec2 g = fract(vUv * uCells);
  vec2 d = min(g, 1.0 - g);
  float line = 1.0 - smoothstep(0.0, uThickness, min(d.x, d.y));
  float sweep = smoothstep(0.0, 0.08, 0.5 + 0.5 * sin((vUv.y - uTime * 0.15 * uScan) * 12.0));
  float rim = smoothstep(0.45, 0.5, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)));
  float alpha = clamp(line * 0.85 + rim * 0.35 * sweep, 0.0, 1.0);
  gl_FragColor = vec4(uColor * (0.6 + sweep * 0.8), alpha);
}`,
  },
  {
    id: 'energy-plasma',
    name: 'Plasma Vortex',
    category: 'Energy',
    icon: 'bolt',
    description: 'Swirling plasma orb. Beautiful on a sphere or billboard.',
    blend: 'additive',
    transparent: true,
    uniforms: {
      uColorA: { type: 'color', value: '#ff3d81', label: 'Inner Color' },
      uColorB: { type: 'color', value: '#ffd24a', label: 'Outer Color' },
      uSpin: { type: 'float', value: 0.6, min: 0, max: 3, label: 'Spin' },
      uTurbulence: { type: 'float', value: 2.6, min: 0, max: 8, label: 'Turbulence' },
      uPower: { type: 'float', value: 1.35, min: 0.2, max: 4, label: 'Power' },
    },
    fragment: `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uSpin;
uniform float uTurbulence;
uniform float uPower;
varying vec2 vUv;

void main(){
  vec2 uv = vUv * 2.0 - 1.0;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float swirl = sin(a * 5.0 + r * 9.0 - uTime * uSpin * 2.0) * 0.5 + 0.5;
  float core = pow(clamp(1.0 - r, 0.0, 1.0), uPower);
  float blend = clamp(swirl * uTurbulence * 0.4 + core, 0.0, 1.0);
  vec3 col = mix(uColorA, uColorB, blend);
  float alpha = clamp(core * uTurbulence * 0.6, 0.0, 1.0);
  gl_FragColor = vec4(col * (0.6 + core), alpha);
}`,
  },
  {
    id: 'star-field',
    name: 'Star Field',
    category: 'Atmosphere',
    icon: 'star',
    description: 'Parallax starfield for skydomes and backdrops.',
    blend: 'additive',
    transparent: true,
    uniforms: {
      uColor: { type: 'color', value: '#cfe4ff', label: 'Star Color' },
      uDensity: { type: 'float', value: 0.86, min: 0.1, max: 1, label: 'Density' },
      uTwinkle: { type: 'float', value: 0.7, min: 0, max: 2, label: 'Twinkle' },
      uScale: { type: 'float', value: 140, min: 20, max: 400, label: 'Scale' },
    },
    fragment: `
uniform vec3 uColor;
uniform float uDensity;
uniform float uTwinkle;
uniform float uScale;
varying vec2 vUv;

float hash(vec2 p){ return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5453); }

void main(){
  vec2 g = vUv * uScale;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float rnd = hash(id);
  float star = step(uDensity, rnd) * smoothstep(0.5, 0.0, length(f) * 8.0);
  float tw = 1.0 - uTwinkle * 0.5 + uTwinkle * 0.5 * sin(uTime * (1.0 + rnd * 3.0) + rnd * 20.0);
  float alpha = star * tw;
  gl_FragColor = vec4(uColor * (1.2 + rnd), alpha);
}`,
  },
  {
    id: 'water-caustics',
    name: 'Shore Caustics',
    category: 'Surface',
    icon: 'water',
    description: 'Animated caustic bands for pool floors and water surfaces.',
    blend: 'normal',
    transparent: true,
    uniforms: {
      uColor: { type: 'color', value: '#a8f0ff', label: 'Caustic Color' },
      uSpeed: { type: 'float', value: 0.5, min: 0, max: 3, label: 'Speed' },
      uScale: { type: 'float', value: 4.0, min: 0.5, max: 20, label: 'Scale' },
      uIntensity: { type: 'float', value: 1.0, min: 0, max: 3, label: 'Intensity' },
    },
    fragment: `
uniform vec3 uColor;
uniform float uSpeed;
uniform float uScale;
uniform float uIntensity;
varying vec2 vUv;

void main(){
  vec2 p = vUv * uScale;
  float t = uTime * uSpeed;
  float c = sin(p.x * 3.1 + t) * sin(p.y * 2.7 - t * 1.3);
  c += sin(p.x * 1.7 - t * 0.6) * sin(p.y * 4.3 + t * 0.9);
  c = pow(abs(c) * 0.5, 2.2);
  gl_FragColor = vec4(uColor * c * uIntensity, clamp(c * 1.4, 0.0, 1.0));
}`,
  },
  {
    id: 'toon-gradient',
    name: 'Gradient Shade',
    category: 'Utility',
    icon: 'gradient',
    description: 'Two-tone vertical gradient — a handy stand-in for untextured props.',
    blend: 'normal',
    transparent: false,
    uniforms: {
      uTop: { type: 'color', value: '#ffb98a', label: 'Top Color' },
      uBottom: { type: 'color', value: '#3b2a6b', label: 'Bottom Color' },
      uOffset: { type: 'float', value: 0.5, min: 0, max: 1, label: 'Break Point' },
      uSoftness: { type: 'float', value: 0.35, min: 0.01, max: 1, label: 'Softness' },
    },
    fragment: `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uOffset;
uniform float uSoftness;
varying vec2 vUv;

void main(){
  float t = smoothstep(uOffset - uSoftness, uOffset + uSoftness, vUv.y);
  gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
}`,
  },
  {
    id: 'aurora',
    name: 'Aurora Curtains',
    category: 'Atmosphere',
    icon: 'aurora',
    description: 'Slow aurora ribbons that drift across the sky.',
    blend: 'additive',
    transparent: true,
    uniforms: {
      uColorA: { type: 'color', value: '#3dffc0', label: 'Green' },
      uColorB: { type: 'color', value: '#7b6bff', label: 'Violet' },
      uSpeed: { type: 'float', value: 0.22, min: 0, max: 1.5, label: 'Speed' },
      uWave: { type: 'float', value: 6.0, min: 1, max: 20, label: 'Wave Count' },
      uIntensity: { type: 'float', value: 0.9, min: 0, max: 2, label: 'Intensity' },
    },
    fragment: `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uSpeed;
uniform float uWave;
uniform float uIntensity;
varying vec2 vUv;

void main(){
  float x = vUv.x;
  float wave = sin(x * uWave + uTime * uSpeed * 3.0) * 0.08
             + sin(x * uWave * 2.3 - uTime * uSpeed * 2.0) * 0.04;
  float band = smoothstep(0.75, 0.35, abs(vUv.y - 0.55 - wave));
  float fade = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
  float veil = 0.6 + 0.4 * sin(x * 18.0 + uTime * uSpeed * 6.0);
  vec3 col = mix(uColorA, uColorB, vUv.y + 0.2 * sin(x * 4.0));
  gl_FragColor = vec4(col, band * fade * veil * uIntensity);
}`,
  },
  {
    id: 'glitch-scan',
    name: 'Scanline Glitch',
    category: 'Utility',
    icon: 'glitch',
    description: 'CRT scanlines with subtle horizontal jitter. For UI billboards.',
    blend: 'normal',
    transparent: true,
    uniforms: {
      uColor: { type: 'color', value: '#8dfcff', label: 'Tint' },
      uLines: { type: 'float', value: 220, min: 20, max: 800, label: 'Lines' },
      uGlitch: { type: 'float', value: 0.35, min: 0, max: 1, label: 'Glitch' },
      uOpacity: { type: 'float', value: 0.9, min: 0, max: 1, label: 'Opacity' },
    },
    fragment: `
uniform vec3 uColor;
uniform float uLines;
uniform float uGlitch;
uniform float uOpacity;
varying vec2 vUv;

float hash(float n){ return fract(sin(n) * 43758.5453); }

void main(){
  float line = 0.55 + 0.45 * sin(vUv.y * uLines * 3.14159);
  float row = floor(vUv.y * uLines);
  float jitter = (hash(row + floor(uTime * 12.0)) - 0.5) * uGlitch * 0.08;
  float mask = step(0.02, abs(vUv.x + jitter - 0.5) * -2.0 + 1.0);
  float flicker = 0.92 + 0.08 * sin(uTime * 40.0);
  float alpha = line * mask * uOpacity * flicker;
  gl_FragColor = vec4(uColor * (0.8 + line * 0.5), alpha);
}`,
  },
];

export const PRESET_BY_ID = new Map(SHADER_PRESETS.map((p) => [p.id, p]));

export const DEFAULT_VERTEX_SHADER = `varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * User uniforms are injected before main() and can read uTime.
 * Anything the source already declares is left alone (redeclaring a uniform is
 * a hard GLSL error, so this must be exact).
 */
export function buildFragmentSource(source, uniforms = {}) {
  const src = String(source ?? '');
  const needs = (name) => !new RegExp(`\\buniform\\s+\\w+\\s+${name}\\s*;`).test(src);
  const declarations = Object.entries(uniforms)
    .filter(([name]) => needs(name))
    .map(([name, def]) => `uniform ${glslType(def)} ${name};`)
    .join('\n');
  const usages = new Set([...src.matchAll(/\b(u[A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]));
  const declared = new Set([...src.matchAll(/\buniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]));
  if (!declared.size) return normalizeGlsl(src);
  const missing = [...usages].filter((name) => !declared.has(name) && !Object.keys(uniforms).includes(name) && name !== 'uTime' && name !== 'uResolution');

  const timeDecl = !declared.has('uTime') ? 'uniform float uTime;' : '';
  const resDecl = !declared.has('uResolution') ? 'uniform vec2 uResolution;' : '';
  const uvDecl = /\bvUv\b/.test(src) && !/varying\s+vec2\s+vUv\s*;/.test(src) ? 'varying vec2 vUv;' : '';
  const unknownDecls = missing.map((name) => (name === 'uTime' ? 'uniform float uTime;' : `uniform float ${name}; // auto-declared`));
  const header = [uvDecl, timeDecl, resDecl, declarations, ...unknownDecls].filter(Boolean).join('\n');
  return normalizeGlsl(header ? `${header}\n${src}` : src);
}

const glslType = (def) => {
  if (typeof def === 'string') return def;
  switch (def?.type) {
    case 'color':
      return 'vec3';
    case 'vec2':
      return 'vec2';
    case 'vec3':
      return 'vec3';
    case 'vec4':
      return 'vec4';
    case 'int':
      return 'int';
    default:
      return 'float';
  }
};

/** Adds precision + version preamble and normalises newlines. */
export function normalizeGlsl(source) {
  let src = String(source ?? '').replace(/\r\n?/g, '\n').trim();
  if (!/precision\s+(low|medium|high)p\s+float/.test(src)) {
    src = `precision highp float;\n${src}`;
  }
  return src;
}

/**
 * Static analysis: returns user-facing problems. Catches unbalanced braces,
 * missing main, undeclared uniforms and obvious typos before compile.
 */
export function validateShader(source, { uniforms = {}, isFragment = true } = {}) {
  const problems = [];
  const warnings = [];
  const src = stripComments(String(source ?? ''));

  if (!src.trim()) {
    problems.push('Shader source is empty.');
    return { ok: false, problems, warnings };
  }

  const open = count(src, '{');
  const close = count(src, '}');
  if (open !== close) {
    problems.push(`Unbalanced braces: ${open} "{" vs ${close} "}".`);
  }
  const parenOpen = count(src, '(');
  const parenClose = count(src, ')');
  if (parenOpen !== parenClose) {
    problems.push(`Unbalanced parentheses: ${parenOpen} "(" vs ${parenClose} ")".`);
  }

  if (!/\bvoid\s+main\s*\(\s*(void)?\s*\)/.test(src)) {
    problems.push('Missing entry point: void main() { ... }');
  }

  if (isFragment) {
    if (!/\bgl_FragColor\b/.test(src) && !/\bout\s+vec4\b/.test(src) && !/three\s*:\s*fragColor/i.test(src)) {
      problems.push('Fragment shader never writes a colour (gl_FragColor).');
    }
    if (!/precision\s+(low|medium|high)p\s+float/.test(String(source))) {
      warnings.push('No precision qualifier — added automatically at compile time.');
    }
  }

  // undeclared uniform usage
  const declared = new Set([...Object.keys(uniforms), 'uTime', 'uResolution']);
  for (const m of src.matchAll(/\buniform\s+\w+\s+([A-Za-z_]\w*)\s*;/g)) declared.add(m[1]);
  const builtin = new Set([
    'modelViewMatrix', 'projectionMatrix', 'modelMatrix', 'viewMatrix', 'normalMatrix',
    'cameraPosition', 'uv', 'position', 'normal', 'color', 'gl_FragColor', 'gl_FragCoord',
    'gl_Position', 'gl_PointSize', 'isOrthographic', 'uv1', 'uv2', 'tangent', 'instanceMatrix',
  ]);
  for (const m of src.matchAll(/\b(u[A-Z]\w*)\b/g)) {
    const name = m[1];
    if (!declared.has(name) && !builtin.has(name)) {
      // only report once
      const msg = `Uniform "${name}" is used but not declared.`;
      if (!warnings.includes(msg)) warnings.push(msg);
    }
  }

  // common GLSL mistakes
  if (/[^=!<>]=\s*[^=]/.test(src) && /\bif\s*\([^)]*=[^=]/.test(src)) {
    problems.push('Assignment ("=") inside an if-condition — use "==".');
  }
  if (/\bfloat\s+\w+\s*=\s*\d+\s*;/.test(src)) {
    warnings.push('Integer literal assigned to float — add ".0" (GLSL is strict).');
  }
  const reserved = ['texture2D', 'sampler3D_deprecated'];
  for (const name of reserved) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(src) && name !== 'texture2D') {
      warnings.push(`"${name}" is reserved in WebGL2.`);
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

function count(str, ch) {
  let n = 0;
  for (const c of str) if (c === ch) n += 1;
  return n;
}

export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Replaces uniform declarations in an existing source with a new uniform set. */
export function syncUniformDeclarations(source, uniforms) {
  const decl = Object.entries(uniforms)
    .map(([name, def]) => `uniform ${glslType(def)} ${name};`)
    .join('\n');
  const stripped = String(source).replace(/\buniform\s+(?:float|vec2|vec3|vec4|int|sampler2D)\s+u[A-Za-z0-9_]*\s*;\n?/g, '');
  // re-add uTime declaration if the shader references it
  const needsTime = /\buTime\b/.test(stripped);
  return normalizeGlsl(`${needsTime ? 'uniform float uTime;\n' : ''}${decl}\n${stripped}`);
}

/** Builds user uniforms object for a preset definition. */
export function uniformsFromPreset(preset) {
  const out = {};
  for (const [name, def] of Object.entries(preset?.uniforms || {})) {
    out[name] = { ...def };
  }
  return out;
}
