# Lytro OG — Living Picture Viewer

A no-build, static web app that opens Lytro **cooked / web `.LFP`** files and lets you
**refocus by moving across the image** — the original camera's party trick, in the browser.
Move the cursor (or tap on mobile) and the focus plane closest to that point's depth snaps in.
Toggle the **depth map** (`D`) to see the raw 88×60 λ grid the camera shipped inside every file.

No dependencies, no bundler, no backend. It runs straight off GitHub Pages or `file://`.

## Run it

```bash
# any static server works; this avoids file:// fetch quirks for the bundled sample
python3 -m http.server 8000
# open http://localhost:8000
```

Or just push to `main` — the included Pages workflow deploys it automatically.
Drag any `.lfp` onto the window to load your own; a sample loads on first open.

## How it works

`.LFP` is a flat container: an 8-byte magic, then 0x60-byte-headed sections
(a JSON metadata block + a stack of JPEGs + a packed-float depth grid). The focus stack
lives at `views[0].accelerations[0]`:

- `perImage[]` — each JPEG tagged with a `focus` (λ) value
- `depthMap` — a `width × height` grid of little-endian float32 λ values, plus `minLambda`/`maxLambda`

Refocus = read λ at the cursor's grid cell → pick the frame whose `focus` is nearest. That's it.

- `js/lfp.js` — container parser + depth lookup (`window.LFP`)
- `js/viewer.js` — canvas stage, hover-to-refocus, depth HUD, focus rail, drag-drop
- `styles.css` — the instrument console
- `demo/demo.LFP` — a sample living picture

## Scope / not yet

- Handles the **cooked** `.LFP` (focus stack + depth grid). Raw camera `.LFR` (full sensor
  data) isn't decoded here — that's the light-field-rendering project, not a viewer.
- **Camera download** (pulling files off the OG over Wi-Fi) is a separate piece — browsers
  can't open raw TCP sockets, so that lives in a Capacitor-wrapped build, not this static app.

## Credits

Format groundwork by the Lytro reverse-engineering community: `nrpatel/lfptools`,
`bkerley/lfp-viewer`, and Jan Kučera's "Lytro Meltdown". Sample file via `bkerley/lfp-viewer`.
