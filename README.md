# Atlas Scene Studio

A local-first, touch-friendly WebGL scene builder for desktop and iPad. Import models and texture packs, arrange a scene, tune PBR materials and lighting, add animated GLSL effects or billboards, then export a polished screenshot or GLB.

## Quick start

Requirements: Node.js **20.19+** or **22.12+**, npm, and a modern browser with WebGL 2 support.

```bash
npm ci
npm run dev
```

Open the URL printed by Vite (normally <http://localhost:5173>). The dev server binds to `0.0.0.0`, so it can also be opened from another device on the same network when the host permits it. No backend, API key, account, or CDN is required; runtime libraries and model decoders are served locally.

Useful commands:

```bash
npm run check    # lint, unit tests, and production build
npm test         # Node test suite
npm run lint     # ESLint
npm run build    # production build in dist/
npm run preview  # serve the production build locally
```

## What it does

- **Build scenes:** add imported models and primitives, move/rotate/scale with gizmos, frame the selection, snap transforms, duplicate, delete, undo, and redo.
- **Import models:** GLB/glTF, FBX, OBJ/MTL, STL, PLY, DAE, and 3MF. glTF Draco, Meshopt, and KTX2/Basis resources use the bundled local decoders/transcoder.
- **Import textures and environments:** common raster maps (PNG, JPG/JPEG, WebP, AVIF, KTX2, Basis) and HDR/EXR environment images. Assign maps from the material inspector or drop a texture onto a material slot.
- **Work with ZIP packs:** inspect archive contents before import, group textures with likely models, and review confidence-ranked smart matches. The matcher considers model/material names, map labels, packed channel hints, and folder context; ambiguous matches can be reviewed or assigned manually.
- **Edit PBR materials:** base color, normal, roughness, metalness, ambient occlusion, emissive, opacity, displacement, bump, specular, glossiness, and packed ORM slots, alongside material controls.
- **Tune the look:** environment presets, lighting, shadows, tone mapping, exposure, fog, and optional post effects. The default shadow filter is selected for performance; soft shadows remain available in render settings.
- **Create effects:** Shader Lab provides GLSL fragment editing, built-in effect presets, uniform controls, validation feedback, blending and transparency settings, and live scene effects.
- **Add UI to the scene:** create camera-facing billboard labels and GUI elements.
- **Animate:** imported clips are available in the timeline with play/pause and scrubbing controls.
- **Capture and export:** Shot Studio supports custom dimensions, aspect presets, supersampling, transparent backgrounds, frame/matte, watermarks, PNG/JPEG/WebP, and four-angle turntables. Export a scene as GLB or save a project document/manifest.
- **Persist locally:** browser autosave and imported binary assets are stored in IndexedDB on the current device. The downloaded `.atlascene` file contains the scene document and asset manifest; it does not bundle the binary asset payloads. Keep the original source files for moving a project to another browser/device.

All scene processing happens in the browser. Large files can use substantial memory and GPU resources; practical limits depend on the device, browser, and available memory. ZIP extraction is streamed and CRC-checked, but no web app can load assets larger than the browser/device can support.

## Controls

| Action | Mouse / keyboard |
| --- | --- |
| Orbit / pan / zoom | Drag / Shift-drag / scroll |
| Move / rotate / scale | `W` / `E` / `R` |
| Frame selection / frame all | `F` / `Shift+F` |
| Toggle snapping | `Shift+S` |
| Duplicate / delete | `⌘/Ctrl+D` / `Delete` |
| Undo / redo | `⌘/Ctrl+Z` / `Shift+⌘/Ctrl+Z` |
| Import / save | `⌘/Ctrl+O` / `⌘/Ctrl+S` |
| Play or pause timeline | `Space` |
| Open shortcuts | `?` |

On touch devices, use the viewport gestures and on-screen controls; the interface adapts to narrower layouts. A hardware keyboard is optional.

## Repository map

```text
index.html             App shell and initial loading UI
src/app/               App orchestration, scene, imports, projects, shots, controllers
src/assets/            Model/texture loaders and streamed ZIP reader
src/core/              State, schema, blobs, paths, texture matching, shader helpers
src/engine/            Three.js renderer, scene graph, materials and picking
src/ui/                Dialogs, sidebars, dock, DOM helpers
src/styles/            Theme tokens, layout and component styles
public/decoders/       Local Draco and Basis/KTX2 decoder assets
tests/                 Node tests and compact model, texture, and ZIP fixtures
```

## Notes

- Vite copies the Three.js decoder/transcoder assets into the public directory during development and builds (`scripts/copy-vendor.mjs`).
- The app is a client-side prototype; imported files are untrusted input. Only open assets from sources you trust, and treat custom GLSL as code that runs on your device's GPU.
- `npm run check` is the recommended pre-release verification command. Browser behavior, GPU drivers, and device-specific import limits cannot be fully represented by unit tests.
