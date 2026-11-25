/**
 * Shot Studio — professional screenshot capture.
 *
 * Capabilities
 *  · resolution presets + custom, up to 4× supersampling (render big, downscale)
 *  · transparent background for compositing
 *  · contact-shadow matte, grid toggle, letterbox / frame
 *  · PNG / JPEG / WebP, quality control
 *  · watermark + metadata footer, EXIF-ish sidecar JSON
 *  · deterministic: helpers, gizmos and billboards are hidden, then restored
 */

import { clamp, slug } from '../core/util.js';

export const ASPECT_PRESETS = [
  { id: '16:9', label: '16:9', w: 16, h: 9, sizes: [3840, 2560, 1920, 1280] },
  { id: '1:1', label: '1:1', w: 1, h: 1, sizes: [2048, 1600, 1080, 800] },
  { id: '4:5', label: '4:5', w: 4, h: 5, sizes: [2048, 1600, 1080] },
  { id: '9:16', label: '9:16', w: 9, h: 16, sizes: [2160, 1920, 1080] },
  { id: '21:9', label: '21:9', w: 21, h: 9, sizes: [3440, 2560, 1920] },
  { id: '4:3', label: '4:3', w: 4, h: 3, sizes: [2560, 2048, 1600, 1024] },
  { id: 'custom', label: 'Custom', w: 1, h: 1, sizes: [] },
];

export const SHADOW_PRESETS = [
  { id: 'none', label: 'None' },
  { id: 'soft', label: 'Soft' },
  { id: 'hard', label: 'Crisp' },
  { id: 'contact', label: 'Contact' },
];

export function sizeForPreset(aspectId, longEdge = 1920) {
  const preset = ASPECT_PRESETS.find((a) => a.id === aspectId) || ASPECT_PRESETS[0];
  if (preset.id === 'custom') return null;
  const { w, h } = preset;
  if (w >= h) {
    const width = longEdge;
    return { width: roundEven(width), height: roundEven((longEdge * h) / w) };
  }
  const height = longEdge;
  return { width: roundEven((longEdge * w) / h), height: roundEven(height) };
}

const roundEven = (n) => Math.max(2, Math.round(n / 2) * 2);

export class ShotStudio {
  constructor(app) {
    this.app = app;
    this.lastShot = null;
  }

  /** Renders one frame at the requested settings and returns a PNG/JPEG blob. */
  async capture(settings = {}) {
    const engine = this.app.engine;
    const shot = { ...this.app.store.get('shot', {}), ...settings };
    const width = Math.max(16, Math.round(shot.width || 1920));
    const height = Math.max(16, Math.round(shot.height || 1080));
    const supersample = clamp(shot.scale || 1, 0.25, 4);

    const renderW = Math.round(width * supersample);
    const renderH = Math.round(height * supersample);

    // Save + hide viewport-only helpers
    const billboardLayer = document.querySelector('.billboard-layer');
    const prevBillboards = billboardLayer?.style.visibility;
    if (billboardLayer) billboardLayer.style.visibility = 'hidden';

    const prevGrid = engine.grid.visible;
    if (shot.grid === false) engine.grid.visible = false;

    const prevShadowOpacity = engine.ground.material.opacity;
    if (shot.shadow === 'none') {
      engine.ground.visible = false;
    } else if (shot.shadow === 'hard') {
      engine.ground.visible = true;
      engine.ground.material.opacity = 0.55;
    } else if (shot.shadow === 'contact') {
      engine.ground.visible = true;
      engine.ground.material.opacity = 0.4;
    }

    let canvas;
    try {
      canvas = engine.renderToCanvas({
        width: renderW,
        height: renderH,
        transparent: Boolean(shot.transparent),
        hideHelpers: true,
      });
    } finally {
      engine.grid.visible = prevGrid;
      engine.ground.visible = this.app.store.get('environment.contactShadows', true);
      engine.ground.material.opacity = prevShadowOpacity;
      if (billboardLayer) billboardLayer.style.visibility = prevBillboards || '';
    }

    // Compose the final image (frame, watermark)
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const frameInset = shot.frame ? Math.round(Math.min(width, height) * 0.035) : 0;

    if (!shot.transparent) {
      const pad = frameInset;
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      const theme = this.app.store.get('environment.theme', 'night');
      const sky = theme === 'paper' ? ['#fbfcfe', '#eef1f6'] : ['#101722', '#070a10'];
      grad.addColorStop(0, sky[0]);
      grad.addColorStop(1, sky[1]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      if (pad) {
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = Math.max(1, Math.round(width / 1600));
        ctx.strokeRect(pad * 0.5, pad * 0.5, width - pad, height - pad);
        ctx.drawImage(canvas, pad, pad, width - pad * 2, height - pad * 2);
      } else {
        ctx.drawImage(canvas, 0, 0, width, height);
      }
    } else {
      ctx.drawImage(canvas, 0, 0, width, height);
    }

    if (shot.watermark) {
      const size = Math.round(Math.min(width, height) * 0.024);
      ctx.font = `600 ${size}px ui-sans-serif, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'right';
      const x = width - Math.round(width * 0.03);
      const y = height - Math.round(height * 0.035);
      ctx.fillStyle = shot.transparent ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.72)';
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = size * 0.4;
      ctx.fillText(shot.watermark, x, y);
      ctx.shadowBlur = 0;
    }

    const mime = shot.format === 'jpeg' ? 'image/jpeg' : shot.format === 'webp' ? 'image/webp' : 'image/png';
    const quality = clamp(shot.quality ?? 0.94, 0.3, 1);
    const blob = await new Promise((resolve) => out.toBlob(resolve, mime, quality));

    this.lastShot = {
      blob,
      width,
      height,
      mime,
      takenAt: Date.now(),
      settings: shot,
    };
    return this.lastShot;
  }

  /** Metadata written next to the image on batch export. */
  metadata(shot) {
    return {
      app: 'Atlas Scene Studio',
      version: '1.0.0',
      scene: this.app.store.get('meta.name'),
      capturedAt: new Date().toISOString(),
      resolution: `${shot.width}×${shot.height}`,
      format: shot.mime,
      camera: this.app.store.get('camera'),
      render: this.app.store.get('render'),
      environment: this.app.store.get('environment'),
      stats: this.app.store.get('stats'),
    };
  }

  async download(shot = null) {
    const result = shot?.blob ? shot : await this.capture();
    const ext = result.mime === 'image/jpeg' ? 'jpg' : result.mime === 'image/webp' ? 'webp' : 'png';
    const name = `${slug(this.app.store.get('meta.name', 'scene'), 'scene')}-${stamp()}.${ext}`;
    triggerDownload(result.blob, name);
    return name;
  }

  /** Captures a set of angles (front / 3-4 / side / top) as a contact sheet. */
  async captureTurntable({ frames = 4, size = 1080, settings = {} } = {}) {
    const engine = this.app.engine;
    const orbit = engine.orbit;
    const startAzimuth = Math.atan2(
      engine.camera.position.x - orbit.target.x,
      engine.camera.position.z - orbit.target.z,
    );
    const radius = engine.camera.position.distanceTo(orbit.target);
    const height = engine.camera.position.y;
    const results = [];

    for (let i = 0; i < frames; i += 1) {
      const angle = startAzimuth + (i / frames) * Math.PI * 2;
      engine.camera.position.set(
        orbit.target.x + Math.sin(angle) * radius,
        height,
        orbit.target.z + Math.cos(angle) * radius,
      );
      engine.camera.lookAt(orbit.target);
      engine.orbit.update();
      results.push(await this.capture({ ...settings, width: size, height: size, scale: 1 }));
    }

    engine.camera.position.set(
      orbit.target.x + Math.sin(startAzimuth) * radius,
      height,
      orbit.target.z + Math.cos(startAzimuth) * radius,
    );
    engine.camera.lookAt(orbit.target);
    engine.orbit.update();
    return results;
  }

  async downloadTurntable(options) {
    const shots = await this.captureTurntable({ frames: 4, size: 900, ...options });
    const files = [];
    for (let i = 0; i < shots.length; i += 1) {
      const file = new File([shots[i].blob], `${slug(this.app.store.get('meta.name', 'scene'))}-angle-${i + 1}.png`, { type: 'image/png' });
      files.push(file);
    }
    return files;
  }
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
