(() => {
  "use strict";

  const STORAGE_KEYS = {
    shortlist: "wa-catalog:shortlist",
    theme: "wa-catalog:theme",
  };

  const product = window.__PRODUCT__;
  if (!product) return;

  function qs(id) { return document.getElementById(id); }

  // ---------- Theme (mirrors js/app.js so state/look stays consistent) ----------
  function isDarkMode() {
    const explicit = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return explicit === "dark" || (!explicit && prefersDark);
  }

  function updateThemeVisuals() {
    const isDark = isDarkMode();
    const toggle = qs("theme-toggle");
    if (toggle) {
      toggle.textContent = isDark ? "☀️" : "🌙";
      toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    }
    const logo = qs("brand-logo");
    if (logo) logo.src = isDark ? "../../assets/logo-white.png" : "../../assets/logo.png";
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEYS.theme); } catch (_) { /* ignore */ }
    if (saved === "dark" || saved === "light") {
      document.documentElement.setAttribute("data-theme", saved);
    }
    updateThemeVisuals();
  }

  function toggleTheme() {
    const currentlyDark = isDarkMode();
    const next = currentlyDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(STORAGE_KEYS.theme, next); } catch (_) { /* ignore */ }
    updateThemeVisuals();
  }

  // ---------- Shortlist (shared localStorage key with the main catalog) ----------
  function loadShortlist() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.shortlist);
      if (!raw) return map;
      const obj = JSON.parse(raw);
      Object.entries(obj).forEach(([id, qty]) => { if (qty > 0) map.set(id, qty); });
    } catch (_) { /* ignore corrupt storage */ }
    return map;
  }

  function saveShortlist(map) {
    try {
      const obj = {};
      map.forEach((qty, id) => { obj[id] = qty; });
      localStorage.setItem(STORAGE_KEYS.shortlist, JSON.stringify(obj));
    } catch (_) { /* storage may be unavailable */ }
  }

  function setQty(qty) {
    const map = loadShortlist();
    if (qty <= 0) map.delete(product.id);
    else map.set(product.id, qty);
    saveShortlist(map);
    updateStickyBar(map);
    return map;
  }

  function updateStickyBar(map) {
    map = map || loadShortlist();
    const bar = qs("pd-sticky-bar");
    if (!bar) return;
    let itemCount = map.size;
    let totalQty = 0;
    map.forEach((qty) => { totalQty += qty; });
    bar.hidden = itemCount === 0;
    const summary = qs("pd-sticky-summary");
    if (summary) summary.textContent = `${itemCount} item${itemCount === 1 ? "" : "s"} · ${totalQty} pcs`;
  }

  // ---------- Gallery ----------
  function initGallery() {
    const images = (product.images && product.images.length ? product.images : [product.image]).filter(Boolean);
    const track = qs("pd-gallery-track");
    const dotsWrap = qs("pd-gallery-dots");
    const prevBtn = qs("pd-gallery-prev");
    const nextBtn = qs("pd-gallery-next");
    if (!track) return;

    track.innerHTML = "";
    images.forEach((src) => {
      const img = document.createElement("img");
      img.src = src;
      img.alt = product.name;
      img.loading = "lazy";
      track.appendChild(img);
    });

    let index = 0;
    const multi = images.length > 1;

    if (dotsWrap) {
      dotsWrap.innerHTML = "";
      dotsWrap.hidden = !multi;
      if (multi) {
        images.forEach((_, i) => {
          const dot = document.createElement("button");
          dot.type = "button";
          dot.className = "dot";
          dot.setAttribute("aria-label", `Image ${i + 1}`);
          dot.addEventListener("click", () => goTo(i));
          dotsWrap.appendChild(dot);
        });
      }
    }
    if (prevBtn) prevBtn.hidden = !multi;
    if (nextBtn) nextBtn.hidden = !multi;

    function goTo(i) {
      index = (i + images.length) % images.length;
      track.style.transform = `translateX(-${index * 100}%)`;
      if (dotsWrap) {
        Array.from(dotsWrap.children).forEach((dot, i2) => {
          dot.setAttribute("aria-current", String(i2 === index));
        });
      }
    }
    goTo(0);

    if (prevBtn) prevBtn.addEventListener("click", () => goTo(index - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => goTo(index + 1));
  }

  // ---------- Add to enquiry / stepper ----------
  function initActions() {
    const addBtn = qs("pd-add-btn");
    const stepper = qs("pd-stepper");
    const input = stepper ? stepper.querySelector(".step-input") : null;
    const minus = stepper ? stepper.querySelector(".step-minus") : null;
    const plus = stepper ? stepper.querySelector(".step-plus") : null;

    const existingQty = loadShortlist().get(product.id) || 0;
    if (existingQty > 0 && addBtn && stepper && input) {
      addBtn.hidden = true;
      stepper.hidden = false;
      input.value = existingQty;
    }

    if (addBtn) {
      addBtn.addEventListener("click", () => {
        setQty(1);
        addBtn.hidden = true;
        stepper.hidden = false;
        input.value = 1;
      });
    }
    if (minus) {
      minus.addEventListener("click", () => {
        const next = Math.max(0, (parseInt(input.value, 10) || 0) - 1);
        input.value = next;
        setQty(next);
        if (next === 0) { stepper.hidden = true; addBtn.hidden = false; }
      });
    }
    if (plus) {
      plus.addEventListener("click", () => {
        const next = (parseInt(input.value, 10) || 0) + 1;
        input.value = next;
        setQty(next);
      });
    }
    if (input) {
      input.addEventListener("change", () => {
        const next = Math.max(0, parseInt(input.value, 10) || 0);
        input.value = next;
        setQty(next);
        if (next === 0) { stepper.hidden = true; addBtn.hidden = false; }
      });
    }
  }

  function init() {
    initTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeVisuals);
    const toggle = qs("theme-toggle");
    if (toggle) toggle.addEventListener("click", toggleTheme);

    initGallery();
    initActions();
    updateStickyBar();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
