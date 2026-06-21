# Lytro OG

Two things for the original Lytro light-field camera, in one repo:

1. **Living-picture viewer** — a no-build static web app that opens cooked Lytro
   `.LFP` files and **refocuses as you move across the image**. Runs in any browser
   and on GitHub Pages.
2. **Wi-Fi camera ingest** — a Capacitor iOS wrapper that gives the same web app a
   raw TCP socket so it can connect to the camera over Wi-Fi, list pictures, and
   download them. (Native build required — a browser can't open raw TCP.)

The web layer is shared; the ingest half only lights up inside the iOS app.

## The viewer

Move the cursor (or tap on mobile) and the focus plane closest to that point's
depth snaps in. Toggle the **depth map** (`D`) to see the raw λ grid. The header has
a **focus** slider (scrub planes directly) and an **aperture** slider (blend adjacent
planes for deeper depth of field).

```bash
npm run serve        # static-serve www/ at http://localhost:8000
```

Or push to `main` — `.github/workflows/pages.yml` deploys `www/` to Pages. Drag any
`.lfp` onto the window to load your own; a sample loads on first open.

### How refocus works

`.LFP` is a flat container (8-byte magic, then `0x60`-headed sections: a JSON
metadata block + a stack of JPEGs + a packed-float depth grid). The focus stack is
at `views[0].accelerations[0]`: `perImage[]` (each JPEG tagged with a `focus` λ) and
`depthMap` (a `w×h` grid of little-endian float32 λ). Refocus = read λ at the
cursor's grid cell → draw the frame whose `focus` is nearest. (`www/js/lfp.js`)

## The Wi-Fi ingest (iOS)

The camera runs as a Wi-Fi access point speaking a raw-TCP binary protocol on
`10.100.1.1:5678` — **not** HTTP, so a browser/Pages site fundamentally can't reach
it. The native app provides a `LytroTcp` Capacitor plugin (a `Network.framework`
socket pinned to the Wi-Fi interface) and the web UI drives it.

The protocol port is **verified in software** with headless Node tests (also run
in CI): `protocol.js` is byte-for-byte identical to the reference frames, and the
high-level client is driven through the full download transaction against a mock
camera (multi-chunk reads, missing files, calibration).

```bash
npm test
```

Building and running on a device needs macOS + Xcode — see
[`native/ios/README.md`](native/ios/README.md). The plugin and end-to-end flow are
written against the documented protocol but **have not been run against a real
camera** (no hardware/Xcode in the dev environment used to build this).

> Note: the camera stores each shot as separate component files
> (`.jpg` preview, `.raw`, `.txt`, `.128`, `.stk`) — there is no cooked `.LFP` on the
> camera (that's a Lytro Desktop export). So ingest gives you a flat JPEG preview
> immediately; full post-hoc refocus from raw sensor data is a separate project.

## Repo map

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and the verified format/
protocol facts. Quick version:

```
www/            shared web app (viewer + camera panel) — Capacitor webDir + Pages root
native/ios/     Swift TCP plugin + iOS build instructions
capacitor.config.json
```

## Credits

Format and protocol groundwork by the Lytro reverse-engineering community:
`ea/lytroctrl` & `ea/lytro_unlock`, `3b/lytro-dl`, `nrpatel/lfptools`,
`bkerley/lfp-viewer`, and Jan Kučera's "Lytro Meltdown". Sample file via
`bkerley/lfp-viewer`.
