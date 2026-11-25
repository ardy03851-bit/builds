/**
 * Fast, allocation-conscious OBJ + MTL parser.
 *
 * three's OBJLoader is fine for small files but re-parses strings repeatedly and
 * builds `Vector3`s by the million. This parser writes straight into typed
 * arrays (with exponential growth), supports negative indices, polygons, and
 * groups → materials, and reports progress for huge meshes.
 */

class Grow {
  constructor(Type, initial = 1024) {
    this.Type = Type;
    this.data = new Type(initial);
    this.length = 0;
  }
  push(...vals) {
    if (this.length + vals.length > this.data.length) this.grow(this.length + vals.length);
    for (let i = 0; i < vals.length; i += 1) this.data[this.length++] = vals[i];
  }
  grow(needed) {
    let size = this.data.length || 1024;
    while (size < needed) size *= 2;
    const next = new this.Type(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

const parseFaceIndex = (token, count) => {
  if (!token) return -1;
  const idx = parseInt(token, 10);
  if (Number.isNaN(idx)) return -1;
  return idx < 0 ? count + idx : idx - 1;
};

/**
 * @param {string} text
 * @param {{onProgress?: (done:number, total:number)=>void, defaultMaterial?: string}} options
 * @returns {{geometries: Array<{name:string, material:string, positions:Float32Array, normals:Float32Array|null, uvs:Float32Array|null, index:Uint32Array|null}>, materials: Record<string, object>, stats: object}}
 */
export function parseOBJ(text, options = {}) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const totalLines = lines.length;

  const v = new Grow(Float32Array);
  const vt = new Grow(Float32Array);
  const vn = new Grow(Float32Array);

  let currentMaterial = options.defaultMaterial || 'default';
  let smoothing = true;
  let group = makeGroup('default', currentMaterial);
  const groups = [];
  let objectCount = 0;
  const mtllibs = [];

  const finishGroup = () => {
    if (group.count > 0) groups.push(group);
    group = makeGroup('default', currentMaterial);
  };

  function makeGroup(name, material) {
    return {
      name,
      material,
      vertexMap: new Map(),
      positions: [],
      uvs: [],
      normals: [],
      indices: [],
      count: 0,
      smoothing,
      hasUv: false,
      hasNormal: false,
    };
  }

  const pushVertex = (g, posIndex, uvIndex, normIndex) => {
    const key = `${posIndex}/${uvIndex}/${normIndex}`;
    const found = g.vertexMap.get(key);
    if (found !== undefined) return found;
    const p = posIndex * 3;
    g.positions.push(v.data[p] || 0, v.data[p + 1] || 0, v.data[p + 2] || 0);
    if (uvIndex >= 0 && uvIndex * 2 + 1 < vt.length) {
      g.uvs.push(vt.data[uvIndex * 2], vt.data[uvIndex * 2 + 1]);
      g.hasUv = true;
    } else {
      g.uvs.push(0, 0);
    }
    if (normIndex >= 0 && normIndex * 3 + 2 < vn.length) {
      g.normals.push(vn.data[normIndex * 3], vn.data[normIndex * 3 + 1], vn.data[normIndex * 3 + 2]);
      g.hasNormal = true;
    } else {
      g.normals.push(0, 0, 0);
    }
    const index = g.count;
    g.vertexMap.set(key, index);
    g.count += 1;
    return index;
  };

  for (let i = 0; i < totalLines; i += 1) {
    const line = lines[i];
    if (!line || line.charCodeAt(0) === 35 /* # */) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    switch (tag) {
      case 'v': {
        const nums = line.trim().split(/\s+/);
        v.push(+nums[1] || 0, +nums[2] || 0, +nums[3] || 0);
        break;
      }
      case 'vt': {
        const nums = line.trim().split(/\s+/);
        vt.push(+nums[1] || 0, +nums[2] || 0);
        break;
      }
      case 'vn': {
        const nums = line.trim().split(/\s+/);
        vn.push(+nums[1] || 0, +nums[2] || 0, +nums[3] || 0);
        break;
      }
      case 'f': {
        const tokens = line.trim().split(/\s+/).slice(1);
        const count = v.length / 3;
        const idx = [];
        for (const token of tokens) {
          const [p, t, n] = token.split('/');
          const pi = parseFaceIndex(p, count);
          if (pi < 0) continue;
          idx.push(pushVertex(group, pi, parseFaceIndex(t, vt.length / 2), parseFaceIndex(n, vn.length / 3)));
        }
        // fan triangulation
        for (let k = 2; k < idx.length; k += 1) {
          group.indices.push(idx[0], idx[k - 1], idx[k]);
        }
        break;
      }
      case 'g':
      case 'o': {
        finishGroup();
        objectCount += 1;
        group.name = line.slice(sp + 1).trim() || `object${objectCount}`;
        break;
      }
      case 'usemtl': {
        finishGroup();
        currentMaterial = line.slice(sp + 1).trim() || 'default';
        group.material = currentMaterial;
        break;
      }
      case 'mtllib': {
        mtllibs.push(line.slice(sp + 1).trim());
        break;
      }
      case 's': {
        smoothing = line.slice(sp + 1).trim() !== 'off';
        group.smoothing = smoothing;
        break;
      }
      default:
        break;
    }
    if (options.onProgress && i % 20000 === 0) options.onProgress(i, totalLines);
  }
  finishGroup();

  const geometries = groups
    .filter((g) => g.count >= 3)
    .map((g) => {
      return {
        name: `${g.name}_${g.material}`.replace(/[\s:]+/g, '_'),
        material: g.material,
        positions: new Float32Array(g.positions),
        uvs: g.hasUv ? new Float32Array(g.uvs) : null,
        normals: g.hasNormal ? new Float32Array(g.normals) : null,
        index: new Uint32Array(g.indices),
        smooth: g.smoothing,
      };
    });

  return {
    geometries,
    mtllibs,
    stats: {
      vertices: v.length / 3,
      uvs: vt.length / 2,
      normals: vn.length / 3,
      materials: new Set(geometries.map((g) => g.material)).size,
      groups: geometries.length,
    },
  };
}

/** Minimal but complete MTL parser. */
export function parseMTL(text, basePath = '') {
  const out = {};
  const lines = String(text ?? '').split('\n');
  let current = null;
  for (const line of lines) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const [tag, ...rest] = clean.split(/\s+/);
    const value = rest.join(' ');
    switch (tag) {
      case 'newmtl':
        current = { name: value, textures: {}, colors: {} };
        out[value] = current;
        break;
      case 'Kd': {
        const [r, g, b] = rest.map(Number);
        if (current) current.colors.baseColor = [r, g, b];
        break;
      }
      case 'Ka': {
        if (current) current.colors.ambient = rest.map(Number);
        break;
      }
      case 'Ks': {
        if (current) current.colors.specular = rest.map(Number);
        break;
      }
      case 'Ke': {
        if (current) current.colors.emissive = rest.map(Number);
        break;
      }
      case 'Ns':
        if (current) current.shininess = Number(value) || 0;
        break;
      case 'd':
      case 'Tr':
        if (current) current.opacity = tag === 'Tr' ? 1 - Number(value) : Number(value);
        break;
      case 'map_Kd':
      case 'map_Ka':
      case 'map_Ks':
      case 'map_Bump':
      case 'bump':
      case 'map_d':
      case 'map_Pr':
      case 'map_Pm':
      case 'map_Ke': {
        if (!current) break;
        const file = value.split(/\s+/).filter((t) => !t.startsWith('-')).pop();
        const slot =
          tag === 'map_Kd' ? 'baseColor'
            : tag === 'map_Ks' ? 'specular'
              : tag === 'map_Bump' || tag === 'bump' ? 'normal'
                : tag === 'map_d' ? 'opacity'
                  : tag === 'map_Pr' ? 'roughness'
                    : tag === 'map_Pm' ? 'metalness'
                      : tag === 'map_Ke' ? 'emissive'
                        : 'ao';
        current.textures[slot] = { file: joinPath(basePath, file), offset: [0, 0], scale: [1, 1] };
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function joinPath(base, file) {
  if (/^(https?:|data:|blob:)/.test(file)) return file;
  const dir = base.endsWith('/') ? base : `${base}/`;
  return `${dir}${file}`.replace(/\/{2,}/g, '/');
}

/** Cheap validity check before we hand a file to the parser. */
export function looksLikeOBJ(bytes) {
  if (!bytes || bytes.length < 8) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  return /^\s*(#|v\s|vt\s|vn\s|f\s|o\s|g\s|mtllib\s|usemtl\s|s\s)/m.test(head);
}
