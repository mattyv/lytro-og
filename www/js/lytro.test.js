// lytro.test.js — drives the high-level client (lytro.js) against a mock camera
// that speaks the real wire protocol. This exercises the full LOAD → CONTENT_LENGTH
// → READ transaction loop, the "file not found" path, and the decoders end-to-end,
// without any hardware. Run: `node www/js/lytro.test.js`.

const P = require("./protocol.js");
const { LytroCamera } = require("./lytro.js");

let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      got : ${got}`);
    console.log(`      want: ${want}`);
    fails++;
  }
}

// ---- build synthetic camera blobs ----
function cameraInfoBlob() {
  const b = new Uint8Array(0x300);
  const put = (off, s) => { for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i); };
  put(0x000, "LYTRO");
  put(0x100, "B5000123");
  put(0x180, "1.2.2");
  put(0x200, "3.0.1");
  return b;
}
function photoListBlob(entries) {
  const b = new Uint8Array(23 * 4 + entries.length * 128);
  const dv = new DataView(b.buffer);
  let o = 23 * 4;
  const put = (off, s) => { for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i); };
  for (const e of entries) {
    put(o + 0, e.folderSuffix);
    put(o + 8, e.filePrefix);
    dv.setUint32(o + 16, e.folderNumber, true);
    dv.setUint32(o + 20, e.fileNumber, true);
    dv.setUint32(o + 40, e.liked || 0, true);
    dv.setFloat32(o + 44, e.lastLambda || 0, true);
    put(o + 48, e.pictureId);
    put(o + 96, e.pictureDate);
    dv.setUint32(o + 124, e.rotation || 0, true);
    o += 128;
  }
  return b;
}

// ---- mock camera transport ----
function respFrame(payload) {
  const len = payload ? payload.length : 0;
  const f = new Uint8Array(28 + len);
  const dv = new DataView(f.buffer);
  dv.setUint32(0, P.SYNC, true);
  dv.setUint32(4, len, true);
  dv.setUint32(8, len ? 2 : 3, true); // isResponse bit; client ignores flags
  if (payload) f.set(payload, 28);
  return f;
}

class MockCamera {
  constructor({ info, photos, files, calibration }) {
    this.info = info;
    this.photos = photos;
    this.files = files; // path -> Uint8Array
    this.calibration = calibration;
    this.out = [];
    this.primed = null;
    this.offset = 0;
    this.connected = false;
  }
  async connect() { this.connected = true; }
  async close() { this.connected = false; }

  _enqueue(bytes) { this.out.push(bytes); }
  _prime(blob) { this.primed = blob; this.offset = 0; }

  async write(frame) {
    const hdr = P.parseHeader(frame.subarray(0, 28));
    const payload = frame.subarray(28, 28 + hdr.length);
    if (hdr.cls === P.CLS.LOAD) {
      if (hdr.sub === P.LOAD.CAMERA_INFO) { this._enqueue(respFrame()); this._prime(this.info); }
      else if (hdr.sub === P.LOAD.PHOTO_LIST) { this._enqueue(respFrame()); this._prime(this.photos); }
      else if (hdr.sub === P.LOAD.CALIBRATION) { this._enqueue(respFrame()); this._prime(this.calibration); }
      else if (hdr.sub === P.LOAD.FILE) {
        const path = new TextDecoder().decode(payload).replace(/\0+$/, "");
        const file = this.files[path];
        if (file) { this._enqueue(respFrame(new TextEncoder().encode(path))); this._prime(file); }
        else { this._enqueue(respFrame()); this._prime(null); } // not found: ack length 0
      }
    } else if (hdr.cls === P.CLS.QUERY) {
      const total = this.primed ? this.primed.length : 0;
      const p = new Uint8Array(4);
      new DataView(p.buffer).setUint32(0, total, true);
      this._enqueue(respFrame(p));
    } else if (hdr.cls === P.CLS.READ) {
      const chunk = this.primed ? this.primed.subarray(this.offset, this.offset + 0xffff) : new Uint8Array(0);
      this.offset += chunk.length;
      this._enqueue(respFrame(chunk));
    }
  }

  async readExact(n) {
    // flatten queue until we have n bytes
    let avail = this.out.reduce((s, c) => s + c.length, 0);
    if (avail < n) throw new Error(`mock underflow: wanted ${n}, have ${avail}`);
    const result = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.out[0];
      const take = Math.min(head.length, n - filled);
      result.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.out.shift();
      else this.out[0] = head.subarray(take);
    }
    return result;
  }
}

(async function main() {
  const entries = [
    { folderSuffix: "PHOTO", filePrefix: "IMG_", folderNumber: 100, fileNumber: 27,
      liked: 1, lastLambda: -1.5, pictureId: "pic-aaa", pictureDate: "2014-12-22", rotation: 0 },
    { folderSuffix: "PHOTO", filePrefix: "IMG_", folderNumber: 100, fileNumber: 28,
      liked: 0, lastLambda: 3.25, pictureId: "pic-bbb", pictureDate: "2014-12-23", rotation: 90 },
  ];
  // make a >64KB file to force multi-chunk READ loop
  const bigJpg = new Uint8Array(0xffff * 2 + 123).map((_, i) => i & 0xff);
  const stk = new Uint8Array([1, 2, 3, 4, 5]);
  const paths = P.picturePaths(entries[0]);

  const mock = new MockCamera({
    info: cameraInfoBlob(),
    photos: photoListBlob(entries),
    calibration: new Uint8Array([0xca, 0x11, 0xb0]),
    files: { [paths.jpg]: bigJpg, [paths.stk]: stk }, // raw/txt/128 intentionally missing
  });

  const cam = new LytroCamera(mock);
  await cam.connect("10.100.1.1", 5678);

  const info = await cam.getCameraInfo();
  eq("info.manufacturer", info.manufacturer, "LYTRO");
  eq("info.serial", info.serial, "B5000123");
  eq("info.firmware", info.firmware, "1.2.2");
  eq("info.software", info.software, "3.0.1");

  const photos = await cam.listPhotos();
  eq("photos length", photos.length, 2);
  eq("photo[0] id", photos[0].pictureId, "pic-aaa");
  eq("photo[1] fileNumber", photos[1].fileNumber, 28);
  eq("photo[1] lastLambda", photos[1].lastLambda, 3.25);

  // multi-chunk download integrity
  let lastPct = 0;
  const jpg = await cam.downloadFile(paths.jpg, (g, t) => (lastPct = Math.round((g / t) * 100)));
  eq("jpg length", jpg.length, bigJpg.length);
  eq("jpg first byte", jpg[0], 0);
  eq("jpg last byte", jpg[jpg.length - 1], bigJpg[bigJpg.length - 1]);
  eq("jpg progress hit 100", lastPct, 100);

  // missing file -> null
  const missing = await cam.downloadFile(paths.raw);
  eq("missing file is null", missing, null);

  // downloadPicture skips missing components
  const files = await cam.downloadPicture(entries[0]);
  eq("downloaded components", Object.keys(files).sort().join(","), "jpg,stk");
  eq("stk bytes", files.stk.join(","), "1,2,3,4,5");

  const calib = await cam.getCalibration();
  eq("calibration bytes", calib.join(","), "202,17,176");

  await cam.close();

  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
  process.exit(fails ? 1 : 0);
})();
