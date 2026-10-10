(() => {
  "use strict";

  const STORAGE_KEYS = {
    shortlist: "wa-catalog:shortlist",
    theme: "wa-catalog:theme",
    recentlyViewed: "wa-catalog:recently-viewed",
  };

  const product = window.__PRODUCT__;
  if (!product) return;

  function qs(id) { return document.getElementById(id); }

  // ---------- Recently viewed (shared with the homepage via localStorage) ----------
  function recordRecentlyViewed() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.recentlyViewed);
      let list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) list = [];
      list = list.filter((id) => id !== product.id);
      list.unshift(product.id);
      if (list.length > 12) list = list.slice(0, 12);
      localStorage.setItem(STORAGE_KEYS.recentlyViewed, JSON.stringify(list));
    } catch (_) { /* storage may be unavailable */ }
  }

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
    if (logo) logo.src = "../../assets/logo-white.png";
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
    const thumbsWrap = qs("pd-thumbs");
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
    // Thumbnail strip (desktop only, via CSS) — same photos, click to jump.
    if (thumbsWrap) {
      thumbsWrap.innerHTML = "";
      if (multi) {
        images.forEach((src, i) => {
          const thumb = document.createElement("img");
          thumb.className = "pd-thumb";
          thumb.src = src;
          thumb.alt = "";
          thumb.loading = "lazy";
          thumb.addEventListener("click", () => goTo(i));
          thumbsWrap.appendChild(thumb);
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
      if (thumbsWrap) {
        Array.from(thumbsWrap.children).forEach((thumb, i2) => {
          thumb.setAttribute("aria-current", String(i2 === index));
        });
      }
    }
    goTo(0);

    if (prevBtn) prevBtn.addEventListener("click", () => goTo(index - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => goTo(index + 1));
  }

  // ---------- Size options (merged size-variant products) ----------
  function money2(price) {
    const currency = product.currency || "₹";
    return price == null ? "" : `${currency}${price}`;
  }

  function applySizeOption(opt) {
    const priceEl = qs("pd-price");
    if (priceEl) priceEl.textContent = opt.price != null ? money2(opt.price) : "";

    const dimEl = qs("pd-dimensions");
    if (dimEl && opt.dimensions) {
      dimEl.innerHTML = `<strong>Dimensions:</strong> ${opt.dimensions}`;
    }

    const sourceEl = qs("pd-source");
    if (sourceEl) {
      sourceEl.innerHTML = opt.sourceUrl
        ? `<a href="${opt.sourceUrl}" target="_blank" rel="noopener noreferrer">View manufacturer listing ↗</a>`
        : "";
    }

    if (opt.images && opt.images.length) {
      product.images = opt.images;
      product.image = opt.images[0];
      initGallery();
    }
    // Cart/enquiry identity always stays product.id (the one surviving
    // catalog record) -- the shared shortlist is keyed by id against the
    // main products.json, which no longer has separate per-size entries.
  }

  function initSizeOptions() {
    const sizeOptions = product.sizeOptions;
    const row = qs("pd-size-row");
    if (!row || !sizeOptions || !sizeOptions.length) return;

    Array.from(row.children).forEach((pill) => {
      pill.addEventListener("click", () => {
        const opt = sizeOptions.find((o) => o.id === pill.dataset.sizeId);
        if (!opt) return;
        Array.from(row.children).forEach((p2) => p2.classList.remove("on"));
        pill.classList.add("on");
        applySizeOption(opt);
      });
    });
  }

  // ---------- "You might also like" suggestion row ----------
  function money(price) {
    return price == null ? "" : `₹${price}`;
  }

  function suggestCardHTML(p) {
    const priceHTML = p.price != null ? `<p class="pd-suggest-card-price">${money(p.price)}</p>` : "";
    const brandHTML = p.brand ? `<p class="pd-suggest-card-brand">${p.brand}</p>` : "";
    const img = p.image || "";
    return `<a class="pd-suggest-card" href="../${p.id}/">
      <img src="${img}" alt="" loading="lazy">
      <div class="pd-suggest-card-body">${brandHTML}<p class="pd-suggest-card-name">${p.name}</p>${priceHTML}</div>
    </a>`;
  }

  function initSuggestions() {
    const related = product.related || [];
    const section = qs("pd-suggest");
    if (!section || !related.length) return;

    const rowCount = 8;
    const row = related.slice(0, rowCount);
    const rest = related.slice(rowCount);

    qs("pd-suggest-row").innerHTML = row.map(suggestCardHTML).join("");
    const grid = qs("pd-suggest-grid");
    const moreBtn = qs("pd-suggest-more-btn");
    if (rest.length) {
      grid.innerHTML = rest.map(suggestCardHTML).join("");
      moreBtn.hidden = false;
      moreBtn.addEventListener("click", () => {
        grid.classList.add("on");
        moreBtn.hidden = true;
      });
    }
    section.hidden = false;
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
    initSizeOptions();
    initSuggestions();
    updateStickyBar();
    recordRecentlyViewed();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
