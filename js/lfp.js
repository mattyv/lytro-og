// lfp.js — parse a Lytro "cooked"/web .LFP (focus-stack + depth grid).
// Pure browser JS, no build step. Exposes window.LFP.parse(arrayBuffer).
//
// Container layout (confirmed against real files):
//   file: 8-byte magic 89 4C 46 50 0D 0A 1A 0A, then sections begin at 0x10
//   section header = 0x60 bytes:
//     +3   type byte  (0x4D 'M' metadata JSON, 0x43 'C' component blob)
//     +12  uint32 big-endian content length
//     +16  48-byte name field ("sha1-..." ref, null padded)
//     +0x60 content; whole section padded up to a 0x10 boundary
//
// The metadata 'M' section is JSON. The focus stack lives at
//   meta.views[0].accelerations[0]:
//     .perImage[]  -> { imageRef, focus }   (focus is a lambda value)
//     .depthMap    -> { imageRef, width, height, minLambda, maxLambda }
//   depthMap bytes are little-endian float32, one lambda per grid cell.

(function (global) {
  const MAGIC = [0x89, 0x4c, 0x46]; // \x89 L F
  const HEADER = 0x60;

  function sections(buf) {
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const dec = new TextDecoder();
    const out = [];
    let pos = 0x10;
    while (pos < buf.byteLength) {
      if (!(bytes[pos] === MAGIC[0] && bytes[pos + 1] === MAGIC[1] && bytes[pos + 2] === MAGIC[2])) break;
      const type = bytes[pos + 3];
      const len = dv.getUint32(pos + 12, false);
      const name = dec
        .decode(bytes.subarray(pos + 16, pos + 16 + 0x30))
        .replace(/\0/g, "");
      const start = pos + HEADER;
      out.push({ type, name, start, len });
      const total = len + HEADER;
      const rem = total % 0x10;
      pos += rem ? total - rem + 0x10 : total;
    }
    return out;
  }

  function parse(buf) {
    const secs = sections(buf);
    if (!secs.length) throw new Error("Not an LFP file (no sections found).");

    const dec = new TextDecoder();
    const metaSec = secs.find((s) => s.type === 0x4d);
    if (!metaSec) throw new Error("No metadata section — is this a cooked/web .LFP? Raw camera .LFR isn't supported yet.");

    let meta;
    try {
      meta = JSON.parse(dec.decode(new Uint8Array(buf, metaSec.start, metaSec.len)));
    } catch (e) {
      throw new Error("Metadata isn't valid JSON.");
    }

    const accel = meta?.views?.[0]?.accelerations?.[0];
    if (!accel || accel.kind !== "focusStack" || !accel.perImage) {
      throw new Error("No focus stack in this file — nothing to refocus.");
    }

    const byName = new Map(secs.map((s) => [s.name, s]));
    const toBlobURL = (sec) =>
      URL.createObjectURL(new Blob([buf.slice(sec.start, sec.start + sec.len)]));

    const frames = accel.perImage
      .slice()
      .sort((a, b) => a.focus - b.focus)
      .map((p) => {
        const sec = byName.get(p.imageRef);
        if (!sec) return null;
        return { focus: p.focus, url: toBlobURL(sec) };
      })
      .filter(Boolean);

    if (!frames.length) throw new Error("Focus-stack frames are missing from the file.");

    const dm = accel.depthMap;
    let depth = null;
    if (dm && byName.has(dm.imageRef)) {
      const s = byName.get(dm.imageRef);
      depth = {
        w: dm.width,
        h: dm.height,
        min: dm.minLambda,
        max: dm.maxLambda,
        data: new Float32Array(buf.slice(s.start, s.start + s.len)),
      };
    }

    return {
      frames,
      depth,
      width: accel.width || 704,
      height: accel.height || 480,
    };
  }

  // Lambda (focus depth) at normalized image coords u,v in [0,1].
  function lambdaAt(depth, u, v) {
    if (!depth) return null;
    const gx = Math.min(depth.w - 1, Math.max(0, Math.floor(u * depth.w)));
    const gy = Math.min(depth.h - 1, Math.max(0, Math.floor(v * depth.h)));
    return depth.data[gy * depth.w + gx];
  }

  function nearestFrame(frames, lambda) {
    let bi = Math.floor(frames.length / 2),
      bd = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i].focus - lambda);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  }

  global.LFP = { parse, lambdaAt, nearestFrame };
})(window);
