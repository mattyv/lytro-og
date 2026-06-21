// lytro.js — high-level camera client. Speaks the protocol (protocol.js) over a
// transport (transport.js) and exposes the operations the UI needs:
//   connect → camera info → list photos → download a picture's components.
//
// Transaction shape mirrors lytroctrl: a LOAD command primes the camera, then a
// "read transaction" (CONTENT_LENGTH followed by repeated READ) drains the bytes.

(function (global) {
  const P = global.LytroProto;

  const DEFAULT_HOST = "10.100.1.1";
  const DEFAULT_PORT = 5678;

  class LytroCamera {
    constructor(transport) {
      this.t = transport;
    }

    async connect(host = DEFAULT_HOST, port = DEFAULT_PORT) {
      await this.t.connect(host, port);
    }
    async close() {
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

    async getCameraInfo() {
      const data = await this._loadAndRead(P.getCameraInfo());
      return P.decodeCameraInfo(data);
    }

    async listPhotos() {
      const data = await this._loadAndRead(P.photoList());
      return P.decodePictureList(data);
    }

    // Download one component file (jpg/raw/txt/128/stk). Returns null if the
    // camera reports the file is missing (load ack with zero length).
    async downloadFile(path, onProgress) {
      await this.t.write(P.loadFile(path));
      const ack = await this._recv();
      if (ack.hdr.length === 0) return null; // not found
      return this._readAll(onProgress);
    }

    // Download every component for a picture entry. Missing ones are skipped.
    async downloadPicture(entry, onProgress) {
      const paths = P.picturePaths(entry);
      const files = {};
      for (const type of P.COMPONENTS) {
        const bytes = await this.downloadFile(paths[type], (g, t) => onProgress && onProgress(type, g, t));
        if (bytes) files[type] = bytes;
      }
      return files;
    }
  }

  global.Lytro = { LytroCamera, DEFAULT_HOST, DEFAULT_PORT };
})(window);
