(() => {
  "use strict";

  const STORAGE_KEYS = {
    shortlist: "wa-catalog:shortlist",
    theme: "wa-catalog:theme",
  };

  const brand = window.__BRAND__;
  if (!brand) return;

  function qs(id) { return document.getElementById(id); }

  const state = {
    categoryId: "", // "" = all categories
    minPrice: null,
    maxPrice: null,
    sort: "featured",
  };

  // ---------- Theme (mirrors js/product.js so look/state stays consistent) ----------
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

  function setQty(productId, qty) {
    const map = loadShortlist();
    if (qty <= 0) map.delete(productId);
    else map.set(productId, qty);
    saveShortlist(map);
    updateStickyBar(map);
    return map;
  }

  function updateStickyBar(map) {
    map = map || loadShortlist();
    const bar = qs("pd-sticky-bar");
    if (!bar) return;
    const itemCount = map.size;
    let totalQty = 0;
    map.forEach((qty) => { totalQty += qty; });
    bar.hidden = itemCount === 0;
    const summary = qs("pd-sticky-summary");
    if (summary) summary.textContent = `${itemCount} item${itemCount === 1 ? "" : "s"} · ${totalQty} pcs`;
  }

  // ---------- Category rail ----------
  function renderCategoryRail() {
    const rail = qs("brand-category-rail");
    if (!rail) return;
    const allCount = brand.products.length;
    const chips = [{ id: "", label: "All", count: allCount }].concat(
      brand.categories.map((c) => ({ id: c.id, label: c.label, count: c.count }))
    );
    rail.innerHTML = chips.map((c) => (
      `<button type="button" class="chip pill-cat" data-cat="${c.id}" aria-pressed="${c.id === state.categoryId}">` +
        `${escapeHTML(c.label)} <span class="n">${c.count}</span>` +
      `</button>`
    )).join("");
    rail.querySelectorAll(".pill-cat").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.categoryId = btn.dataset.cat;
        renderCategoryRail();
        render();
      });
    });
  }

  // ---------- Filtering + sorting ----------
  function visibleProducts() {
    let items = brand.products;
    if (state.categoryId) items = items.filter((p) => p.category === state.categoryId);
    if (state.minPrice != null) items = items.filter((p) => p.price != null && p.price >= state.minPrice);
    if (state.maxPrice != null) items = items.filter((p) => p.price != null && p.price <= state.maxPrice);

    items = items.slice();
    switch (state.sort) {
      case "price-asc":
        items.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
        break;
      case "price-desc":
        items.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
        break;
      case "name-asc":
        items.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "featured":
      default:
        break; // catalog order
    }
    return items;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function money(price) {
    if (price == null || !brand.currency) return "";
    return `${brand.currency}${price}`;
  }

  function cardHTML(p) {
    const qty = loadShortlist().get(p.id) || 0;
    const img = p.image
      ? `<img src="${escapeHTML(p.image)}" alt="" loading="lazy">`
      : `<span class="product-emoji" aria-hidden="true">🎁</span>`;
    return `<article class="product-card" data-id="${escapeHTML(p.id)}">
      <a class="product-image${p.image ? " has-photo" : ""}" href="../../product/${encodeURIComponent(p.id)}/" aria-hidden="true">${img}</a>
      <div class="product-info">
        <h3 class="product-name"><a class="product-name-link" href="../../product/${encodeURIComponent(p.id)}/">${escapeHTML(p.name)}</a></h3>
        <p class="product-desc">${escapeHTML(p.categoryLabel || "")}</p>
        <p class="product-price">${money(p.price)}</p>
      </div>
      <div class="product-action">
        <button class="add-btn" type="button" ${qty > 0 ? "hidden" : ""}>Add to enquiry</button>
        <div class="stepper" ${qty > 0 ? "" : "hidden"}>
          <button class="step-btn step-minus" type="button" aria-label="Decrease quantity">−</button>
          <input class="step-input" type="number" inputmode="numeric" min="0" step="1" aria-label="Quantity" value="${qty || 0}">
          <button class="step-btn step-plus" type="button" aria-label="Increase quantity">+</button>
        </div>
      </div>
    </article>`;
  }

  function bindCardActions(grid) {
    grid.querySelectorAll(".product-card").forEach((card) => {
      const id = card.dataset.id;
      const addBtn = card.querySelector(".add-btn");
      const stepper = card.querySelector(".stepper");
      const input = stepper.querySelector(".step-input");
      const minus = stepper.querySelector(".step-minus");
      const plus = stepper.querySelector(".step-plus");

      addBtn.addEventListener("click", () => {
        setQty(id, 1);
        addBtn.hidden = true;
        stepper.hidden = false;
        input.value = 1;
      });
      minus.addEventListener("click", () => {
        const next = Math.max(0, (parseInt(input.value, 10) || 0) - 1);
        input.value = next;
        setQty(id, next);
        if (next === 0) { stepper.hidden = true; addBtn.hidden = false; }
      });
      plus.addEventListener("click", () => {
        const next = (parseInt(input.value, 10) || 0) + 1;
        input.value = next;
        setQty(id, next);
      });
      input.addEventListener("change", () => {
        const next = Math.max(0, parseInt(input.value, 10) || 0);
        input.value = next;
        setQty(id, next);
        if (next === 0) { stepper.hidden = true; addBtn.hidden = false; }
      });
    });
  }

  function render() {
    const items = visibleProducts();
    const grid = qs("brand-product-grid");
    const summary = qs("brand-results-summary");
    const empty = qs("brand-empty-state");

    if (summary) {
      summary.textContent = items.length === 0
        ? "No products"
        : `Showing ${items.length} of ${brand.products.length} ${brand.name} products`;
    }

    if (!items.length) {
      grid.innerHTML = "";
      grid.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }

    grid.hidden = false;
    if (empty) empty.hidden = true;
    grid.innerHTML = items.map(cardHTML).join("");
    bindCardActions(grid);
  }

  function initFilters() {
    const minInput = qs("brand-price-min");
    const maxInput = qs("brand-price-max");
    const sortSelect = qs("brand-sort-select");
    const resetBtn = qs("brand-filter-reset");

    if (minInput) {
      minInput.addEventListener("input", () => {
        const v = parseInt(minInput.value, 10);
        state.minPrice = Number.isFinite(v) ? v : null;
        render();
      });
    }
    if (maxInput) {
      maxInput.addEventListener("input", () => {
        const v = parseInt(maxInput.value, 10);
        state.maxPrice = Number.isFinite(v) ? v : null;
        render();
      });
    }
    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        state.sort = sortSelect.value;
        render();
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.categoryId = "";
        state.minPrice = null;
        state.maxPrice = null;
        state.sort = "featured";
        if (minInput) minInput.value = "";
        if (maxInput) maxInput.value = "";
        if (sortSelect) sortSelect.value = "featured";
        renderCategoryRail();
        render();
      });
    }
  }

  function init() {
    initTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeVisuals);
    const toggle = qs("theme-toggle");
    if (toggle) toggle.addEventListener("click", toggleTheme);

    renderCategoryRail();
    initFilters();
    render();
    updateStickyBar();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
