// protocol.js — byte-exact Lytro (original) Wi-Fi control protocol.
//
// Ported from the reverse-engineered references and verified against their
// actual wire bytes:
//   - ea/lytroctrl        (Python, Wi-Fi)  — command framing, transactions
//   - 3b/lytro-dl         (Lisp)           — header layout, photo-list format
//
// Wire frame (control channel, little-endian throughout):
//   off 0  u32  magic = 0xFAAA55AF
//   off 4  u32  length        (payload length, or an expected size for reads)
//   off 8  u32  flags         ((isResponse<<1) | (payloadEmpty?1:0))
//   off 12 u16  commandClass  (0xC2 LOAD, 0xC4 READ, 0xC6 QUERY, ...)
//   off 14 u8   subcommand
//   off 15 13x  parameter bytes (zero-padded)
//   off 28 ...  optional `length`-byte payload
//
// The header is always 28 bytes on the wire. Pure functions only — no I/O —
// so this same file runs in the browser (window.LytroProto) and under Node
// (module.exports) for the test harness.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LytroProto = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SYNC = 0xfaaa55af;
  const HEADER_LEN = 28;

  const CLS = {
    CTRL: 0xc0,
    FW: 0xc1,
    LOAD: 0xc2,
    CLR: 0xc3,
    READ: 0xc4,
    FW_UP: 0xc5,
    QUERY: 0xc6,
  };
  const LOAD = {
    CAMERA_INFO: 0x00,
    FILE: 0x01,
    PHOTO_LIST: 0x02,
    PHOTO: 0x05,
    CALIBRATION: 0x06,
    RAW: 0x0a,
  };
  const QUERY = { CONTENT_LENGTH: 0x00 };
  const READ = { READ: 0x00 };

  const enc = (s) => new TextEncoder().encode(s);

  // Build a 28-byte frame (+ payload appended when present).
  // flags follow lytroctrl: a request with a payload uses flags=0 and
  // length=payload length; a request without one uses flags=1 and the caller's
  // `length` (an upper bound the camera answers within).
  function build({ cls, sub, length = 0, flags = null, params = null, payload = null }) {
    const pay = payload == null ? null : payload instanceof Uint8Array ? payload : enc(String(payload));
    const hasPayload = !!(pay && pay.length);
    if (flags == null) flags = hasPayload ? 0 : 1;
    if (hasPayload) length = pay.length;

    const buf = new Uint8Array(HEADER_LEN + (pay ? pay.length : 0));
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, SYNC, true);
    dv.setUint32(4, length >>> 0, true);
    dv.setUint32(8, flags >>> 0, true);
    dv.setUint16(12, cls, true);
    buf[14] = sub & 0xff;
    if (params) buf.set(params.subarray(0, 13), 15);
    if (pay) buf.set(pay, HEADER_LEN);
    return buf;
  }

  // ----- request builders -----
  const getCameraInfo = () => build({ cls: CLS.LOAD, sub: LOAD.CAMERA_INFO, length: 0 });
  const photoList = () => build({ cls: CLS.LOAD, sub: LOAD.PHOTO_LIST, length: 0 });
  const calibration = () => build({ cls: CLS.LOAD, sub: LOAD.CALIBRATION, length: 0 });
  const loadFile = (path) =>
    build({ cls: CLS.LOAD, sub: LOAD.FILE, payload: new Uint8Array([...enc(path), 0]) });
  const contentLength = () => build({ cls: CLS.QUERY, sub: QUERY.CONTENT_LENGTH, length: 4 });
  const readChunk = () => build({ cls: CLS.READ, sub: READ.READ, length: 0xffff });

  // ----- response parsing -----
  function parseHeader(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return {
      magic: dv.getUint32(0, true),
      length: dv.getUint32(4, true),
      flags: dv.getUint32(8, true),
      cls: dv.getUint16(12, true),
      sub: b[14],
    };
  }

  // null-terminated (or fixed-size) latin1/utf8 string inside a fixed field
  function stringz(bytes, off, size) {
    let end = off;
    const limit = Math.min(off + size, bytes.length);
    while (end < limit && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(off, end));
  }

  // Camera-info blob (offsets confirmed in both references).
  function decodeCameraInfo(b) {
    return {
      manufacturer: stringz(b, 0x000, 0x100),
      serial: stringz(b, 0x100, 0x80),
      firmware: stringz(b, 0x180, 0x80),
      software: stringz(b, 0x200, 0x80),
    };
  }

  // Photo-list blob: a 23 x u32 header, then fixed 128-byte entries.
  function decodePictureList(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = [];
    let o = 23 * 4; // skip header
    while (o + 128 <= b.length) {
      const u32 = (off) => dv.getUint32(off, true);
      const f32 = (off) => dv.getFloat32(off, true);
      const entry = {
        folderSuffix: stringz(b, o + 0, 8),
        filePrefix: stringz(b, o + 8, 8),
        folderNumber: u32(o + 16),
        fileNumber: u32(o + 20),
        liked: u32(o + 40),
        lastLambda: f32(o + 44),
        pictureId: stringz(b, o + 48, 48),
        pictureDate: stringz(b, o + 96, 24),
        rotation: u32(o + 124),
      };
      out.push(entry);
      o += 128;
    }
    return out;
  }

  // The camera's filesystem paths for one picture's component files.
  // e.g. i:\DCIM\100PHOTO\IMG_0027.jpg  (folderNumber=100, suffix=PHOTO, prefix=IMG_, fileNumber=27)
  const COMPONENTS = ["jpg", "raw", "txt", "128", "stk"];
  function picturePaths(entry) {
    const f3 = String(entry.folderNumber).padStart(3, "0");
    const f4 = String(entry.fileNumber).padStart(4, "0");
    const base = `i:\\DCIM\\${f3}${entry.folderSuffix}\\${entry.filePrefix}${f4}.`;
    const paths = {};
    for (const t of COMPONENTS) paths[t] = base + t;
    return paths;
  }

  return {
    SYNC,
    HEADER_LEN,
    CLS,
    LOAD,
    QUERY,
    READ,
    COMPONENTS,
    build,
    getCameraInfo,
    photoList,
    calibration,
    loadFile,
    contentLength,
    readChunk,
    parseHeader,
    stringz,
    decodeCameraInfo,
    decodePictureList,
    picturePaths,
  };
});
