#!/usr/bin/env bash
# TDD guard for the dead-strip bug: the LytroTcp Capacitor plugin is an @objc
# class discovered by Capacitor at runtime, so nothing references it at link
# time and `-dead_strip` (DEAD_CODE_STRIPPING=YES) silently drops it from the
# final binary — the plugin compiles and links but is absent at runtime, and JS
# sees "native tcp not available".
#
# This test asserts the plugin actually survives into the shipped App binary.
#   RED   before the fix (symbol stripped)
#   GREEN after a retained reference keeps it
#
# Usage:
#   native/ios/test_plugin_linked.sh           # inspect the latest Debug build
#   BUILD=1 native/ios/test_plugin_linked.sh   # build first, then inspect
set -euo pipefail
cd "$(dirname "$0")/../.."

DEVICE_ID="${DEVICE_ID:-00008140-001615040133001C}"

if [ "${BUILD:-0}" = "1" ]; then
  echo "building (Debug, device)…"
  xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug \
    -destination "id=$DEVICE_ID" -allowProvisioningUpdates build >/dev/null
fi

APP=$(ls -dt ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app 2>/dev/null | head -1 || true)
if [ -z "$APP" ] || [ ! -f "$APP/App" ]; then
  echo "FAIL: no built App binary found (run with BUILD=1 first)"; exit 2
fi
BIN="$APP/App"
echo "inspecting: $BIN"

fail=0

# 1) the plugin's Swift class symbol must be present in the linked binary
if nm "$BIN" 2>/dev/null | grep -q "LytroTcpPlugin"; then
  echo "PASS: LytroTcpPlugin class symbol present in binary"
else
  echo "FAIL: LytroTcpPlugin class symbol missing (dead-stripped)"; fail=1
fi

# 2) the jsName Capacitor matches on ('LytroTcp') must survive as a string literal
if strings -a "$BIN" 2>/dev/null | grep -q "lytroog.tcp"; then
  echo "PASS: plugin code present (dispatch queue label found)"
else
  echo "FAIL: plugin string literals missing from binary"; fail=1
fi

if [ "$fail" = 0 ]; then
  echo "OK — LytroTcp plugin is linked into the app"
else
  echo "PLUGIN NOT LINKED — Capacitor will report it as unavailable at runtime"
fi
exit $fail
