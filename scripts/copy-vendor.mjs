// Copies the optional Draco / KTX2 (Basis) decoders out of node_modules so the
// app stays fully self-hosted (works offline, no third-party CDNs).
import { cp, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jobs = [
  ['node_modules/three/examples/jsm/libs/draco/gltf', 'public/decoders/draco'],
  ['node_modules/three/examples/jsm/libs/basis', 'public/decoders/basis'],
];

for (const [from, to] of jobs) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    console.warn(`[vendor] skip (missing): ${from}`);
    continue;
  }
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  try { await access(join(dst, 'README.md')); } catch { /* fine */ }
}
console.log('[vendor] decoders ready');
