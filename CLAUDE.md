# CLAUDE.md — Lytro OG

Context for future sessions. Two halves: a **static viewer** (browser/Pages) and a
**native Wi-Fi ingest** path (Capacitor iOS). Read this before changing protocol
or container code — the facts below are verified, don't re-derive them.

## Layout

```
www/                     # the entire web UI (Capacitor webDir + GitHub Pages root)
  index.html             # viewer + camera panel
  styles.css             # petrol/amber instrument theme
  js/
    lfp.js               # cooked .LFP container parser + depth lookup  (window.LFP)
    viewer.js            # canvas stage: hover-refocus, focus/aperture sliders, depth HUD, rail
    protocol.js          # byte-exact Lytro Wi-Fi protocol (UMD: window.LytroProto + node)
    protocol.test.js     # node test, asserts frames are byte-identical to the reference
    transport.js         # bridge to native LytroTcp plugin (window.LytroTransport)
    lytro.js             # high-level camera client (window.Lytro.LytroCamera)
    ingest.js            # camera panel UI
  demo/demo.LFP          # sample living picture
native/ios/LytroTcp/     # Swift plugin (raw TCP, Wi-Fi-pinned) — copied into ios/ by hand
native/ios/README.md     # how to build the iOS app + Info.plist/entitlements
capacitor.config.json    # appId com.mattyv.lytroog, webDir: www
.github/workflows/pages.yml  # deploys www/ (viewer only) to Pages on push to main
```

No bundler. The web layer is vanilla JS off `file://`/Pages; Capacitor plugins are
reached at runtime via `Capacitor.registerPlugin(name)`, so no npm import is needed
in the browser code. `npm install` is only for the Capacitor CLI + iOS build.

## Cooked `.LFP` container format (the viewer's input)

- 8-byte magic `89 4C 46 50 0D 0A 1A 0A`; sections begin at `0x10`.
- Section header = `0x60` bytes: type byte at `+3` (`0x4D 'M'` JSON, `0x43 'C'` blob),
  `uint32` **big-endian** length at `+12`, 48-byte sha1 name at `+16`. Content at
  `+0x60`, padded up to a `0x10` boundary.
- Focus stack at `meta.views[0].accelerations[0]`: `perImage[] = {imageRef, focus(λ)}`;
  `depthMap = {imageRef, width, height, minLambda, maxLambda}`.
- depthMap bytes = **little-endian float32**, one λ per cell. Refocus = read λ at the
  cursor's grid cell, pick the frame whose `focus` is nearest. (`js/lfp.js`)

## Camera Wi-Fi protocol (the ingest input) — VERIFIED

Ported from `ea/lytroctrl` (Python) and `3b/lytro-dl` (Lisp); `protocol.test.js`
asserts byte-equality with the Python reference's actual output.

- Control channel: TCP `10.100.1.1:5678`. (`lytro-dl` also mentions 5677 callback /
  5679 download; lytroctrl and our client use 5678 only.)
- **Frame (28-byte header, little-endian):** `u32 magic 0xFAAA55AF` · `u32 length` ·
  `u32 flags` · `u16 cmdClass` · `u8 subcommand` · 13 param bytes, then `length`
  payload bytes. `flags = (isResponse<<1) | (payloadEmpty?1:0)`.
- Command classes: `0xC2 LOAD`, `0xC4 READ`, `0xC6 QUERY` (also C0 CTRL, C1/C5 FW,
  C3 CLR). LOAD subs: `00` camera-info, `01` file, `02` photo-list, `05` photo,
  `06` calibration, `0a` raw.
- **Read transaction:** a LOAD primes the camera → `QUERY 0xC6 00` returns a `u32`
  total → repeated `READ 0xC4 00` (length `0xffff`) until the total is drained.
- **Camera info blob:** strings at `0x000` manufacturer, `0x100` serial, `0x180`
  firmware, `0x200` software (null-terminated within fixed fields).
- **Photo list blob:** 23×`u32` header, then 128-byte entries:
  folderSuffix `s8`, filePrefix `s8`, folderNumber `u32`, fileNumber `u32`,
  (4×u32 unknown), liked `u32`, lastLambda `f32`, pictureId `s48`, pictureDate
  `s24`, (u32 unknown), rotation `u32`.
- **Per-picture files** are separate components, path
  `i:\DCIM\<folder3><suffix>\<prefix><file4>.<ext>` with `ext ∈ {jpg,raw,txt,128,stk}`.
  `jpg` = flat preview. There is **no cooked `.LFP` on the camera** — that's a Lytro
  Desktop export. So from the camera you get a flat JPEG immediately; true refocus
  needs raw+calibration processing (out of scope). `ingest.js` opportunistically
  tries `LFP.parse` on `.stk` and offers the refocus viewer if it happens to parse.

### Unlock (NOT needed for download)

`SHA1(serial + " please")` sent via `CmdExec` (CTRL `0xFF`) only unlocks remote
capture / live view / manual lens / code-exec. The download path never touches it —
zero brick risk. Don't add it unless building those extras.

## The iOS routing trap

The camera AP has no internet; iOS routes a normal socket over cellular and never
reaches `10.100.1.1`. The fix is in `LytroTcpConnection.swift`:
`NWParameters.requiredInterfaceType = .wifi`. Also requires
`NSLocalNetworkUsageDescription` in Info.plist (iOS 14+). See `native/ios/README.md`.

## Status / testability

- `protocol.js`, container parsing, refocus math: **verified** (node test + against
  the real sample file).
- iOS plugin + end-to-end ingest: **written, not run on hardware** (no camera / no
  Xcode in this environment). Treat the device flow as unverified until tested.

## Commands

```bash
npm run serve            # static-serve www/ at :8000 (viewer; camera panel shows "needs app")
npm run test:protocol    # node frame-equivalence test
# iOS build: see native/ios/README.md
```
