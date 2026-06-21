// protocol.test.js — verifies the JS frame builder is byte-identical to the
// reference (ea/lytroctrl). Expected hex strings were captured by running the
// actual Python: `Message.build(base_msg_len=28).hex()`. Run: `npm run test:protocol`.

const P = require("./protocol.js");

let fails = 0;
const hex = (u8) => Buffer.from(u8).toString("hex");
function eq(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      got : ${got}`);
    console.log(`      want: ${want}`);
    fails++;
  }
}

// --- frame bytes, straight from the Python reference ---
eq("getCameraInfo", hex(P.getCameraInfo()),
   "af55aafa0000000001000000c2000000000000000000000000000000");
eq("contentLength", hex(P.contentLength()),
   "af55aafa0400000001000000c6000000000000000000000000000000");
eq("readChunk", hex(P.readChunk()),
   "af55aafaffff000001000000c4000000000000000000000000000000");
eq("loadFile(sha1-abc)", hex(P.loadFile("sha1-abc")),
   "af55aafa0900000000000000c2000100000000000000000000000000736861312d61626300");

// photoList: LOAD class, subcommand 0x02, no payload (mirrors getCameraInfo)
eq("photoList", hex(P.photoList()),
   "af55aafa0000000001000000c2000200000000000000000000000000");

// --- header round-trip ---
const h = P.parseHeader(P.contentLength());
eq("parse magic", "0x" + h.magic.toString(16), "0x" + P.SYNC.toString(16));
eq("parse length", String(h.length), "4");
eq("parse flags", String(h.flags), "1");
eq("parse cls", "0x" + h.cls.toString(16), "0xc6");
eq("parse sub", String(h.sub), "0");

// --- picturePaths formatting ---
const paths = P.picturePaths({ folderNumber: 100, folderSuffix: "PHOTO", filePrefix: "IMG_", fileNumber: 27 });
eq("picturePath jpg", paths.jpg, "i:\\DCIM\\100PHOTO\\IMG_0027.jpg");
eq("picturePath stk", paths.stk, "i:\\DCIM\\100PHOTO\\IMG_0027.stk");

// --- decodePictureList round-trip (synthetic 1-entry blob) ---
(function () {
  const buf = new Uint8Array(23 * 4 + 128);
  const dv = new DataView(buf.buffer);
  const o = 23 * 4;
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  wstr(o + 0, "PHOTO");
  wstr(o + 8, "IMG_");
  dv.setUint32(o + 16, 100, true);
  dv.setUint32(o + 20, 27, true);
  dv.setUint32(o + 40, 1, true);          // liked
  dv.setFloat32(o + 44, -1.5, true);      // lastLambda
  wstr(o + 48, "abc123");                  // pictureId
  wstr(o + 96, "2014-01-02");              // pictureDate
  dv.setUint32(o + 124, 90, true);         // rotation
  const list = P.decodePictureList(buf);
  eq("list length", String(list.length), "1");
  eq("list folderNumber", String(list[0].folderNumber), "100");
  eq("list fileNumber", String(list[0].fileNumber), "27");
  eq("list lastLambda", String(list[0].lastLambda), "-1.5");
  eq("list pictureId", list[0].pictureId, "abc123");
  eq("list rotation", String(list[0].rotation), "90");
})();

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
