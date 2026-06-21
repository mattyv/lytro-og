// viewer.js — the focusing console. Loads frames, refocuses on pointer move,
// draws the depth HUD + crosshair, the focus-stack rail, and a depth heatmap.

(function () {
  const COOL = [0x5e, 0xc8, 0xd8]; // near-focus end of the depth ramp
  const WARM = [0xff, 0xb2, 0x3e]; // far-focus end / active accent

  const el = (id) => document.getElementById(id);
  const stage = el("stage");
  const ctx = stage.getContext("2d");
  const railEl = el("rail");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let model = null; // { frames:[{focus,url,img}], depth, width, height }
  let active = 0; // index into frames
  let fade = 1; // 0..1 crossfade progress
  let prevActive = 0;
  let imgRect = { x: 0, y: 0, w: 0, h: 0 };
  let cursor = null; // {x,y} in canvas px, or null
  let showDepth = false;
  let depthCanvas = null;
  let spread = 0; // aperture: ± planes blended around the active one

  // ---------- loading ----------
  function setStatus(msg, kind) {
    const s = el("status");
    s.textContent = msg || "";
    s.className = "status" + (kind ? " " + kind : "");
  }

  function loadImage(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("frame decode failed"));
      im.src = url;
    });
  }

  async function load(buf, label) {
    setStatus("Reading " + (label || "file") + "…");
    let parsed;
    try {
      parsed = window.LFP.parse(buf);
    } catch (e) {
      setStatus(e.message, "error");
      return;
    }
    try {
      const imgs = await Promise.all(parsed.frames.map((f) => loadImage(f.url)));
      parsed.frames.forEach((f, i) => (f.img = imgs[i]));
    } catch (e) {
      setStatus("Couldn't decode the focus-stack images.", "error");
      return;
    }
    if (model) model.frames.forEach((f) => URL.revokeObjectURL(f.url));
    model = parsed;
    active = prevActive = Math.floor(model.frames.length / 2);
    fade = 1;
    showDepth = false;
    el("depthBtn").setAttribute("aria-pressed", "false");
    depthCanvas = model.depth ? buildDepthCanvas(model.depth) : null;
    renderMeta();
    resetControls();
    buildRail();
    resize();
    setStatus(
      model.frames.length + " focus planes" +
        (model.depth ? " · depth " + model.depth.w + "×" + model.depth.h : " · no depth map"),
      "ok"
    );
    el("stagewrap").classList.add("loaded");
  }

  function loadFiles(fileList) {
    const file = [...fileList].find((f) => /\.(lfp|lfr)$/i.test(f.name)) || fileList[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => load(r.result, file.name);
    r.readAsArrayBuffer(file);
  }

  // ---------- metadata panel ----------
  function renderMeta() {
    const p = el("metapanel");
    const rows = (model && model.info) || [];
    if (!rows.length) {
      p.innerHTML = '<div class="meta-empty">no metadata</div>';
      return;
    }
    p.innerHTML =
      '<div class="meta-title">picture metadata</div>' +
      rows
        .map(
          ([k, v]) =>
            '<div class="meta-row"><span>' + k + "</span><b>" + v + "</b></div>"
        )
        .join("");
  }

  // ---------- depth heatmap ----------
  function ramp(t) {
    t = Math.min(1, Math.max(0, t));
    return [0, 1, 2].map((i) => Math.round(COOL[i] + (WARM[i] - COOL[i]) * t));
  }
  function buildDepthCanvas(d) {
    const c = document.createElement("canvas");
    c.width = d.w;
    c.height = d.h;
    const cc = c.getContext("2d");
    const id = cc.createImageData(d.w, d.h);
    const span = d.max - d.min || 1;
    for (let i = 0; i < d.data.length; i++) {
      const [r, g, b] = ramp((d.data[i] - d.min) / span);
      id.data[i * 4] = r;
      id.data[i * 4 + 1] = g;
      id.data[i * 4 + 2] = b;
      id.data[i * 4 + 3] = 255;
    }
    cc.putImageData(id, 0, 0);
    return c;
  }

  // ---------- focus-stack rail ----------
  function buildRail() {
    railEl.innerHTML = "";
    model.frames.forEach((f, i) => {
      const t = document.createElement("button");
      t.className = "tick";
      t.title = "λ " + f.focus;
      t.textContent = f.focus;
      t.addEventListener("click", () => {
        cursor = null;
        setActive(i);
      });
      railEl.appendChild(t);
    });
    markRail();
  }
  function markRail() {
    [...railEl.children].forEach((c, i) =>
      c.classList.toggle("on", i === active)
    );
    syncFocusSlider();
  }

  // ---------- focus / aperture sliders ----------
  function resetControls() {
    const fs = el("focus");
    const ap = el("aperture");
    const n = model.frames.length;
    fs.max = String(n - 1);
    fs.value = String(active);
    fs.disabled = n < 2;
    ap.max = String(Math.floor((n - 1) / 2));
    ap.value = "0";
    ap.disabled = n < 3;
    spread = 0;
    el("apertureVal").textContent = "±0";
    el("focusVal").textContent = model.frames[active].focus;
  }
  function syncFocusSlider() {
    if (!model) return;
    el("focus").value = String(active);
    el("focusVal").textContent = model.frames[active].focus;
  }

  // ---------- refocus ----------
  function setActive(i) {
    if (i === active) return;
    prevActive = active;
    active = i;
    fade = reduceMotion ? 1 : 0;
    markRail();
  }
  function refocusFromCursor() {
    if (!cursor || !model || !model.depth) return;
    const u = (cursor.x - imgRect.x) / imgRect.w;
    const v = (cursor.y - imgRect.y) / imgRect.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const lambda = window.LFP.lambdaAt(model.depth, u, v);
    setActive(window.LFP.nearestFrame(model.frames, lambda));
  }

  // ---------- layout + render ----------
  function resize() {
    const wrap = el("stagewrap");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wrap.clientWidth,
      H = wrap.clientHeight;
    stage.width = W * dpr;
    stage.height = H * dpr;
    stage.style.width = W + "px";
    stage.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (model) {
      const ar = model.width / model.height;
      let w = W,
        h = W / ar;
      if (h > H) {
        h = H;
        w = H * ar;
      }
      imgRect = { x: (W - w) / 2, y: (H - h) / 2, w, h };
    }
  }

  // Blend a window of ±spread planes around `active` into a weighted composite,
  // so a wider aperture deepens the in-focus range. Triangular weights peaking
  // at the active plane, painted with the over-operator running-average trick.
  function compositeDraw() {
    const r = imgRect;
    const lo = Math.max(0, active - spread);
    const hi = Math.min(model.frames.length - 1, active + spread);
    let acc = 0;
    for (let i = lo; i <= hi; i++) {
      const w = spread + 1 - Math.abs(i - active);
      acc += w;
      ctx.globalAlpha = w / acc; // weighted running average across the stack
      ctx.drawImage(model.frames[i].img, r.x, r.y, r.w, r.h);
    }
    ctx.globalAlpha = 1;
  }

  function lerpFrameDraw() {
    const r = imgRect;
    const cur = model.frames[active].img;
    if (fade < 1 && model.frames[prevActive]) {
      ctx.globalAlpha = 1;
      ctx.drawImage(model.frames[prevActive].img, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = fade;
      ctx.drawImage(cur, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
    } else {
      ctx.drawImage(cur, r.x, r.y, r.w, r.h);
    }
  }

  function drawHUD() {
    const r = imgRect;
    if (showDepth && depthCanvas) {
      ctx.globalAlpha = 0.55;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(depthCanvas, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
    }
    // crosshair + readout
    if (cursor && cursor.x >= r.x && cursor.x <= r.x + r.w && cursor.y >= r.y && cursor.y <= r.y + r.h) {
      const x = cursor.x,
        y = cursor.y;
      ctx.strokeStyle = "rgba(255,178,62,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, r.y);
      ctx.lineTo(x, r.y + r.h);
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();

      const f = model.frames[active];
      const u = (x - r.x) / r.w,
        v = (y - r.y) / r.h;
      const lam = model.depth ? window.LFP.lambdaAt(model.depth, u, v) : f.focus;
      const label = "λ " + lam.toFixed(1) + "   plane " + (active + 1) + "/" + model.frames.length;
      ctx.font = "12px 'JetBrains Mono', ui-monospace, monospace";
      const pad = 7,
        tw = ctx.measureText(label).width + pad * 2;
      let bx = x + 14,
        by = y + 14;
      if (bx + tw > r.x + r.w) bx = x - 14 - tw;
      if (by + 22 > r.y + r.h) by = y - 14 - 22;
      ctx.fillStyle = "rgba(7,18,17,0.85)";
      ctx.fillRect(bx, by, tw, 22);
      ctx.strokeStyle = "rgba(255,178,62,0.5)";
      ctx.strokeRect(bx + 0.5, by + 0.5, tw, 22);
      ctx.fillStyle = "#ffce82";
      ctx.fillText(label, bx + pad, by + 15);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!model) return;
    if (fade < 1) fade = Math.min(1, fade + 0.16);
    ctx.clearRect(0, 0, stage.width, stage.height);
    if (spread > 0) compositeDraw();
    else lerpFrameDraw();
    drawHUD();
  }

  // ---------- events ----------
  function pointerToCanvas(e) {
    const b = stage.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - b.left, y: p.clientY - b.top };
  }
  stage.addEventListener("pointermove", (e) => {
    cursor = pointerToCanvas(e);
    if (e.pointerType !== "touch") refocusFromCursor();
  });
  stage.addEventListener("pointerleave", () => (cursor = null));
  stage.addEventListener("pointerdown", (e) => {
    cursor = pointerToCanvas(e);
    refocusFromCursor();
    stage.classList.remove("pulse");
    void stage.offsetWidth;
    stage.classList.add("pulse");
  });

  el("focus").addEventListener("input", (e) => {
    if (!model) return;
    cursor = null; // manual focus overrides hover until you move over the stage again
    setActive(Number(e.target.value));
  });
  el("aperture").addEventListener("input", (e) => {
    spread = Number(e.target.value);
    el("apertureVal").textContent = "±" + spread;
  });

  el("depthBtn").addEventListener("click", (e) => {
    showDepth = !showDepth;
    e.currentTarget.setAttribute("aria-pressed", String(showDepth));
  });
  el("infoBtn").addEventListener("click", (e) => {
    const p = el("metapanel");
    const open = p.hasAttribute("hidden");
    p.toggleAttribute("hidden", !open);
    e.currentTarget.setAttribute("aria-pressed", String(open));
  });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key.toLowerCase() === "d" && model) el("depthBtn").click();
    if (e.key.toLowerCase() === "i" && model) el("infoBtn").click();
  });

  const fileInput = el("file");
  el("loadBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => loadFiles(e.target.files));

  const drop = document.body;
  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      if (t === "drop" && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
      drop.classList.remove("dragging");
    })
  );

  window.addEventListener("resize", resize);
  requestAnimationFrame(frame);

  // ---------- boot: try the bundled sample ----------
  window.__loadLFP = load; // used by the self-contained build
  async function boot() {
    if (window.__SAMPLE_B64__) {
      const bin = atob(window.__SAMPLE_B64__);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      load(u8.buffer, "sample");
      return;
    }
    try {
      const resp = await fetch("demo/demo.LFP");
      if (resp.ok) load(await resp.arrayBuffer(), "demo.LFP");
      else setStatus("Drop a .lfp living picture to begin.");
    } catch {
      setStatus("Drop a .lfp living picture to begin.");
    }
  }
  boot();
})();
