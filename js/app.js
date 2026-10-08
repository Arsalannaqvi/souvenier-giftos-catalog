(() => {
  "use strict";

  const STORAGE_KEYS = {
    shortlist: "wa-catalog:shortlist",
    client: "wa-catalog:client-info",
    theme: "wa-catalog:theme",
    seenWelcome: "wa-catalog:seen-welcome",
  };

  /** @type {{config: any, categories: any[], products: any[], visibleCategories: any[], visibleProducts: any[]}} */
  const state = {
    config: null,
    categories: [],
    products: [],
    visibleCategories: [],
    visibleProducts: [],
    activeCategory: null,
    browsingAll: false, // true = viewing/searching across every category at once
    searchQuery: "",
    budgetKey: "all", // which budget chip is active, for chip UI sync
    brandKey: "", // which brand chip is active ("" = All Brands), for chip UI sync
    shortlist: new Map(), // productId -> qty
    clientKey: null,
    selectedRep: null, // { name, number } from config.salesTeam
    brandByProduct: {}, // productId -> brand name (from data/brands.json, optional)
    filters: { minPrice: null, maxPrice: null, brands: new Set() },
    pagination: { page: 1, pageSize: 24, sort: "newest" },
  };

  const BUDGET_PRESETS = {
    all: { min: null, max: null },
    low: { min: null, max: 500 },
    mid: { min: 500, max: 2000 },
    high: { min: 2000, max: null },
  };

  const els = {};

  function qs(id) { return document.getElementById(id); }

  async function fetchJSON(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
  }

  // ---------- Lightbox (tap a product photo to view it larger) ----------
  function openLightbox(src, alt) {
    els.lightboxImg.src = src;
    els.lightboxImg.alt = alt || "";
    els.lightbox.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    els.lightbox.hidden = true;
    els.lightboxImg.src = "";
    document.body.style.overflow = "";
  }

  function money(product) {
    const { currency } = state.config;
    if (product.price == null) return "";
    return `${currency}${product.price}`;
  }

  function loadShortlist() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.shortlist);
      if (!raw) return;
      const obj = JSON.parse(raw);
      Object.entries(obj).forEach(([id, qty]) => {
        if (qty > 0) state.shortlist.set(id, qty);
      });
    } catch (_) { /* ignore corrupt storage */ }
  }

  function saveShortlist() {
    try {
      const obj = {};
      state.shortlist.forEach((qty, id) => { obj[id] = qty; });
      localStorage.setItem(STORAGE_KEYS.shortlist, JSON.stringify(obj));
    } catch (_) { /* storage may be unavailable (private mode) */ }
  }

  function loadClientInfo() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.client);
      if (!raw) return {};
      return JSON.parse(raw);
    } catch (_) { return {}; }
  }

  function saveClientInfo() {
    try {
      const info = {
        name: qs("client-name").value,
        company: qs("client-company").value,
        whatsapp: qs("client-whatsapp").value,
        notes: qs("client-notes").value,
        repName: state.selectedRep ? state.selectedRep.name : null,
      };
      localStorage.setItem(STORAGE_KEYS.client, JSON.stringify(info));
    } catch (_) { /* ignore */ }
  }

  // ---------- Sales rep picker ----------
  function renderSalesPicker() {
    const team = state.config.salesTeam || [];
    els.salesPicker.innerHTML = "";
    team.forEach((rep) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rep-chip";
      btn.textContent = rep.name;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(state.selectedRep === rep));
      if (state.selectedRep === rep) btn.classList.add("is-selected");
      btn.addEventListener("click", () => selectRep(rep));
      els.salesPicker.appendChild(btn);
    });
  }

  function selectRep(rep) {
    state.selectedRep = rep;
    renderSalesPicker();
    updateStickyBar();
  }

  // ---------- Welcome splash ----------
  function dismissWelcome() {
    if (!els.welcomeScreen || els.welcomeScreen.hidden) return;
    els.welcomeScreen.classList.add("is-hiding");
    document.body.style.overflow = "";
    window.setTimeout(() => { els.welcomeScreen.hidden = true; }, 350);
  }

  function hasSeenWelcome() {
    try { return sessionStorage.getItem(STORAGE_KEYS.seenWelcome) === "1"; } catch (_) { return false; }
  }

  function markWelcomeSeen() {
    try { sessionStorage.setItem(STORAGE_KEYS.seenWelcome, "1"); } catch (_) { /* ignore */ }
  }

  function showWelcome() {
    if (hasSeenWelcome()) {
      // Element has no "hidden" attribute in the markup by default (it's
      // normally shown then auto-dismissed) — explicitly hide it when
      // skipping, instead of just not-showing-it.
      els.welcomeScreen.hidden = true;
      return;
    }
    markWelcomeSeen();
    els.welcomeBusinessName.textContent = state.config.businessName || "our catalog";
    els.welcomeTagline.textContent = state.config.tagline || "";
    els.welcomeScreen.hidden = false;
    document.body.style.overflow = "hidden";
    els.welcomeScreen.addEventListener("click", dismissWelcome, { once: true });
    document.addEventListener("keydown", function onKey(e) {
      dismissWelcome();
      document.removeEventListener("keydown", onKey);
    }, { once: true });
    window.setTimeout(dismissWelcome, 2600);
  }

  // ---------- Theme ----------
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEYS.theme); } catch (_) { /* ignore */ }
    if (saved === "dark" || saved === "light") {
      document.documentElement.setAttribute("data-theme", saved);
    }
    updateThemeIcon();
  }

  function isDarkMode() {
    const explicit = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return explicit === "dark" || (!explicit && prefersDark);
  }

  function updateThemeIcon() {
    const isDark = isDarkMode();
    els.themeToggle.textContent = isDark ? "☀️" : "🌙";
    els.themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    if (els.brandLogo) {
      els.brandLogo.src = isDark ? "assets/logo-white.png" : "assets/logo.png";
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const currentlyDark = current === "dark" || (!current && prefersDark);
    const next = currentlyDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(STORAGE_KEYS.theme, next); } catch (_) { /* ignore */ }
    updateThemeIcon();
  }

  // ---------- Rendering: home / categories ----------
  function categoryProductCount(categoryId) {
    return state.visibleProducts.filter((p) => p.category === categoryId).length;
  }

  function categoriesByCountDesc() {
    return state.visibleCategories
      .map((cat) => ({ cat, count: categoryProductCount(cat.id) }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count);
  }

  function renderCategoryGrid() {
    const tpl = qs("category-tile-template");
    els.categoryGrid.innerHTML = "";
    categoriesByCountDesc().forEach(({ cat, count }) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector(".category-emoji").textContent = cat.emoji || "🎁";
      node.querySelector(".category-label").textContent = cat.label;
      node.querySelector(".category-count").textContent = `${count} item${count === 1 ? "" : "s"}`;
      node.style.setProperty("--cat-color", cat.color || "var(--accent)");
      node.addEventListener("click", () => openCategory(cat.id));
      els.categoryGrid.appendChild(node);
    });
  }

  function renderChips() {
    const tpl = qs("chip-template");
    els.chipRow.innerHTML = "";
    categoriesByCountDesc().forEach(({ cat }) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.textContent = cat.label;
      node.setAttribute("aria-selected", String(cat.id === state.activeCategory));
      node.addEventListener("click", () => openCategory(cat.id));
      els.chipRow.appendChild(node);
    });
  }

  function openCategory(categoryId) {
    state.activeCategory = categoryId;
    state.browsingAll = false;
    resetDiscovery();
    state.pagination.page = 1;
    els.homeView.hidden = true;
    els.categoryView.hidden = false;
    els.chipRow.hidden = false;
    renderChips();
    renderProducts();
    els.categoryView.scrollIntoView({ behavior: "instant", block: "start" });
  }

  function goHome() {
    state.activeCategory = null;
    state.browsingAll = false;
    resetDiscovery();
    els.categoryView.hidden = true;
    els.homeView.hidden = false;
    renderCategoryGrid();
  }

  // ---------- Search / budget discovery (shared across home + category view) ----------
  // Clears search text, budget chip, and price/brand filters back to defaults.
  // Does not touch activeCategory/browsingAll/view visibility — callers own that.
  function resetDiscovery() {
    state.searchQuery = "";
    state.budgetKey = "all";
    state.brandKey = "";
    state.filters = { minPrice: null, maxPrice: null, brands: new Set() };
    els.searchInput.value = "";
    qs("filter-price-min").value = "";
    qs("filter-price-max").value = "";
    updateFiltersBadge();
    updateBudgetChipsUI();
    updateBrandChipsUI();
  }

  // Switches from the home view into the shared "browsing all categories"
  // view (used when search or a budget chip is used from the home screen,
  // with no specific category selected yet).
  function enterBrowseAll() {
    state.activeCategory = null;
    state.browsingAll = true;
    els.homeView.hidden = true;
    els.categoryView.hidden = false;
    els.chipRow.hidden = true;
  }

  function updateBudgetChipsUI() {
    els.budgetChips.querySelectorAll(".chip").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.budget === state.budgetKey));
    });
  }

  function selectBudget(key) {
    state.budgetKey = key;
    const preset = BUDGET_PRESETS[key];
    state.filters.minPrice = preset.min;
    state.filters.maxPrice = preset.max;
    qs("filter-price-min").value = preset.min ?? "";
    qs("filter-price-max").value = preset.max ?? "";
    updateFiltersBadge();
    updateBudgetChipsUI();

    if (key !== "all" && !els.homeView.hidden) {
      enterBrowseAll();
    }
    state.pagination.page = 1;
    renderProducts();
  }

  function updateBrandChipsUI() {
    els.brandChips.querySelectorAll(".chip[data-brand]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.brand === state.brandKey));
    });
  }

  function selectBrand(brand) {
    // Clicking the already-active brand chip clears it back to "All Brands".
    state.brandKey = state.brandKey === brand ? "" : brand;
    state.filters.brands = state.brandKey ? new Set([state.brandKey]) : new Set();
    updateFiltersBadge();
    updateBrandChipsUI();

    if (state.brandKey && !els.homeView.hidden) {
      enterBrowseAll();
    }
    state.pagination.page = 1;
    renderProducts();
  }

  // ---------- Filters (price range + brand) ----------
  function categoryItems() {
    let items = state.browsingAll
      ? state.visibleProducts
      : state.visibleProducts.filter((p) => p.category === state.activeCategory);
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      items = items.filter((p) => p.name.toLowerCase().includes(q));
    }
    return items;
  }

  function matchesFilters(product) {
    const { minPrice, maxPrice, brands } = state.filters;
    if (minPrice != null && (product.price == null || product.price < minPrice)) return false;
    if (maxPrice != null && (product.price == null || product.price > maxPrice)) return false;
    if (brands.size > 0) {
      const brand = state.brandByProduct[product.id];
      if (!brand || !brands.has(brand)) return false;
    }
    return true;
  }

  function updateFiltersBadge() {
    const { minPrice, maxPrice, brands } = state.filters;
    let count = 0;
    if (minPrice != null) count += 1;
    if (maxPrice != null) count += 1;
    count += brands.size;
    els.filtersBadge.textContent = String(count);
    els.filtersBadge.hidden = count === 0;
  }

  function renderBrandFilterList() {
    const counts = new Map();
    categoryItems().forEach((p) => {
      const brand = state.brandByProduct[p.id];
      if (brand) counts.set(brand, (counts.get(brand) || 0) + 1);
    });
    const brands = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));

    els.brandFilterList.innerHTML = "";
    els.brandFilterEmpty.hidden = brands.length > 0;

    brands.forEach((brand) => {
      const label = document.createElement("label");
      label.className = "brand-filter-item";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = brand;
      input.checked = state.filters.brands.has(brand);
      const text = document.createElement("span");
      text.textContent = brand;
      const count = document.createElement("span");
      count.className = "brand-count";
      count.textContent = String(counts.get(brand));
      label.appendChild(input);
      label.appendChild(text);
      label.appendChild(count);
      els.brandFilterList.appendChild(label);
    });
  }

  function openFilterSheet() {
    renderBrandFilterList();
    els.filterSheetOverlay.hidden = false;
    els.filterSheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeFilterSheet() {
    els.filterSheetOverlay.hidden = true;
    els.filterSheet.hidden = true;
    document.body.style.overflow = "";
  }

  function applyFilters() {
    const minVal = qs("filter-price-min").value.trim();
    const maxVal = qs("filter-price-max").value.trim();
    state.filters.minPrice = minVal ? Number(minVal) : null;
    state.filters.maxPrice = maxVal ? Number(maxVal) : null;
    state.filters.brands = new Set(
      Array.from(els.brandFilterList.querySelectorAll("input:checked")).map((el) => el.value)
    );
    // A manual price edit may no longer match any budget preset exactly —
    // only keep a chip highlighted when the typed range still matches it.
    const matchedKey = Object.keys(BUDGET_PRESETS).find((key) => {
      const preset = BUDGET_PRESETS[key];
      return preset.min === state.filters.minPrice && preset.max === state.filters.maxPrice;
    });
    state.budgetKey = matchedKey || null;
    updateBudgetChipsUI();
    // A manual brand-checkbox edit may no longer match a single quick-chip
    // brand (none checked, or more than one) — only keep a chip highlighted
    // when exactly one brand is selected and it has its own quick chip.
    state.brandKey = state.filters.brands.size === 1 ? Array.from(state.filters.brands)[0] : "";
    updateBrandChipsUI();
    state.pagination.page = 1;
    updateFiltersBadge();
    renderProducts();
    closeFilterSheet();
  }

  function clearFilters() {
    state.filters = { minPrice: null, maxPrice: null, brands: new Set() };
    state.budgetKey = "all";
    state.brandKey = "";
    state.pagination.page = 1;
    qs("filter-price-min").value = "";
    qs("filter-price-max").value = "";
    updateBudgetChipsUI();
    updateBrandChipsUI();
    renderBrandFilterList();
    updateFiltersBadge();
    renderProducts();
  }

  // ---------- Sorting + pagination ----------
  function sortItems(items) {
    const sorted = items.slice();
    switch (state.pagination.sort) {
      case "price-low":
        sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
        break;
      case "price-high":
        sorted.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
        break;
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "newest":
      default:
        // No creation-date field in the data; catalog order is append order,
        // so reversing approximates newest-added-first.
        sorted.reverse();
        break;
    }
    return sorted;
  }

  function updateToolbar(total, startIdx, endIdx, totalPages, page) {
    els.resultsSummary.textContent = total === 0
      ? "No products"
      : `Showing ${startIdx + 1}–${endIdx} of ${total} Products`;
    els.pager.hidden = totalPages <= 1;
    els.pagerLabel.textContent = `Page ${page} of ${totalPages}`;
    els.pagerPrev.disabled = page <= 1;
    els.pagerNext.disabled = page >= totalPages;
  }

  function goToPage(page) {
    state.pagination.page = page;
    renderProducts();
    els.productGrid.scrollIntoView({ behavior: "instant", block: "start" });
  }

  // ---------- Rendering: products ----------

  // Auto-cycles through a product's photos on hover/press, so extra angles
  // (once sourced) preview without opening the product page. A no-op today
  // for any product with only one photo.
  function bindImageHoverCycle(imageWrap, img, product) {
    const images = (product.images && product.images.length ? product.images : [product.image]).filter(Boolean);
    if (images.length <= 1) return;
    let timer = null;
    let index = 0;
    const advance = () => {
      index = (index + 1) % images.length;
      img.classList.add("is-fading");
      window.setTimeout(() => {
        img.src = images[index];
        img.classList.remove("is-fading");
      }, 120);
    };
    const start = () => {
      if (timer) return;
      timer = window.setInterval(advance, 900);
    };
    const stop = () => {
      if (timer) { window.clearInterval(timer); timer = null; }
      index = 0;
      img.classList.remove("is-fading");
      img.src = images[0];
    };
    imageWrap.addEventListener("mouseenter", start);
    imageWrap.addEventListener("mouseleave", stop);
    imageWrap.addEventListener("touchstart", start, { passive: true });
    imageWrap.addEventListener("touchend", stop);
  }

  function renderProducts() {
    const tpl = qs("product-card-template");
    els.productGrid.innerHTML = "";
    const baseItems = categoryItems();
    const filtered = baseItems.filter(matchesFilters);
    const items = sortItems(filtered);
    els.emptyState.textContent = state.searchQuery
      ? `No products match "${state.searchQuery}".`
      : state.browsingAll
        ? "No products match this filter."
        : "No products in this category yet.";
    els.emptyState.hidden = baseItems.length > 0;
    els.filteredEmptyState.hidden = !(baseItems.length > 0 && items.length === 0);

    const total = items.length;
    const pageSize = state.pagination.pageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (state.pagination.page > totalPages) state.pagination.page = totalPages;
    if (state.pagination.page < 1) state.pagination.page = 1;
    const page = state.pagination.page;
    const startIdx = total === 0 ? 0 : (page - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, total);
    const pageItems = items.slice(startIdx, endIdx);

    updateToolbar(total, startIdx, endIdx, totalPages, page);

    pageItems.forEach((product) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.productId = product.id;

      const imageWrap = node.querySelector(".product-image");
      if (product.image) {
        const img = document.createElement("img");
        img.src = product.image;
        img.alt = product.name;
        img.loading = "lazy";
        imageWrap.innerHTML = "";
        imageWrap.appendChild(img);
        imageWrap.classList.add("has-photo");
        imageWrap.addEventListener("click", () => openLightbox(img.src, product.name));
        bindImageHoverCycle(imageWrap, img, product);
      } else {
        const cat = state.categories.find((c) => c.id === product.category);
        node.querySelector(".product-emoji").textContent = (cat && cat.emoji) || "🎁";
        imageWrap.style.background = cat && cat.color
          ? `linear-gradient(135deg, color-mix(in srgb, ${cat.color} 22%, var(--surface)), color-mix(in srgb, ${cat.color} 6%, var(--surface)))`
          : "";
      }

      const nameLink = node.querySelector(".product-name-link");
      nameLink.textContent = product.name;
      nameLink.href = `product/${product.id}/`;
      node.querySelector(".product-desc").textContent = product.desc || "";
      const priceEl = node.querySelector(".product-price");
      if (state.config.showPrices) {
        priceEl.textContent = money(product);
      } else {
        priceEl.remove();
      }

      const addBtn = node.querySelector(".add-btn");
      const stepper = node.querySelector(".stepper");
      const input = stepper.querySelector(".step-input");

      const existingQty = state.shortlist.get(product.id) || 0;
      if (existingQty > 0) {
        addBtn.hidden = true;
        stepper.hidden = false;
        input.value = existingQty;
      }

      addBtn.addEventListener("click", () => {
        setQty(product.id, 1);
        addBtn.hidden = true;
        stepper.hidden = false;
        input.value = 1;
        input.focus();
      });

      bindStepper(stepper, product.id, () => {
        const qty = state.shortlist.get(product.id) || 0;
        if (qty <= 0) {
          stepper.hidden = true;
          addBtn.hidden = false;
        }
      });

      els.productGrid.appendChild(node);
    });
  }

  function bindStepper(stepperEl, productId, onZero) {
    const input = stepperEl.querySelector(".step-input");
    const minus = stepperEl.querySelector(".step-minus");
    const plus = stepperEl.querySelector(".step-plus");

    minus.addEventListener("click", () => {
      const next = Math.max(0, (parseInt(input.value, 10) || 0) - 1);
      input.value = next;
      setQty(productId, next, true);
      if (next === 0 && onZero) onZero();
    });

    plus.addEventListener("click", () => {
      const next = (parseInt(input.value, 10) || 0) + 1;
      input.value = next;
      setQty(productId, next, true);
    });

    input.addEventListener("change", () => {
      const next = Math.max(0, parseInt(input.value, 10) || 0);
      input.value = next;
      setQty(productId, next, true);
      if (next === 0 && onZero) onZero();
    });
  }

  function setQty(productId, qty, skipRerenderSheet) {
    if (qty <= 0) {
      state.shortlist.delete(productId);
    } else {
      state.shortlist.set(productId, qty);
    }
    saveShortlist();
    updateStickyBar();
    if (!skipRerenderSheet && !els.sheet.hidden) renderSheetItems();
    // keep product-card stepper in sync if the same product is visible
    syncProductCardStepper(productId);
  }

  function syncProductCardStepper(productId) {
    const card = els.productGrid.querySelector(`[data-product-id="${productId}"]`);
    if (!card) return;
    const qty = state.shortlist.get(productId) || 0;
    const addBtn = card.querySelector(".add-btn");
    const stepper = card.querySelector(".stepper");
    const input = stepper.querySelector(".step-input");
    if (qty > 0) {
      addBtn.hidden = true;
      stepper.hidden = false;
      input.value = qty;
    } else {
      addBtn.hidden = false;
      stepper.hidden = true;
    }
  }

  // ---------- Sticky bar ----------
  function updateStickyBar() {
    const itemCount = state.shortlist.size;
    let totalQty = 0;
    state.shortlist.forEach((qty) => { totalQty += qty; });
    els.stickyBar.hidden = itemCount === 0;
    els.stickySummary.textContent = `${itemCount} item${itemCount === 1 ? "" : "s"} · ${totalQty} pcs`;
    const canSubmit = itemCount > 0 && !!qs("client-name").value.trim();
    els.sendBtn.disabled = !canSubmit || !state.selectedRep;
  }

  // ---------- Sheet ----------
  let lastFocusedBeforeSheet = null;

  function openSheet() {
    lastFocusedBeforeSheet = document.activeElement;
    renderSheetItems();
    els.sheetOverlay.hidden = false;
    els.sheet.hidden = false;
    document.body.style.overflow = "hidden";
    const nameInput = qs("client-name");
    window.setTimeout(() => nameInput.focus(), 50);
    document.addEventListener("keydown", onSheetKeydown);
  }

  function closeSheet() {
    els.sheetOverlay.hidden = true;
    els.sheet.hidden = true;
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onSheetKeydown);
    if (lastFocusedBeforeSheet && document.contains(lastFocusedBeforeSheet)) {
      lastFocusedBeforeSheet.focus();
    }
  }

  function onSheetKeydown(e) {
    if (e.key === "Escape") {
      closeSheet();
      return;
    }
    if (e.key === "Tab") {
      const focusables = els.sheet.querySelectorAll(
        "button, input, textarea, [tabindex]:not([tabindex='-1'])"
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function renderSheetItems() {
    const tpl = qs("sheet-item-template");
    els.sheetItems.innerHTML = "";
    const entries = Array.from(state.shortlist.entries());
    els.sheetEmpty.hidden = entries.length > 0;
    els.sheetTotal.hidden = entries.length === 0;

    let totalQty = 0;
    let totalAmount = 0;
    let hasPrices = true;

    entries.forEach(([productId, qty]) => {
      const product = state.products.find((p) => p.id === productId);
      if (!product) return;
      totalQty += qty;
      if (product.price != null) {
        totalAmount += product.price * qty;
      } else {
        hasPrices = false;
      }

      const node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.productId = productId;

      const imageWrap = node.querySelector(".sheet-item-image");
      if (product.image) {
        const img = document.createElement("img");
        img.src = product.image;
        img.alt = product.name;
        imageWrap.innerHTML = "";
        imageWrap.appendChild(img);
        imageWrap.classList.add("has-photo");
        imageWrap.addEventListener("click", () => openLightbox(product.image, product.name));
      } else {
        const cat = state.categories.find((c) => c.id === product.category);
        node.querySelector(".sheet-item-emoji").textContent = (cat && cat.emoji) || "🎁";
      }

      node.querySelector(".sheet-item-name").textContent = product.name;
      node.querySelector(".sheet-item-price").textContent = state.config.showPrices ? money(product) : "";

      const stepper = node.querySelector(".stepper");
      const input = stepper.querySelector(".step-input");
      input.value = qty;
      bindStepper(stepper, productId, () => renderSheetItems());

      node.querySelector(".remove-btn").addEventListener("click", () => {
        setQty(productId, 0);
        renderSheetItems();
      });

      els.sheetItems.appendChild(node);
    });

    if (state.config.showPrices && hasPrices && entries.length) {
      els.sheetTotal.textContent = `Total: ${totalQty} pcs · ${state.config.currency}${totalAmount}`;
    } else if (entries.length) {
      els.sheetTotal.textContent = `Total: ${totalQty} pcs`;
    }

    updateStickyBar();
  }

  // ---------- WhatsApp message ----------
  function buildMessage() {
    const name = qs("client-name").value.trim();
    const company = qs("client-company").value.trim();
    const whatsapp = qs("client-whatsapp").value.trim();
    const notes = qs("client-notes").value.trim();

    const lines = [];
    lines.push(`${name || "A client"} wants to enquire about:`);
    lines.push("");

    let i = 1;
    let totalQty = 0;
    state.shortlist.forEach((qty, productId) => {
      const product = state.products.find((p) => p.id === productId);
      if (!product) return;
      totalQty += qty;
      const priceText = state.config.showPrices ? ` (${money(product)})` : "";
      lines.push(`${i}. ${product.name} — Qty: ${qty}${priceText}`);
      i += 1;
    });

    lines.push("");
    lines.push(`Total: ${state.shortlist.size} item${state.shortlist.size === 1 ? "" : "s"}, ${totalQty} pcs`);
    lines.push("");

    if (company) lines.push(`Company: ${company}`);
    if (whatsapp) lines.push(`Client WhatsApp: ${whatsapp}`);
    if (notes) lines.push(`Notes: ${notes}`);

    lines.push("");
    lines.push(`— via ${state.config.businessName} catalog`);

    return lines.join("\n");
  }

  function sendWhatsApp() {
    if (state.shortlist.size === 0 || !state.selectedRep) return;
    saveClientInfo();
    const message = buildMessage();
    const number = (state.selectedRep.number || "").replace(/[^\d]/g, "");
    const url = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener");
  }

  // ---------- Client curation (?client=) ----------
  function applyClientFilter() {
    const params = new URLSearchParams(window.location.search);
    const clientKey = params.get("client");
    const clientCfg = clientKey && state.config.clients ? state.config.clients[clientKey] : null;

    if (clientCfg) {
      state.clientKey = clientKey;
      const allowed = new Set(clientCfg.categories || []);
      state.visibleCategories = state.categories.filter((c) => allowed.has(c.id));
      state.visibleProducts = state.products.filter((p) => allowed.has(p.category));
      els.clientBanner.hidden = false;
      els.clientBanner.textContent = `Curated catalog for ${clientCfg.label}`;
    } else {
      state.visibleCategories = state.categories;
      state.visibleProducts = state.products;
      els.clientBanner.hidden = true;
    }
  }

  // ---------- Init ----------
  async function init() {
    els.businessName = qs("business-name");
    els.businessTagline = qs("business-tagline");
    els.welcomeScreen = qs("welcome-screen");
    els.welcomeBusinessName = qs("welcome-business-name");
    els.welcomeTagline = qs("welcome-tagline");
    els.themeToggle = qs("theme-toggle");
    els.brandLogo = qs("brand-logo");
    els.clientBanner = qs("client-banner");
    els.homeView = qs("home-view");
    els.categoryView = qs("category-view");
    els.categoryGrid = qs("category-grid");
    els.chipRow = qs("chip-row");
    els.productGrid = qs("product-grid");
    els.emptyState = qs("empty-state");
    els.backBtn = qs("back-btn");
    els.stickyBar = qs("sticky-bar");
    els.stickySummary = qs("sticky-summary");
    els.sheetOverlay = qs("sheet-overlay");
    els.sheet = qs("shortlist-sheet");
    els.closeSheetBtn = qs("close-sheet-btn");
    els.sheetItems = qs("sheet-items");
    els.sheetEmpty = qs("sheet-empty");
    els.sheetTotal = qs("sheet-total");
    els.sendBtn = qs("send-whatsapp-btn");
    els.salesPicker = qs("sales-picker");
    els.lightbox = qs("lightbox");
    els.lightboxImg = qs("lightbox-img");
    els.filtersBtn = qs("filters-btn");
    els.filtersBadge = qs("filters-badge");
    els.filterSheetOverlay = qs("filter-sheet-overlay");
    els.filterSheet = qs("filter-sheet");
    els.brandFilterList = qs("brand-filter-list");
    els.brandFilterEmpty = qs("brand-filter-empty");
    els.filteredEmptyState = qs("filtered-empty-state");
    els.resultsSummary = qs("results-summary");
    els.pageSizeSelect = qs("page-size-select");
    els.sortSelect = qs("sort-select");
    els.pager = qs("pager");
    els.pagerPrev = qs("pager-prev");
    els.pagerNext = qs("pager-next");
    els.pagerLabel = qs("pager-label");
    els.searchInput = qs("search-input");
    els.budgetChips = qs("budget-chips");
    els.occasionChips = qs("occasion-chips");
    els.brandChips = qs("brand-chips");
    els.moreBrandsBtn = qs("more-brands-btn");

    initTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeIcon);

    let config, data;
    try {
      [config, data] = await Promise.all([
        fetchJSON("data/config.json"),
        fetchJSON("data/products.json"),
      ]);
    } catch (err) {
      document.body.innerHTML = `<p style="padding:24px;font-family:sans-serif">
        Could not load catalog data. If you opened this file directly, serve it over
        a local server (e.g. <code>npx serve</code>) instead of double-clicking index.html.
      </p>`;
      console.error(err);
      return;
    }

    state.config = config;
    state.categories = data.categories || [];
    state.products = data.products || [];

    try {
      state.brandByProduct = await fetchJSON("data/brands.json");
    } catch (err) {
      state.brandByProduct = {}; // optional file; brand filter just stays empty if absent
    }

    document.title = config.businessName || "Gift Catalog";
    els.businessName.textContent = config.businessName || "Catalog";
    els.businessTagline.textContent = config.tagline || "";
    showWelcome();

    applyClientFilter();
    loadShortlist();

    const savedClient = loadClientInfo();
    if (savedClient.name) qs("client-name").value = savedClient.name;
    if (savedClient.company) qs("client-company").value = savedClient.company;
    if (savedClient.whatsapp) qs("client-whatsapp").value = savedClient.whatsapp;
    if (savedClient.notes) qs("client-notes").value = savedClient.notes;
    if (savedClient.repName) {
      state.selectedRep = (state.config.salesTeam || []).find((r) => r.name === savedClient.repName) || null;
    }

    renderSalesPicker();
    renderCategoryGrid();
    updateStickyBar();

    // Deep link from a product page's "back to <category>" link, e.g.
    // product/electronics-404/ links to ../../?category=electronics.
    const requestedCategory = new URLSearchParams(window.location.search).get("category");
    if (requestedCategory && state.visibleCategories.some((c) => c.id === requestedCategory)) {
      openCategory(requestedCategory);
    }

    els.themeToggle.addEventListener("click", toggleTheme);
    els.backBtn.addEventListener("click", goHome);
    els.stickyBar.addEventListener("click", openSheet);
    els.closeSheetBtn.addEventListener("click", closeSheet);
    els.sheetOverlay.addEventListener("click", closeSheet);
    els.filtersBtn.addEventListener("click", openFilterSheet);
    els.filterSheetOverlay.addEventListener("click", closeFilterSheet);
    qs("close-filter-sheet-btn").addEventListener("click", closeFilterSheet);
    qs("apply-filters-btn").addEventListener("click", applyFilters);
    qs("clear-filters-btn").addEventListener("click", clearFilters);
    els.pageSizeSelect.addEventListener("change", () => {
      state.pagination.pageSize = Number(els.pageSizeSelect.value);
      state.pagination.page = 1;
      renderProducts();
    });
    els.sortSelect.addEventListener("change", () => {
      state.pagination.sort = els.sortSelect.value;
      state.pagination.page = 1;
      renderProducts();
    });
    els.pagerPrev.addEventListener("click", () => {
      if (state.pagination.page > 1) goToPage(state.pagination.page - 1);
    });
    els.pagerNext.addEventListener("click", () => {
      goToPage(state.pagination.page + 1);
    });
    els.searchInput.addEventListener("input", () => {
      const q = els.searchInput.value.trim();
      const wasSearching = !!state.searchQuery;
      state.searchQuery = q;

      if (!q) {
        // Search cleared: if nothing else (a budget chip) is keeping us in
        // the all-categories view, go back to the home screen.
        if (state.browsingAll && state.budgetKey === "all") {
          goHome();
        } else if (state.browsingAll) {
          state.pagination.page = 1;
          renderProducts();
        }
        return;
      }

      if (!wasSearching && !els.homeView.hidden) {
        enterBrowseAll();
      } else if (!wasSearching && state.activeCategory != null) {
        // Typing a search while inside a specific category searches the
        // whole catalog, same as typing it from the home screen.
        state.activeCategory = null;
        state.browsingAll = true;
        els.chipRow.hidden = true;
      }
      state.pagination.page = 1;
      renderProducts();
    });
    els.budgetChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      selectBudget(btn.dataset.budget);
    });
    els.occasionChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      openCategory(btn.dataset.occasionCategory);
    });
    els.brandChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip[data-brand]");
      if (!btn) return;
      selectBrand(btn.dataset.brand);
    });
    els.moreBrandsBtn.addEventListener("click", () => {
      if (!els.homeView.hidden) {
        enterBrowseAll();
        renderProducts();
      }
      openFilterSheet();
    });
    els.sendBtn.addEventListener("click", sendWhatsApp);
    qs("client-name").addEventListener("input", updateStickyBar);
    els.lightbox.addEventListener("click", closeLightbox);
    qs("lightbox-close").addEventListener("click", closeLightbox);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.lightbox.hidden) closeLightbox();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
