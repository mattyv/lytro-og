// lytro.js — high-level camera client. Speaks the protocol (protocol.js) over a
// transport and exposes the operations the UI needs: connect → camera info →
// list photos → download a picture's components (+ calibration).
//
// All socket operations are serialized through a single queue (`_run`) so the
// request/response stream can't interleave — important because the UI and the
// keep-alive timer can both poke the camera. Transaction shape mirrors lytroctrl:
// a LOAD command primes the camera, then CONTENT_LENGTH + repeated READ drains it.
//
// UMD: window.Lytro in the browser, require()-able in Node for the test harness.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./protocol.js"));
  else root.Lytro = factory(root.LytroProto);
})(typeof self !== "undefined" ? self : this, function (P) {
  const DEFAULT_HOST = "10.100.1.1";
  const DEFAULT_PORT = 5678;

  class LytroCamera {
    constructor(transport) {
      this.t = transport;
      this._chain = Promise.resolve();
      this._keepAlive = null;
    }

    // serialize every camera operation onto one queue
    _run(fn) {
      const next = this._chain.then(fn, fn);
      // keep the chain alive but don't let rejections poison the next op
      this._chain = next.catch(() => {});
      return next;
    }

    async connect(host = DEFAULT_HOST, port = DEFAULT_PORT) {
      await this.t.connect(host, port);
    }
    async close() {
      this.stopKeepAlive();
      await this.t.close();
    }

    // read one framed response: 28-byte header, then `length` payload bytes
    async _recv() {
      const head = await this.t.readExact(P.HEADER_LEN);
      const hdr = P.parseHeader(head);
      const payload = hdr.length ? await this.t.readExact(hdr.length) : new Uint8Array(0);
      return { hdr, payload };
    }

    // CONTENT_LENGTH (u32) then READ in a loop until the full blob is in hand
    async _readAll(onProgress) {
      await this.t.write(P.contentLength());
      const cl = await this._recv();
      if (cl.payload.length < 4) return new Uint8Array(0);
      const total = new DataView(
        cl.payload.buffer,
        cl.payload.byteOffset,
        cl.payload.byteLength
      ).getUint32(0, true);
      if (!total) return new Uint8Array(0);

      const out = new Uint8Array(total);
      let got = 0;
      while (got < total) {
        await this.t.write(P.readChunk());
        const chunk = await this._recv();
        if (chunk.payload.length === 0) break; // guard against stalls
        const take = Math.min(chunk.payload.length, total - got);
        out.set(chunk.payload.subarray(0, take), got);
        got += take;
        if (onProgress) onProgress(got, total);
      }
      return out;
    }

    // LOAD <sub> primes the camera, then drain the bytes
    async _loadAndRead(loadMsg, onProgress) {
      await this.t.write(loadMsg);
      await this._recv(); // acknowledgement
      return this._readAll(onProgress);
    }

    getCameraInfo() {
      return this._run(async () => P.decodeCameraInfo(await this._loadAndRead(P.getCameraInfo())));
    }

    listPhotos() {
      return this._run(async () => P.decodePictureList(await this._loadAndRead(P.photoList())));
    }

    getCalibration(onProgress) {
      return this._run(() => this._loadAndRead(P.calibration(), onProgress));
    }

    // Download one component file (jpg/raw/txt/128/stk). Resolves null if the
    // camera reports the file missing (load ack with zero length).
    downloadFile(path, onProgress) {
      return this._run(async () => {
        await this.t.write(P.loadFile(path));
        const ack = await this._recv();
        if (ack.hdr.length === 0) return null; // not found
        return this._readAll(onProgress);
      });
    }

    // Download every component for a picture entry; missing ones are skipped.
    async downloadPicture(entry, onProgress) {
      const paths = P.picturePaths(entry);
      const files = {};
      for (const type of P.COMPONENTS) {
        const bytes = await this.downloadFile(paths[type], (g, t) => onProgress && onProgress(type, g, t));
        if (bytes) files[type] = bytes;
      }
      return files;
    }

    // Periodic no-op to keep the camera's Wi-Fi watchdog from sleeping. Runs
    // through the same queue, so it never collides with a real transfer.
    startKeepAlive(intervalMs = 25000) {
      this.stopKeepAlive();
      this._keepAlive = setInterval(() => {
        this.getCameraInfo().catch(() => {});
      }, intervalMs);
    }
    stopKeepAlive() {
      if (this._keepAlive) {
        clearInterval(this._keepAlive);
        this._keepAlive = null;
      }
    }
  }

  return { LytroCamera, DEFAULT_HOST, DEFAULT_PORT };
});
