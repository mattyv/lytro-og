# iOS native layer — Wi-Fi camera ingest

The web app in `www/` is the whole UI. To talk to the camera you wrap it in a
Capacitor iOS app and add the `LytroTcp` plugin (the Swift files in this folder),
which gives the web layer a raw TCP socket pinned to the Wi-Fi interface.

> You need **macOS + Xcode** for everything below. The repo cannot build iOS on
> Linux/CI, so this is the on-device half.

## Prerequisites (toolchain)

These aren't bundled — install them once on the Mac:

```bash
# Node.js (LTS) — for the Capacitor CLI. Skip if `node -v` already works.
brew install node

# Full Xcode — Command Line Tools alone are NOT enough; `npx cap add ios`/build need it.
brew install xcodes
xcodes install --latest        # interactive: Apple ID + 2FA, ~12GB; auto-selects when done
# (or install Xcode from the Mac App Store, then: sudo xcode-select -s /Applications/Xcode.app)

# CocoaPods — `cap add ios` runs `pod install`.
brew install cocoapods
```

Sanity check before continuing — all three must print a version:

```bash
node -v && xcodebuild -version && pod --version
```

A free Apple ID is enough to build to your own device (7-day signing). A paid
Apple Developer account is only needed for `NEHotspotConfiguration` (joining the
camera Wi-Fi from inside the app) — see the optional section below.

## One-time setup

```bash
npm install
npx cap add ios          # generates the ios/ Xcode project (gitignored)
npx cap sync
```

## Add the LytroTcp plugin

Copy the two Swift files into the generated app target:

```bash
mkdir -p ios/App/App/plugins
cp native/ios/LytroTcp/*.swift ios/App/App/plugins/
```

Then open Xcode (`npx cap open ios`) and drag `ios/App/App/plugins` into the
**App** target so the files are compiled (check "Copy items if needed" off — they
already live in the project). Capacitor 6 auto-registers the plugin because it
conforms to `CAPBridgedPlugin`; no `.m` file or JS package is required.

## Required Info.plist key — local network

iOS 14+ blocks connections to local IPs until the user grants the Local Network
permission. In Xcode, add to the App target's **Info.plist**:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to your Lytro camera over its Wi-Fi to download photos.</string>
```

Without this, `connect` fails silently / times out.

## Optional — join the camera's Wi-Fi from inside the app

By default the user joins the camera's network in iOS **Settings**, then opens the
app and taps connect. To join programmatically you need `NEHotspotConfiguration`,
which requires the **Hotspot Configuration** capability (paid Apple Developer
account) — add it in Xcode under Signing & Capabilities, then:

```swift
import NetworkExtension

func joinCameraWifi(ssid: String, completion: @escaping (Error?) -> Void) {
    let cfg = NEHotspotConfiguration(ssid: ssid)   // add (ssid:passphrase:isWEP:) if secured
    cfg.joinOnce = true
    NEHotspotConfigurationManager.shared.apply(cfg, completionHandler: completion)
}
```

This is intentionally not wired into `LytroTcp` yet — the TCP path works the
moment you're on the camera's network by any means.

## Rebuild after web changes

```bash
npx cap copy ios     # push updated www/ into the app
```

## What the plugin does / doesn't do

- **Does:** opens TCP to `10.100.1.1:5678`, pinned to Wi-Fi; streams bytes with a
  `read(length)` that returns exactly N bytes (the protocol is length-framed).
- **Doesn't:** parse anything — all framing/decoding lives in `www/js/protocol.js`
  and `www/js/lytro.js`, which are unit-tested in Node (`npm run test:protocol`).

## Untested on hardware

This plugin is written against the documented protocol and the
`ea/lytroctrl` / `3b/lytro-dl` references, but has **not** been run against a real
camera. Expect to verify: the Local Network prompt flow, the Wi-Fi pin actually
selecting `en0`, and the read-loop chunk sizes on large `.raw` files.
