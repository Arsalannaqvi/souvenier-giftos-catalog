(() => {
  "use strict";

  const STORAGE_KEYS = {
    shortlist: "wa-catalog:shortlist",
    client: "wa-catalog:client-info",
    theme: "wa-catalog:theme",
  };

  /** @type {{config: any, categories: any[], products: any[], visibleCategories: any[], visibleProducts: any[]}} */
  const state = {
    config: null,
    categories: [],
    products: [],
    visibleCategories: [],
    visibleProducts: [],
    activeCategory: null,
    shortlist: new Map(), // productId -> qty
    clientKey: null,
    selectedRep: null, // { name, number } from config.salesTeam
    brandByProduct: {}, // productId -> brand name (from data/brands.json, optional)
    filters: { minPrice: null, maxPrice: null, brands: new Set() },
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

  function showWelcome() {
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

  function updateThemeIcon() {
    const explicit = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = explicit === "dark" || (!explicit && prefersDark);
    els.themeToggle.textContent = isDark ? "☀️" : "🌙";
    els.themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
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

  function renderCategoryGrid() {
    const tpl = qs("category-tile-template");
    els.categoryGrid.innerHTML = "";
    state.visibleCategories.forEach((cat) => {
      const count = categoryProductCount(cat.id);
      if (count === 0) return;
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
    state.visibleCategories.forEach((cat) => {
      const count = categoryProductCount(cat.id);
      if (count === 0) return;
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.textContent = cat.label;
      node.setAttribute("aria-selected", String(cat.id === state.activeCategory));
      node.addEventListener("click", () => openCategory(cat.id));
      els.chipRow.appendChild(node);
    });
  }

  function openCategory(categoryId) {
    state.activeCategory = categoryId;
    state.filters = { minPrice: null, maxPrice: null, brands: new Set() };
    qs("filter-price-min").value = "";
    qs("filter-price-max").value = "";
    updateFiltersBadge();
    els.homeView.hidden = true;
    els.categoryView.hidden = false;
    renderChips();
    renderProducts();
    els.categoryView.scrollIntoView({ behavior: "instant", block: "start" });
  }

  function goHome() {
    state.activeCategory = null;
    els.categoryView.hidden = true;
    els.homeView.hidden = false;
    renderCategoryGrid();
  }

  // ---------- Filters (price range + brand) ----------
  function categoryItems() {
    return state.visibleProducts.filter((p) => p.category === state.activeCategory);
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
    updateFiltersBadge();
    renderProducts();
    closeFilterSheet();
  }

  function clearFilters() {
    state.filters = { minPrice: null, maxPrice: null, brands: new Set() };
    qs("filter-price-min").value = "";
    qs("filter-price-max").value = "";
    renderBrandFilterList();
    updateFiltersBadge();
    renderProducts();
  }

  // ---------- Rendering: products ----------
  function renderProducts() {
    const tpl = qs("product-card-template");
    els.productGrid.innerHTML = "";
    const baseItems = categoryItems();
    const items = baseItems.filter(matchesFilters);
    els.emptyState.hidden = baseItems.length > 0;
    els.filteredEmptyState.hidden = !(baseItems.length > 0 && items.length === 0);

    items.forEach((product) => {
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
        imageWrap.addEventListener("click", () => openLightbox(product.image, product.name));
      } else {
        const cat = state.categories.find((c) => c.id === product.category);
        node.querySelector(".product-emoji").textContent = (cat && cat.emoji) || "🎁";
        imageWrap.style.background = cat && cat.color
          ? `linear-gradient(135deg, color-mix(in srgb, ${cat.color} 22%, var(--surface)), color-mix(in srgb, ${cat.color} 6%, var(--surface)))`
          : "";
      }

      node.querySelector(".product-name").textContent = product.name;
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
    els.submitBtn.disabled = !canSubmit;
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

  // ---------- Enquiry submission (Netlify Forms — no WhatsApp number needed) ----------
  function setEnquiryStatus(text, kind) {
    els.enquiryStatus.textContent = text;
    els.enquiryStatus.hidden = !text;
    els.enquiryStatus.className = "enquiry-status" + (kind ? ` enquiry-status--${kind}` : "");
  }

  async function submitEnquiry() {
    if (els.submitBtn.disabled || els.submitBtn.dataset.busy === "true") return;
    saveClientInfo();

    const name = qs("client-name").value.trim();
    const company = qs("client-company").value.trim();
    const whatsapp = qs("client-whatsapp").value.trim();
    const message = buildMessage();

    els.submitBtn.dataset.busy = "true";
    els.submitBtn.textContent = "Submitting…";
    setEnquiryStatus("", null);

    const body = new URLSearchParams({
      "form-name": "enquiry",
      name,
      company,
      whatsapp,
      message,
    }).toString();

    try {
      const res = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
      setEnquiryStatus("Thanks! Your enquiry has been sent — we'll be in touch.", "success");
    } catch (err) {
      console.error(err);
      setEnquiryStatus("Couldn't submit right now. Please try \"Send on WhatsApp\" instead, or try again.", "error");
    } finally {
      els.submitBtn.dataset.busy = "false";
      els.submitBtn.textContent = "Submit Enquiry";
    }
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
    els.submitBtn = qs("submit-enquiry-btn");
    els.enquiryStatus = qs("enquiry-status");
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
    els.sendBtn.addEventListener("click", sendWhatsApp);
    els.submitBtn.addEventListener("click", submitEnquiry);
    qs("client-name").addEventListener("input", updateStickyBar);
    els.lightbox.addEventListener("click", closeLightbox);
    qs("lightbox-close").addEventListener("click", closeLightbox);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.lightbox.hidden) closeLightbox();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
