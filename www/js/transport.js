// transport.js — moves bytes between the JS protocol and the native socket.
//
// The browser cannot open raw TCP, so the real transport is the native
// `LytroTcp` Capacitor plugin (see native/ios/). This file also exposes a
// capability check so the UI can degrade gracefully on the web (Pages) build,
// where the camera half is simply unavailable.

(function (global) {
  const Cap = global.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const LytroTcp = Cap && Cap.registerPlugin ? Cap.registerPlugin("LytroTcp") : null;

  function b64encode(bytes) {
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }
  function b64decode(str) {
    const bin = atob(str);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  // A request/response transport. readExact(n) resolves with exactly n bytes;
  // the native side buffers the stream and slices on demand.
  class NativeTransport {
    constructor() {
      this.id = null;
    }
    async connect(host, port) {
      if (!LytroTcp) throw new Error("Native TCP plugin not available — run inside the iOS app.");
      const res = await LytroTcp.connect({ host, port });
      this.id = res.connectionId;
    }
    async write(bytes) {
      await LytroTcp.write({ connectionId: this.id, data: b64encode(bytes) });
    }
    async readExact(n) {
      const res = await LytroTcp.read({ connectionId: this.id, length: n });
      return b64decode(res.data);
    }
    async close() {
      if (this.id != null && LytroTcp) {
        try {
          await LytroTcp.close({ connectionId: this.id });
        } catch (_) {
          /* ignore */
        }
      }
      this.id = null;
    }
  }

  global.LytroTransport = {
    NativeTransport,
    isNative,
    available: !!LytroTcp,
    b64encode,
    b64decode,
  };
})(window);
