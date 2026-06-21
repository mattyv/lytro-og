// ingest.js — the camera panel: connect over Wi-Fi, list pictures, download
// their component files, preview JPEGs, and (when possible) hand a focus stack
// to the refocus viewer. Degrades gracefully on the web build, where the native
// TCP plugin is absent.

(function () {
  const el = (id) => document.getElementById(id);
  const T = window.LytroTransport;
  const P = window.LytroProto;

  const panel = el("campanel");
  const btn = el("camBtn");
  let camera = null;
  let busy = false;

  // Filesystem is reached by name so we stay buildless (no @capacitor/filesystem JS).
  const FS =
    window.Capacitor && window.Capacitor.registerPlugin
      ? window.Capacitor.registerPlugin("Filesystem")
      : null;

  function status(msg, kind) {
    const s = el("camStatus");
    s.textContent = msg || "";
    s.className = "cam-status" + (kind ? " " + kind : "");
  }

  function togglePanel(show) {
    const open = show != null ? show : panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !open);
    btn.setAttribute("aria-pressed", String(open));
    if (open && !T.available) {
      el("camUnsupported").hidden = false;
      el("camConnect").hidden = true;
    }
  }

  async function saveFile(name, bytes) {
    if (FS) {
      await FS.writeFile({
        path: "Lytro/" + name,
        data: T.b64encode(bytes),
        directory: "DOCUMENTS",
        recursive: true,
      });
      return "Documents/Lytro/" + name;
    }
    // web fallback: download via blob
    const blob = new Blob([bytes]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return name;
  }

  async function connect() {
    if (busy) return;
    busy = true;
    status("Connecting…");
    el("camInfo").hidden = true;
    el("camList").innerHTML = "";
    try {
      const transport = new T.NativeTransport();
      camera = new window.Lytro.LytroCamera(transport);
      await camera.connect(el("camHost").value.trim(), Number(el("camPort").value.trim()));

      const info = await camera.getCameraInfo();
      el("camInfo").hidden = false;
      el("camInfo").innerHTML =
        `<b>${info.manufacturer || "Lytro"}</b> · serial ${info.serial || "?"}` +
        `<br>fw ${info.firmware || "?"} · sw ${info.software || "?"}`;

      status("Listing pictures…");
      const photos = await camera.listPhotos();
      renderList(photos);
      status(photos.length + " pictures on camera", "ok");
    } catch (e) {
      status(e.message || String(e), "error");
    } finally {
      busy = false;
    }
  }

  function renderList(photos) {
    const list = el("camList");
    list.innerHTML = "";
    if (!photos.length) {
      list.textContent = "No pictures found.";
      return;
    }
    photos.forEach((p) => {
      const row = document.createElement("div");
      row.className = "cam-item";
      const label = document.createElement("div");
      label.className = "cam-item-label";
      label.innerHTML =
        `<b>${p.filePrefix}${String(p.fileNumber).padStart(4, "0")}</b>` +
        `<span>${p.pictureDate || ""} · λ ${(+p.lastLambda).toFixed(1)}${p.liked ? " · ♥" : ""}</span>`;
      const dl = document.createElement("button");
      dl.className = "ctl";
      dl.textContent = "download";
      dl.addEventListener("click", () => downloadOne(p, dl));
      row.appendChild(label);
      row.appendChild(dl);
      list.appendChild(row);
    });
  }

  async function downloadOne(entry, dlBtn) {
    if (busy) return;
    busy = true;
    dlBtn.disabled = true;
    const name = entry.filePrefix + String(entry.fileNumber).padStart(4, "0");
    try {
      const files = await camera.downloadPicture(entry, (type, got, total) => {
        status(`${name}.${type} — ${Math.round((got / total) * 100)}%`);
      });
      const saved = [];
      for (const type of Object.keys(files)) {
        await saveFile(`${name}.${type}`, files[type]);
        saved.push(type);
      }
      status(`${name}: saved ${saved.join(", ") || "nothing"}`, "ok");

      if (files.jpg) addToGallery(name, files.jpg, files.stk);
    } catch (e) {
      status(`${name}: ${e.message || e}`, "error");
    } finally {
      dlBtn.disabled = false;
      busy = false;
    }
  }

  function addToGallery(name, jpgBytes, stkBytes) {
    const gal = el("camGallery");
    const fig = document.createElement("figure");
    fig.className = "cam-thumb";
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([jpgBytes], { type: "image/jpeg" }));
    img.alt = name;
    fig.appendChild(img);

    // A camera .stk may be a cooked focus-stack container — if it parses, offer
    // to open it in the refocus viewer. Otherwise the flat JPEG is the preview.
    if (stkBytes && window.LFP) {
      try {
        window.LFP.parse(stkBytes.buffer.slice(0));
        const open = document.createElement("button");
        open.className = "ctl";
        open.textContent = "refocus ▸";
        open.addEventListener("click", () => {
          togglePanel(false);
          window.__loadLFP(stkBytes.buffer.slice(0), name + ".stk");
        });
        fig.appendChild(open);
      } catch (_) {
        /* not a refocusable container — flat preview only */
      }
    }
    gal.prepend(fig);
  }

  // ---- wiring ----
  btn.addEventListener("click", () => togglePanel());
  el("camClose").addEventListener("click", () => togglePanel(false));
  el("camConnectBtn").addEventListener("click", connect);
})();
