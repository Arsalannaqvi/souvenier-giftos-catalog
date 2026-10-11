// Logo placement preview editor -- lets a client drag/resize/rotate their
// uploaded company logo onto a product photo. Separate file from app.js so
// this chunk of fairly self-contained editor logic doesn't bloat the main
// catalog script; talks to it only through window.CatalogData (see app.js)
// and window.LogoEditor (exposed at the bottom of this file).
//
// Storage model:
// - The uploaded logo (full original resolution, untouched) and every
//   per-image placement (position/size/rotation) live in IndexedDB, not
//   localStorage -- localStorage can't hold a real image file, and its
//   ~5-10MB string-only limit would get consumed almost immediately by one
//   high-res logo. IndexedDB stores the raw Blob directly and comfortably
//   holds hundreds of MB, which also means we never need to downscale or
//   re-encode the client's original upload just to save it.
// - A placement autosaves (debounced) on every drag/resize/rotate, not only
//   on an explicit "Save" click, so an accidental reload mid-edit loses
//   nothing. The current product+image is also mirrored into the URL
//   (?editLogo=id&img=n via replaceState) so a reload lands back in this
//   exact editor view instead of on the home page.
// - "Share" is intentionally stubbed for now -- it needs a small serverless
//   function + Cloudinary to produce a link the rep can open, which isn't
//   wired up yet. In the meantime it best-effort offers a local PNG
//   download of the composited mockup (falls back to a plain message if
//   the product photo's CDN doesn't send CORS headers permissive enough to
//   let canvas export the pixels -- a real possibility across the mix of
//   third-party image hosts this catalog's photos come from).
(() => {
  "use strict";

  const DB_NAME = "wa-catalog-logo-editor";
  const DB_VERSION = 1;
  const DEFAULT_PLACEMENT = { xPct: 50, yPct: 50, sizePct: 25, rotationDeg: 0 };
  const AUTOSAVE_DELAY_MS = 500;

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("logo")) db.createObjectStore("logo");
        if (!db.objectStoreNames.contains("placements")) db.createObjectStore("placements");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function idbGet(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(storeName, key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function qs(id) { return document.getElementById(id); }

  let els = null;
  let currentProduct = null;
  let currentImages = [];
  let currentImageIndex = 0;
  let currentPlacement = { ...DEFAULT_PLACEMENT };
  let currentLogoObjectUrl = null;
  let draggingPointerId = null;
  let autosaveTimer = null;
  let statusHideTimer = null;

  function bindEls() {
    if (els) return els;
    els = {
      overlay: qs("logo-editor-overlay"),
      closeBtn: qs("logo-editor-close"),
      productName: qs("logo-editor-product-name"),
      thumbs: qs("logo-editor-thumbs"),
      stage: qs("logo-editor-stage"),
      productImg: qs("logo-editor-product-img"),
      logoLayer: qs("logo-editor-logo-layer"),
      logoImg: qs("logo-editor-logo-img"),
      uploadPrompt: qs("logo-editor-upload-prompt"),
      fileInput: qs("logo-editor-file-input"),
      controls: qs("logo-editor-controls"),
      sizeSlider: qs("logo-editor-size"),
      rotateSlider: qs("logo-editor-rotate"),
      changeLogoBtn: qs("logo-editor-change-logo"),
      removeBtn: qs("logo-editor-remove-placement"),
      saveStatus: qs("logo-editor-save-status"),
      saveBtn: qs("logo-editor-save-btn"),
      shareBtn: qs("logo-editor-share-btn"),
    };
    return els;
  }

  function placementKey(productId, imageIndex) {
    return `${productId}::${imageIndex}`;
  }

  function applyPlacementToDom() {
    els.logoLayer.style.left = currentPlacement.xPct + "%";
    els.logoLayer.style.top = currentPlacement.yPct + "%";
    els.logoLayer.style.width = currentPlacement.sizePct + "%";
    els.logoLayer.style.transform = `translate(-50%, -50%) rotate(${currentPlacement.rotationDeg}deg)`;
  }

  function scheduleAutosave() {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(flushSave, AUTOSAVE_DELAY_MS);
  }

  async function flushSave() {
    window.clearTimeout(autosaveTimer);
    if (!currentProduct) return;
    const key = placementKey(currentProduct.id, currentImageIndex);
    await idbSet("placements", key, { ...currentPlacement, savedAt: Date.now() });
    markThumbSaved(currentImageIndex, true);
  }

  function showStatus(message, autoHideMs) {
    els.saveStatus.textContent = message;
    els.saveStatus.hidden = false;
    window.clearTimeout(statusHideTimer);
    if (autoHideMs) {
      statusHideTimer = window.setTimeout(() => { els.saveStatus.hidden = true; }, autoHideMs);
    }
  }

  function showLogo(blob) {
    if (currentLogoObjectUrl) URL.revokeObjectURL(currentLogoObjectUrl);
    currentLogoObjectUrl = URL.createObjectURL(blob);
    els.logoImg.src = currentLogoObjectUrl;
    els.logoLayer.hidden = false;
    els.uploadPrompt.hidden = true;
    els.controls.hidden = false;
  }

  function showUploadPrompt() {
    els.logoLayer.hidden = true;
    els.uploadPrompt.hidden = false;
    els.controls.hidden = true;
  }

  function highlightActiveThumb(index) {
    Array.from(els.thumbs.children).forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.index) === index);
    });
  }

  function markThumbSaved(index, saved) {
    const btn = els.thumbs.querySelector(`[data-index="${index}"]`);
    if (!btn) return;
    const badge = btn.querySelector(".logo-editor-thumb-badge");
    if (badge) badge.hidden = !saved;
  }

  async function renderThumbs() {
    els.thumbs.innerHTML = "";
    if (currentImages.length <= 1) {
      els.thumbs.hidden = true;
      return;
    }
    els.thumbs.hidden = false;
    for (let i = 0; i < currentImages.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "logo-editor-thumb";
      btn.dataset.index = String(i);
      const img = document.createElement("img");
      img.src = currentImages[i];
      img.alt = "";
      btn.appendChild(img);
      const badge = document.createElement("span");
      badge.className = "logo-editor-thumb-badge";
      badge.textContent = "✓";
      badge.hidden = true;
      btn.appendChild(badge);
      btn.addEventListener("click", () => {
        if (i === currentImageIndex) return;
        flushSave();
        loadImageView(i);
      });
      els.thumbs.appendChild(btn);

      const saved = await idbGet("placements", placementKey(currentProduct.id, i));
      if (saved) badge.hidden = false;
    }
    highlightActiveThumb(currentImageIndex);
  }

  function updateUrlState() {
    if (!currentProduct) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("editLogo", currentProduct.id);
      url.searchParams.set("img", String(currentImageIndex));
      window.history.replaceState({}, "", url.toString());
    } catch (_) { /* URL/history API unavailable in some embedded contexts */ }
  }

  function clearUrlState() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("editLogo");
      url.searchParams.delete("img");
      window.history.replaceState({}, "", url.toString());
    } catch (_) { /* ignore */ }
  }

  async function loadImageView(index) {
    currentImageIndex = index;
    els.productImg.src = currentImages[index];
    const saved = await idbGet("placements", placementKey(currentProduct.id, index));
    currentPlacement = saved
      ? { xPct: saved.xPct, yPct: saved.yPct, sizePct: saved.sizePct, rotationDeg: saved.rotationDeg }
      : { ...DEFAULT_PLACEMENT };
    els.sizeSlider.value = currentPlacement.sizePct;
    els.rotateSlider.value = currentPlacement.rotationDeg;
    applyPlacementToDom();
    highlightActiveThumb(index);
    updateUrlState();
  }

  async function open(product, imageIndex) {
    bindEls();
    currentProduct = product;
    currentImages = (product.images && product.images.length)
      ? product.images
      : (product.image ? [product.image] : []);
    if (!currentImages.length) {
      window.alert("This product doesn't have a photo to place a logo on.");
      return;
    }
    currentImageIndex = (typeof imageIndex === "number" && imageIndex < currentImages.length) ? imageIndex : 0;

    els.productName.textContent = product.name;
    els.overlay.hidden = false;
    document.body.style.overflow = "hidden";
    els.saveStatus.hidden = true;

    await renderThumbs();
    await loadImageView(currentImageIndex);

    const logoRecord = await idbGet("logo", "current");
    if (logoRecord && logoRecord.blob) {
      showLogo(logoRecord.blob);
    } else {
      showUploadPrompt();
    }
  }

  function close() {
    flushSave();
    els.overlay.hidden = true;
    document.body.style.overflow = "";
    clearUrlState();
  }

  // ---------- Drag to move ----------
  function startDrag(e) {
    if (els.logoLayer.hidden) return;
    e.preventDefault();
    draggingPointerId = e.pointerId;
    els.logoLayer.setPointerCapture(e.pointerId);
    els.logoLayer.classList.add("is-dragging");
    updatePositionFromEvent(e);
  }
  function onDragMove(e) {
    if (e.pointerId !== draggingPointerId) return;
    updatePositionFromEvent(e);
  }
  function onDragEnd(e) {
    if (e.pointerId !== draggingPointerId) return;
    draggingPointerId = null;
    els.logoLayer.classList.remove("is-dragging");
    scheduleAutosave();
  }
  function updatePositionFromEvent(e) {
    const rect = els.stage.getBoundingClientRect();
    let xPct = ((e.clientX - rect.left) / rect.width) * 100;
    let yPct = ((e.clientY - rect.top) / rect.height) * 100;
    xPct = Math.min(100, Math.max(0, xPct));
    yPct = Math.min(100, Math.max(0, yPct));
    currentPlacement.xPct = xPct;
    currentPlacement.yPct = yPct;
    applyPlacementToDom();
    scheduleAutosave();
  }

  // ---------- Best-effort composited export (Share, stubbed) ----------
  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to load"));
      img.src = src;
    });
  }

  async function composite() {
    const baseImg = await loadImageEl(els.productImg.src);
    const logoImg = await loadImageEl(currentLogoObjectUrl);
    const naturalW = baseImg.naturalWidth || els.stage.clientWidth;
    const naturalH = baseImg.naturalHeight || els.stage.clientHeight;
    const canvas = document.createElement("canvas");
    canvas.width = naturalW;
    canvas.height = naturalH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(baseImg, 0, 0, naturalW, naturalH);

    const logoW = (currentPlacement.sizePct / 100) * naturalW;
    const logoH = logoW * (logoImg.naturalHeight / logoImg.naturalWidth);
    const cx = (currentPlacement.xPct / 100) * naturalW;
    const cy = (currentPlacement.yPct / 100) * naturalH;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((currentPlacement.rotationDeg * Math.PI) / 180);
    ctx.drawImage(logoImg, -logoW / 2, -logoH / 2, logoW, logoH);
    ctx.restore();

    // Throws if the product photo's CDN didn't send permissive-enough CORS
    // headers -- common across the mix of third-party image hosts this
    // catalog pulls from. No way to fix that from here; caller handles it.
    return canvas.toDataURL("image/png");
  }

  async function handleShare() {
    await flushSave();
    if (els.logoLayer.hidden) {
      showStatus("Upload a logo first.", 3000);
      return;
    }
    showStatus("Preparing a preview…");
    try {
      const dataUrl = await composite();
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${currentProduct.id}-logo-mockup.png`;
      a.click();
      showStatus("Sharing a link with the rep isn't connected yet — downloaded a copy of this mockup instead.", 7000);
    } catch (_) {
      showStatus("Couldn't generate a downloadable preview for this product photo. Sharing with the rep will work once that's connected.", 7000);
    }
  }

  // ---------- Wiring ----------
  function wireEvents() {
    els.closeBtn.addEventListener("click", close);

    els.fileInput.addEventListener("change", async () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      if (!file) return;
      await idbSet("logo", "current", { blob: file, type: file.type, name: file.name });
      showLogo(file);
      els.fileInput.value = "";
    });
    els.changeLogoBtn.addEventListener("click", () => els.fileInput.click());

    els.sizeSlider.addEventListener("input", () => {
      currentPlacement.sizePct = Number(els.sizeSlider.value);
      applyPlacementToDom();
      scheduleAutosave();
    });
    els.rotateSlider.addEventListener("input", () => {
      currentPlacement.rotationDeg = Number(els.rotateSlider.value);
      applyPlacementToDom();
      scheduleAutosave();
    });

    els.removeBtn.addEventListener("click", async () => {
      await idbDelete("placements", placementKey(currentProduct.id, currentImageIndex));
      currentPlacement = { ...DEFAULT_PLACEMENT };
      els.sizeSlider.value = currentPlacement.sizePct;
      els.rotateSlider.value = currentPlacement.rotationDeg;
      applyPlacementToDom();
      markThumbSaved(currentImageIndex, false);
    });

    els.saveBtn.addEventListener("click", async () => {
      await flushSave();
      showStatus("Saved ✓", 1500);
    });
    els.shareBtn.addEventListener("click", handleShare);

    els.logoLayer.addEventListener("pointerdown", startDrag);
    els.logoLayer.addEventListener("pointermove", onDragMove);
    els.logoLayer.addEventListener("pointerup", onDragEnd);
    els.logoLayer.addEventListener("pointercancel", onDragEnd);
  }

  function initFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const productId = params.get("editLogo");
    if (!productId) return;
    const imageIndex = parseInt(params.get("img"), 10) || 0;
    const products = (window.CatalogData && window.CatalogData.products) || [];
    const product = products.find((p) => p.id === productId);
    if (product) open(product, imageIndex);
  }

  function boot() {
    bindEls();
    if (!els.overlay) return; // this page doesn't have the editor markup
    wireEvents();
    if (window.CatalogData) {
      initFromUrl();
    } else {
      window.addEventListener("catalog:ready", initFromUrl, { once: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.LogoEditor = { open };
})();
