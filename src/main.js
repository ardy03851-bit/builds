/**
 * Entry point. Boots the app, then fades the splash out once the first real
 * frame is on screen (never a flash of unstyled 3D).
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import { App } from './app/app.js';

const bootStatus = document.getElementById('boot-status');
const boot = document.getElementById('boot');
const appEl = document.getElementById('app');

function fail(err) {
  console.error(err);
  if (boot) {
    boot.dataset.error = 'true';
    boot.classList.remove('is-done');
    const status = document.getElementById('boot-status');
    if (status) {
      status.textContent = `Could not start: ${err?.message || err}. Try reloading.`;
    }
  }
  if (appEl) appEl.dataset.loading = 'false';
}

async function start() {
  try {
    if (bootStatus) bootStatus.textContent = 'Building the renderer…';
    const app = new App();
    window.atlas = app;

    // Wait for a rendered frame before revealing the UI.
    await new Promise((resolve) => {
      let frames = 0;
      const tick = () => {
        frames += 1;
        if (frames >= 2) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    if (bootStatus) bootStatus.textContent = 'Ready';
    appEl.dataset.loading = 'false';
    boot?.classList.add('is-done');
    setTimeout(() => boot?.remove(), 600);

    // Friendly first-run nudge
    setTimeout(() => {
      if (!app.store.get('ui.onboardingSeen') && !app.store.get('objects', []).length) {
        app.toast.show({
          kind: 'info',
          title: 'Welcome to Atlas',
          message: 'Drop a model or ZIP anywhere to start. Press ? for shortcuts.',
          timeout: 9000,
        });
      }
    }, 1400);

    // Expose a tiny test surface for automated checks
    window.__atlasTest = { app };
  } catch (err) {
    fail(err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}

window.addEventListener('error', (event) => {
  if (event?.error) console.error('[atlas:uncaught]', event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[atlas:unhandled]', event.reason);
});
