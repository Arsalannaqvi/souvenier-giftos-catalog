(() => {
  "use strict";

  const STORAGE_KEYS = {
    shortlist: "wa-catalog:shortlist",
    client: "wa-catalog:client-info",
    theme: "wa-catalog:theme",
    seenWelcome: "wa-catalog:seen-welcome",
    recentlyViewed: "wa-catalog:recently-viewed",
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
    branding: null, // selected branding chip key, or null
    kitBudget: null, // per-recipient budget (number) for the floating widget's ring, or null
    brandByProduct: {}, // productId -> brand name (from data/brands.json, optional)
    kits: [], // curated multi-product kits (from data/kits.json, optional)
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

  function isDesktop() {
    try { return window.matchMedia("(min-width: 1024px)").matches; } catch (_) { return false; }
  }

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
        deliveryCity: qs("client-delivery-city").value,
        neededBy: qs("client-needed-by").value,
        recipientCount: qs("client-recipient-count").value,
        budgetPerRecipient: qs("client-budget-per-recipient").value,
        branding: state.branding,
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

  // How long a "visit" counts as still browsing, so the welcome screen
  // doesn't reappear when navigating to a product page and back, or after
  // briefly backgrounding the browser (e.g. switching to WhatsApp to send
  // an enquiry). localStorage, not sessionStorage — sessionStorage was
  // getting reset by some mobile browsers across those exact navigations,
  // which is what caused the welcome screen to keep popping back up.
  const WELCOME_RESHOW_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

  function hasSeenWelcome() {
    try {
      const seenAt = Number(localStorage.getItem(STORAGE_KEYS.seenWelcome));
      return Boolean(seenAt) && Date.now() - seenAt < WELCOME_RESHOW_AFTER_MS;
    } catch (_) { return false; }
  }

  function markWelcomeSeen() {
    try { localStorage.setItem(STORAGE_KEYS.seenWelcome, String(Date.now())); } catch (_) { /* ignore */ }
  }

  // True only for an actual browser reload (refresh button / pull-to-
  // refresh / F5) — distinct from a regular link click or the back/forward
  // button, which is how "go back from a product page" normally happens
  // and should NOT re-show the splash. The Navigation Timing API tells
  // these apart reliably; a reload should always show the splash again,
  // even within the "already seen" window below.
  function isReloadNavigation() {
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      return Boolean(nav) && nav.type === "reload";
    } catch (_) { return false; }
  }

  // True when this page load came from OUTSIDE the site — tapping the
  // shared catalog link in WhatsApp, a bookmark, or a typed URL — as
  // opposed to a link clicked from inside the site itself, e.g. a product
  // page's "back to catalog" link. document.referrer is empty for the
  // former (WhatsApp and most chat apps don't send a referrer at all) and
  // set to our own origin for the latter. This is what makes "show when
  // someone clicks our link" and "don't show while still browsing" both
  // true at once: clicking the shared link always shows it, clicking
  // around inside the site never does.
  function isExternalEntry() {
    try {
      if (!document.referrer) return true;
      return new URL(document.referrer).origin !== window.location.origin;
    } catch (_) { return true; }
  }

  // Arms the welcome splash's dismissal (tap + auto-timeout). Deliberately
  // synchronous and called before the catalog data fetch, NOT after it —
  // it previously only got wired up once data.json/config.json resolved,
  // so on a slow/stalled mobile connection the splash could sit on screen
  // indefinitely with nothing listening for taps (they'd fall through to
  // the browser's native double-tap-zoom instead). Dismissal must never
  // depend on data actually loading.
  function armWelcomeDismissal() {
    const shouldShow = isReloadNavigation() || isExternalEntry() || !hasSeenWelcome();
    if (!shouldShow) {
      // Element has no "hidden" attribute in the markup by default (it's
      // normally shown then auto-dismissed) — explicitly hide it when
      // skipping, instead of just not-showing-it.
      els.welcomeScreen.hidden = true;
      return;
    }
    markWelcomeSeen();
    document.body.style.overflow = "hidden";
    // pointerdown (not click) — on mobile, a layout shift from the URL bar
    // collapsing on first touch can make the browser treat the tap as a
    // drag and suppress the synthetic click, so "tap anywhere" needed 2-3
    // taps before it registered. pointerdown fires on initial contact,
    // before that shift happens. Also auto-dismisses after 1.5s regardless,
    // so it never gets stuck even if a tap is missed.
    els.welcomeScreen.addEventListener("pointerdown", dismissWelcome, { once: true });
    document.addEventListener("keydown", function onKey(e) {
      dismissWelcome();
      document.removeEventListener("keydown", onKey);
    }, { once: true });
    window.setTimeout(dismissWelcome, 1500);
  }

  // Fills in the real business name/tagline once catalog data has loaded,
  // replacing the generic "Catalog" placeholder — purely cosmetic, doesn't
  // gate dismissal (see armWelcomeDismissal above).
  function updateWelcomeText() {
    if (!els.welcomeScreen.hidden) {
      els.welcomeBusinessName.textContent = state.config.businessName || "our catalog";
      els.welcomeTagline.textContent = state.config.tagline || "";
    }
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
      // Both theme states are dark-navy now, so the white-ink logo is always correct.
      els.brandLogo.src = "assets/logo-white.png";
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

  // ---------- Recently viewed (shared with product pages via localStorage) ----------
  function loadRecentlyViewed() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.recentlyViewed);
      if (!raw) return [];
      const ids = JSON.parse(raw);
      if (!Array.isArray(ids)) return [];
      return ids.map((id) => state.products.find((p) => p.id === id)).filter(Boolean);
    } catch (_) { return []; }
  }

  function recentlyViewedCardHTML(p) {
    const brand = state.brandByProduct[p.id] || "";
    const priceText = state.config.showPrices ? money(p) : "";
    const img = p.image || "";
    return `<a class="cb-item" href="product/${p.id}/"
      data-img="${img}" data-brand="${brand}" data-name="${p.name}" data-price="${priceText}">
      <span class="cb-name">${p.name}</span>
      <span class="cb-price">${priceText}</span>
    </a>`;
  }

  function renderRecentlyViewed() {
    if (!els.recentlyViewedSection) return;
    const products = loadRecentlyViewed();
    if (products.length === 0) {
      els.recentlyViewedSection.hidden = true;
      return;
    }
    els.recentlyViewedRow.innerHTML = products.map(recentlyViewedCardHTML).join("");
    els.recentlyViewedSection.hidden = false;
    initCbPreviewFloat();
  }

  // ---------- Continue Browsing hover/focus preview (JS-positioned, see CSS comment) ----------
  function initCbPreviewFloat() {
    if (!els.cbPreviewFloat) return;
    const items = els.recentlyViewedRow.querySelectorAll(".cb-item");

    function showFor(item) {
      els.cbpImg.src = item.dataset.img;
      els.cbpBrand.textContent = item.dataset.brand;
      els.cbpBrand.hidden = !item.dataset.brand;
      els.cbpName.textContent = item.dataset.name;
      els.cbpPrice.textContent = item.dataset.price;
      els.cbpPrice.hidden = !item.dataset.price;

      const rect = item.getBoundingClientRect();
      const floatWidth = 150;
      const left = rect.left + rect.width / 2 - floatWidth / 2;
      const minLeft = 10, maxLeft = window.innerWidth - floatWidth - 10;
      const clampedLeft = Math.min(Math.max(left, minLeft), maxLeft);
      const arrowX = rect.left + rect.width / 2 - clampedLeft;
      els.cbPreviewFloat.style.left = `${clampedLeft}px`;
      els.cbPreviewFloat.style.setProperty("--arrow-x", `${arrowX}px`);

      const approxHeight = 150 + 40;
      let top = rect.top - approxHeight - 12;
      if (top < 8) top = rect.bottom + 12;
      els.cbPreviewFloat.style.top = `${top}px`;

      els.cbPreviewFloat.classList.add("on");
    }
    function hide() { els.cbPreviewFloat.classList.remove("on"); }

    items.forEach((item) => {
      item.addEventListener("pointerenter", () => showFor(item));
      item.addEventListener("pointerleave", hide);
      item.addEventListener("focus", () => showFor(item));
      item.addEventListener("blur", hide);
    });
  }

  // ---------- Curated kits ("Shop by Kit", merged into the old Occasion slot) ----------
  function kitCardHTML(kit) {
    const items = kit.productIds.map((pid) => state.products.find((p) => p.id === pid)).filter(Boolean);
    if (items.length === 0) return "";
    const total = items.reduce((sum, p) => sum + (p.price || 0), 0);
    const thumbs = items.map((p) => `<div class="kit-thumb"><img src="${p.image || ""}" alt="" loading="lazy"></div>`).join("");
    const contents = items.map((p) => p.name).join(", ");
    const priceHTML = state.config.showPrices
      ? `<p class="kit-price">${state.config.currency}${total}</p>` : "<span></span>";
    return `<div class="kit-card" data-kit-id="${kit.id}">
      <div class="kit-thumbs">${thumbs}</div>
      <p class="kit-name">${kit.name}</p>
      <p class="kit-contents">${contents}</p>
      <div class="kit-row">
        ${priceHTML}
        <button class="kit-add-btn" type="button">+ Add kit</button>
      </div>
    </div>`;
  }

  function renderKits() {
    if (!els.kitRow) return;
    els.kitRow.innerHTML = state.kits.map(kitCardHTML).join("");
  }

  function addKitToShortlist(kitId) {
    const kit = state.kits.find((k) => k.id === kitId);
    if (!kit) return;
    kit.productIds.forEach((pid) => {
      const current = state.shortlist.get(pid) || 0;
      setQty(pid, current + 1, true);
    });
    updateStickyBar();
    if (!els.sheet.hidden) renderSheetItems();
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

  // Persistent desktop-sidebar equivalent of the category grid/chip row —
  // kept in sync everywhere renderChips()/renderCategoryGrid() are.
  function renderSidebarCategories() {
    if (!els.sidebarCategories) return;
    const allActive = state.browsingAll && !state.activeCategory;
    const parts = [
      `<button type="button" class="sidebar-cat-item${allActive ? " on" : ""}" data-all="1">` +
        `<span>All Products</span><span class="n">${state.visibleProducts.length}</span></button>`,
    ];
    categoriesByCountDesc().forEach(({ cat, count }) => {
      const active = cat.id === state.activeCategory;
      const emoji = cat.emoji ? `${cat.emoji} ` : "";
      parts.push(
        `<button type="button" class="sidebar-cat-item${active ? " on" : ""}" data-cat="${cat.id}">` +
          `<span>${emoji}${cat.label}</span><span class="n">${count}</span></button>`
      );
    });
    els.sidebarCategories.innerHTML = parts.join("");
  }

  // Sidebar reverts out of its home-page order/content (see the
  // .discovery-bar--home CSS) whenever leaving the home view — Continue
  // Browsing is sidebar-only now, so it also needs hiding explicitly here
  // (it used to live inside #home-view and got hidden for free along with
  // it; now that it's a sidebar child, that's no longer automatic). The
  // body class controls the desktop layout itself (see CSS): home has no
  // sidebar column at all, everything full-width; category/all-products
  // browsing keeps the sidebar + product-grid two-column layout.
  function leaveHomeSidebar() {
    els.discoveryBar.classList.remove("discovery-bar--home");
    document.body.classList.remove("home-active");
    els.recentlyViewedSection.hidden = true;
  }

  function openCategory(categoryId) {
    state.activeCategory = categoryId;
    state.browsingAll = false;
    resetDiscovery();
    state.pagination.page = 1;
    els.homeView.hidden = true;
    leaveHomeSidebar();
    els.categoryView.hidden = false;
    els.chipRow.hidden = false;
    renderChips();
    renderSidebarCategories();
    renderProducts();
    els.categoryView.scrollIntoView({ behavior: "instant", block: "start" });
  }

  // Reached via the sidebar's "All Products" entry (both breakpoints) or
  // a category-page "View all" link — a flat product grid, as distinct
  // from the curated home view (Continue Browsing + category tiles).
  function browseAllProducts() {
    resetDiscovery();
    state.activeCategory = null;
    state.browsingAll = true;
    state.pagination.page = 1;
    els.homeView.hidden = true;
    leaveHomeSidebar();
    els.categoryView.hidden = false;
    els.chipRow.hidden = true;
    renderSidebarCategories();
    renderProducts();
  }

  function goHome() {
    state.activeCategory = null;
    state.browsingAll = false;
    resetDiscovery();
    els.categoryView.hidden = true;
    els.homeView.hidden = false;
    els.discoveryBar.classList.add("discovery-bar--home");
    document.body.classList.add("home-active");
    renderCategoryGrid();
    renderSidebarCategories();
    renderRecentlyViewed();
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
    hideSuggestions();
  }

  // Switches from the home view into the shared "browsing all categories"
  // view (used when search or a budget chip is used from the home screen,
  // with no specific category selected yet).
  function enterBrowseAll() {
    state.activeCategory = null;
    state.browsingAll = true;
    els.homeView.hidden = true;
    leaveHomeSidebar();
    els.categoryView.hidden = false;
    els.chipRow.hidden = true;
    renderSidebarCategories();
  }

  // ---------- Search: price-phrase parsing + brand/category autocomplete ----------
  // Matches "under 500", "below ₹2000", "over 1500", "above 500",
  // "500-1500", "between 500 and 1500" etc. anywhere in the query, and
  // returns the remaining text with that phrase removed.
  const PRICE_PHRASE_RE =
    /\b(?:under|below|less than|max)\s*₹?\s*([\d,]+)\b|\b(?:above|over|more than|min)\s*₹?\s*([\d,]+)\b|\bbetween\s*₹?\s*([\d,]+)\s*(?:and|to|-)\s*₹?\s*([\d,]+)\b|₹?\s*([\d,]+)\s*-\s*₹?\s*([\d,]+)\b/i;

  function parseSearchQuery(raw) {
    const m = raw.match(PRICE_PHRASE_RE);
    if (!m) return { text: raw.trim(), minPrice: null, maxPrice: null };
    let minPrice = null;
    let maxPrice = null;
    const num = (s) => Number(s.replace(/,/g, ""));
    if (m[1] !== undefined) maxPrice = num(m[1]);
    else if (m[2] !== undefined) minPrice = num(m[2]);
    else if (m[3] !== undefined && m[4] !== undefined) { minPrice = num(m[3]); maxPrice = num(m[4]); }
    else if (m[5] !== undefined && m[6] !== undefined) { minPrice = num(m[5]); maxPrice = num(m[6]); }
    const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    return { text, minPrice, maxPrice };
  }

  // Flat {type, label, value}[] of every brand + category, built once the
  // catalog data is loaded. Used for the type-ahead suggestion dropdown.
  let searchIndex = [];
  function buildSearchIndex() {
    const brandCounts = new Map();
    state.visibleProducts.forEach((p) => {
      const b = state.brandByProduct[p.id];
      if (b) brandCounts.set(b, (brandCounts.get(b) || 0) + 1);
    });
    const brandEntries = Array.from(brandCounts.entries())
      .map(([label, count]) => ({ type: "Brand", label, value: label, count }))
      .sort((a, b) => b.count - a.count);
    const catEntries = categoriesByCountDesc().map(({ cat, count }) => ({
      type: "Category", label: cat.label, value: cat.id, count,
    }));
    searchIndex = [...brandEntries, ...catEntries];
  }

  let suggestActiveIndex = -1;
  let suggestItems = [];

  function hideSuggestions() {
    els.searchSuggest.hidden = true;
    els.searchSuggest.innerHTML = "";
    els.searchInput.setAttribute("aria-expanded", "false");
    suggestItems = [];
    suggestActiveIndex = -1;
  }

  function renderSuggestions(rawQuery) {
    const q = rawQuery.trim().toLowerCase();
    if (!q) { hideSuggestions(); return; }
    suggestItems = searchIndex
      .filter((entry) => entry.label.toLowerCase().startsWith(q))
      .slice(0, 8);
    if (!suggestItems.length) { hideSuggestions(); return; }
    suggestActiveIndex = -1;
    els.searchSuggest.innerHTML = suggestItems.map((entry, i) => (
      `<li class="search-suggest-item" id="suggest-${i}" role="option" data-index="${i}">` +
        `<span class="search-suggest-label">${entry.label}</span>` +
        `<span class="search-suggest-type">${entry.type} · ${entry.count}</span>` +
      `</li>`
    )).join("");
    els.searchSuggest.hidden = false;
    els.searchInput.setAttribute("aria-expanded", "true");
  }

  function applySuggestion(entry) {
    hideSuggestions();
    els.searchInput.value = "";
    state.searchQuery = "";
    if (entry.type === "Brand") {
      selectBrand(entry.value);
    } else {
      openCategory(entry.value);
    }
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

  // Mirrors scripts/generate_brand_pages.py's slugify() exactly, so a link
  // built here always resolves to a real brand/<slug>/ page.
  function slugifyBrand(name) {
    return String(name)
      .toLowerCase()
      .replace(/['’]/g, "")
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "brand";
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
      items = items.filter((p) => {
        if (p.name.toLowerCase().includes(q)) return true;
        const brand = state.brandByProduct[p.id];
        if (brand && brand.toLowerCase().includes(q)) return true;
        if (p.subcategory && p.subcategory.toLowerCase().includes(q)) return true;
        const cat = state.categories.find((c) => c.id === p.category);
        if (cat && cat.label.toLowerCase().includes(q)) return true;
        return false;
      });
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
    // New, separate way to reach a brand's dedicated landing page -- only
    // shown once a single brand chip/filter is active, and additive next
    // to the existing results summary (doesn't touch selectBrand() itself).
    if (els.brandPageLink) {
      if (state.brandKey) {
        els.brandPageLink.href = `brand/${slugifyBrand(state.brandKey)}/`;
        els.brandPageLink.hidden = false;
      } else {
        els.brandPageLink.hidden = true;
      }
    }
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
    if (els.desktopCartBadge) {
      els.desktopCartBadge.textContent = String(itemCount);
      els.desktopCartBadge.hidden = itemCount === 0;
    }
    const canSubmit = itemCount > 0 && !!qs("client-name").value.trim();
    els.reviewBtn.disabled = !canSubmit || !state.selectedRep;
    renderBudgetWidget();
  }

  // ---------- Floating budget/cart widget ----------
  const BW_FILL_CIRCUMFERENCE = 175.93; // 2 * PI * r(28)
  const BW_OVERFLOW_CIRCUMFERENCE = 197.92; // 2 * PI * r(31.5)

  function kitSpend() {
    let sum = 0;
    state.shortlist.forEach((qty, productId) => {
      const product = state.products.find((p) => p.id === productId);
      if (product && product.price != null) sum += product.price;
    });
    return sum;
  }

  function renderBudgetWidget() {
    if (!els.budgetWidget) return;
    const itemCount = state.shortlist.size;
    if (itemCount === 0) {
      els.budgetWidget.hidden = true;
      return;
    }
    els.budgetWidget.hidden = false;

    const { currency } = state.config;
    const budget = state.kitBudget;

    if (!budget || budget <= 0) {
      els.bwFill.style.strokeDashoffset = String(BW_FILL_CIRCUMFERENCE);
      els.bwOverflow.style.strokeDashoffset = String(BW_OVERFLOW_CIRCUMFERENCE);
      els.budgetWidget.classList.remove("over-budget");
      els.bwValue.textContent = String(itemCount);
      els.bwLabel.textContent = itemCount === 1 ? "item" : "items";
      els.budgetWidget.setAttribute("aria-label", `${itemCount} item${itemCount === 1 ? "" : "s"} in shortlist — view shortlist`);
      return;
    }

    const spend = kitSpend();
    const ratio = spend / budget;
    const fillRatio = Math.min(ratio, 1);
    els.bwFill.style.strokeDashoffset = String(BW_FILL_CIRCUMFERENCE * (1 - fillRatio));

    if (ratio > 1) {
      const overflowRatio = Math.min(ratio - 1, 1); // cap visual at +100% over
      els.bwOverflow.style.strokeDashoffset = String(BW_OVERFLOW_CIRCUMFERENCE * (1 - overflowRatio));
      els.budgetWidget.classList.add("over-budget");
      const over = spend - budget;
      els.bwValue.textContent = `${currency}${over}`;
      els.bwLabel.textContent = "over";
      els.budgetWidget.setAttribute("aria-label", `${currency}${over} over the ${currency}${budget} per-recipient budget — view shortlist`);
    } else {
      els.bwOverflow.style.strokeDashoffset = String(BW_OVERFLOW_CIRCUMFERENCE);
      els.budgetWidget.classList.remove("over-budget");
      const left = budget - spend;
      els.bwValue.textContent = `${currency}${left}`;
      els.bwLabel.textContent = "left";
      els.budgetWidget.setAttribute("aria-label", `${currency}${left} left of the ${currency}${budget} per-recipient budget — view shortlist`);
    }
  }

  function setKitBudget(value) {
    const n = parseFloat(value);
    state.kitBudget = Number.isFinite(n) && n > 0 ? n : null;
    renderBudgetWidget();
  }

  function initBudgetWidget() {
    const el = els.budgetWidget;
    if (!el) return;

    // Default dock position: bottom-right, respecting safe-area insets.
    const dockDefault = () => {
      const margin = 20;
      const safeBottom = Math.max(margin, window.innerHeight - 64 - margin);
      el.style.left = `${Math.max(margin, window.innerWidth - 64 - margin)}px`;
      el.style.top = `${safeBottom}px`;
    };
    dockDefault();
    window.addEventListener("resize", dockDefault, { once: false });

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;

    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 6) {
        moved = true;
        el.classList.add("dragging");
      }
      if (!moved) return;
      const margin = 4;
      const maxLeft = window.innerWidth - el.offsetWidth - margin;
      const maxTop = window.innerHeight - el.offsetHeight - margin;
      const nextLeft = Math.min(Math.max(margin, originLeft + dx), maxLeft);
      const nextTop = Math.min(Math.max(margin, originTop + dy), maxTop);
      el.style.left = `${nextLeft}px`;
      el.style.top = `${nextTop}px`;
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("dragging");
      if (!moved) {
        openSheet();
      }
      try { el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
  }

  // ---------- Sheet ----------
  let lastFocusedBeforeSheet = null;

  function openSheet() {
    lastFocusedBeforeSheet = document.activeElement;
    renderSheetItems();
    showQuoteFormView();
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
  const BRANDING_LABELS = {
    "logo-engraving": "Logo engraving",
    "screen-print": "Screen print",
    "embroidery": "Embroidery",
    "none": "No branding needed",
  };

  function selectBranding(key) {
    state.branding = state.branding === key ? null : key;
    updateBrandingChipsUI();
  }

  function updateBrandingChipsUI() {
    if (!els.brandingChips) return;
    Array.from(els.brandingChips.children).forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.branding === state.branding));
    });
  }

  function quoteLineItems() {
    const items = [];
    let totalQty = 0;
    let totalAmount = 0;
    let hasPrices = true;
    state.shortlist.forEach((qty, productId) => {
      const product = state.products.find((p) => p.id === productId);
      if (!product) return;
      totalQty += qty;
      if (product.price != null) totalAmount += product.price * qty;
      else hasPrices = false;
      items.push({ product, qty });
    });
    return { items, totalQty, totalAmount, hasPrices };
  }

  function showQuoteFormView() {
    qs("quote-form-view").hidden = false;
    qs("quote-review-view").hidden = true;
    qs("footer-form-actions").hidden = false;
    qs("footer-review-actions").hidden = true;
  }

  function showQuoteReviewView() {
    const name = qs("client-name").value.trim();
    if (state.shortlist.size === 0 || !name || !state.selectedRep) return;
    saveClientInfo();

    const { items, totalQty, totalAmount, hasPrices } = quoteLineItems();
    const company = qs("client-company").value.trim();
    const deliveryCity = qs("client-delivery-city").value.trim();
    const neededBy = qs("client-needed-by").value;
    const recipientCount = qs("client-recipient-count").value.trim();
    const budgetPerRecipient = qs("client-budget-per-recipient").value.trim();
    const { currency } = state.config;

    const rows = [];
    rows.push(["Items", `${items.length} product${items.length === 1 ? "" : "s"} · ${totalQty} pcs`]);
    if (state.branding) rows.push(["Branding", BRANDING_LABELS[state.branding]]);
    if (deliveryCity || neededBy) {
      rows.push(["Delivery", [deliveryCity, neededBy ? `by ${neededBy}` : ""].filter(Boolean).join(" · ")]);
    }
    if (recipientCount) rows.push(["Recipients", recipientCount]);
    if (budgetPerRecipient) rows.push(["Budget / recipient", `${currency}${budgetPerRecipient} (indicative)`]);
    rows.push(["Sending to", state.selectedRep.name]);

    const rowsHTML = rows.map(([k, v]) => `
      <div class="review-row"><span class="review-k">${k}</span><span class="review-v">${v}</span></div>
    `).join("");
    const totalHTML = state.config.showPrices && hasPrices
      ? `<div class="review-row review-total"><span class="review-k">Merchandise subtotal</span><span class="review-v">${currency}${totalAmount}</span></div>`
      : "";

    qs("review-rows").innerHTML = rowsHTML + totalHTML;

    qs("quote-form-view").hidden = true;
    qs("quote-review-view").hidden = false;
    qs("footer-form-actions").hidden = true;
    qs("footer-review-actions").hidden = false;
  }

  function buildMessage() {
    const name = qs("client-name").value.trim();
    const company = qs("client-company").value.trim();
    const whatsapp = qs("client-whatsapp").value.trim();
    const notes = qs("client-notes").value.trim();
    const deliveryCity = qs("client-delivery-city").value.trim();
    const neededBy = qs("client-needed-by").value;
    const recipientCount = qs("client-recipient-count").value.trim();
    const budgetPerRecipient = qs("client-budget-per-recipient").value.trim();
    const { currency } = state.config;
    const { items, totalQty, totalAmount, hasPrices } = quoteLineItems();

    const lines = [];
    lines.push(`*New Quote Request${company ? ` — ${company}` : ""}*`);
    lines.push("");

    lines.push("*Items*");
    items.forEach(({ product, qty }, idx) => {
      const brand = state.brandByProduct[product.id];
      const brandText = brand ? ` (${brand})` : "";
      if (state.config.showPrices && product.price != null) {
        lines.push(`${idx + 1}. ${product.name}${brandText} — Qty ${qty} × ${currency}${product.price} = ${currency}${product.price * qty}`);
      } else {
        lines.push(`${idx + 1}. ${product.name}${brandText} — Qty ${qty}`);
      }
    });
    lines.push("");

    if (state.config.showPrices && hasPrices) {
      lines.push(`*Subtotal:* ${totalQty} pcs · ${currency}${totalAmount}`);
    } else {
      lines.push(`*Subtotal:* ${totalQty} pcs`);
    }
    lines.push("");

    if (state.branding) lines.push(`*Branding:* ${BRANDING_LABELS[state.branding]}`);
    if (deliveryCity) lines.push(`*Delivery city:* ${deliveryCity}`);
    if (neededBy) lines.push(`*Needed by:* ${neededBy}`);
    if (recipientCount) lines.push(`*Recipients:* ${recipientCount}`);
    if (budgetPerRecipient) lines.push(`*Budget per recipient:* ${currency}${budgetPerRecipient} (indicative, confirm with GST/branding)`);
    if (state.branding || deliveryCity || neededBy || recipientCount || budgetPerRecipient) lines.push("");

    lines.push("*Contact*");
    lines.push(`${name || "A client"}${company ? ` · ${company}` : ""}`);
    if (whatsapp) lines.push(whatsapp);
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
    els.brandLink = qs("brand-link");
    els.homeBtn = qs("home-btn");
    els.themeToggle = qs("theme-toggle");
    els.brandLogo = qs("brand-logo");
    els.clientBanner = qs("client-banner");
    els.discoveryBar = qs("discovery-bar");
    els.homeView = qs("home-view");
    els.recentlyViewedSection = qs("recently-viewed-section");
    els.recentlyViewedRow = qs("recently-viewed-row");
    els.cbPreviewFloat = qs("cb-preview-float");
    els.cbpImg = qs("cbp-img");
    els.cbpBrand = qs("cbp-brand");
    els.cbpName = qs("cbp-name");
    els.cbpPrice = qs("cbp-price");
    els.categoryView = qs("category-view");
    els.categoryGrid = qs("category-grid");
    els.chipRow = qs("chip-row");
    els.productGrid = qs("product-grid");
    els.emptyState = qs("empty-state");
    els.backBtn = qs("back-btn");
    els.stickyBar = qs("sticky-bar");
    els.stickySummary = qs("sticky-summary");
    els.budgetWidget = qs("budget-widget");
    els.bwFill = qs("bw-fill");
    els.bwOverflow = qs("bw-overflow");
    els.bwValue = qs("bw-value");
    els.bwLabel = qs("bw-label");
    els.sheetOverlay = qs("sheet-overlay");
    els.sheet = qs("shortlist-sheet");
    els.closeSheetBtn = qs("close-sheet-btn");
    els.sheetItems = qs("sheet-items");
    els.sheetEmpty = qs("sheet-empty");
    els.sheetTotal = qs("sheet-total");
    els.sendBtn = qs("send-whatsapp-btn");
    els.reviewBtn = qs("review-btn");
    els.reviewEditBtn = qs("review-edit-btn");
    els.brandingChips = qs("branding-chips");
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
    els.brandPageLink = qs("brand-page-link");
    els.pageSizeSelect = qs("page-size-select");
    els.sortSelect = qs("sort-select");
    els.pager = qs("pager");
    els.pagerPrev = qs("pager-prev");
    els.pagerNext = qs("pager-next");
    els.pagerLabel = qs("pager-label");
    els.searchInput = qs("search-input");
    els.budgetChips = qs("budget-chips");
    els.kitRow = qs("kit-row");
    els.brandChips = qs("brand-chips");
    els.moreBrandsBtn = qs("more-brands-btn");
    els.sidebarCategories = qs("sidebar-categories");
    els.desktopCartBtn = qs("desktop-cart-btn");
    els.desktopCartBadge = qs("desktop-cart-badge");
    els.searchSuggest = qs("search-suggest");

    initTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeIcon);

    // Armed before the data fetch below, not after — see the comment on
    // armWelcomeDismissal for why.
    armWelcomeDismissal();

    let config, data;
    try {
      [config, data] = await Promise.all([
        fetchJSON("data/config.json"),
        fetchJSON("data/products.json"),
      ]);
    } catch (err) {
      document.body.style.overflow = "";
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
    updateWelcomeText();

    try {
      state.brandByProduct = await fetchJSON("data/brands.json");
    } catch (err) {
      state.brandByProduct = {}; // optional file; brand filter just stays empty if absent
    }

    try {
      state.kits = await fetchJSON("data/kits.json");
    } catch (err) {
      state.kits = []; // optional file; kit row just stays empty if absent
    }

    document.title = config.businessName || "Gift Catalog";
    els.businessName.textContent = config.businessName || "Catalog";
    els.businessTagline.textContent = config.tagline || "";

    applyClientFilter();
    loadShortlist();

    const savedClient = loadClientInfo();
    if (savedClient.name) qs("client-name").value = savedClient.name;
    if (savedClient.company) qs("client-company").value = savedClient.company;
    if (savedClient.whatsapp) qs("client-whatsapp").value = savedClient.whatsapp;
    if (savedClient.notes) qs("client-notes").value = savedClient.notes;
    if (savedClient.deliveryCity) qs("client-delivery-city").value = savedClient.deliveryCity;
    if (savedClient.neededBy) qs("client-needed-by").value = savedClient.neededBy;
    if (savedClient.recipientCount) qs("client-recipient-count").value = savedClient.recipientCount;
    if (savedClient.budgetPerRecipient) qs("client-budget-per-recipient").value = savedClient.budgetPerRecipient;
    if (savedClient.branding) state.branding = savedClient.branding;
    if (savedClient.repName) {
      state.selectedRep = (state.config.salesTeam || []).find((r) => r.name === savedClient.repName) || null;
    }
    state.kitBudget = null;
    if (savedClient.budgetPerRecipient) setKitBudget(savedClient.budgetPerRecipient);

    renderSalesPicker();
    updateBrandingChipsUI();
    renderKits();
    renderCategoryGrid();
    renderSidebarCategories();
    renderRecentlyViewed();
    updateStickyBar();
    buildSearchIndex();
    initBudgetWidget();

    // Deep link from a product page's "back to <category>" link, e.g.
    // product/electronics-404/ links to ../../?category=electronics.
    const requestedCategory = new URLSearchParams(window.location.search).get("category");
    // Deep link from a brand page's back link, e.g. brand/offikraft/ links
    // to ../../?brand=Offikraft -- same pattern as the category deep link.
    const requestedBrand = new URLSearchParams(window.location.search).get("brand");
    const knownBrands = new Set(Object.values(state.brandByProduct));
    if (requestedCategory && state.visibleCategories.some((c) => c.id === requestedCategory)) {
      openCategory(requestedCategory);
    } else if (requestedBrand && knownBrands.has(requestedBrand)) {
      selectBrand(requestedBrand);
    }
    // No deep link: both breakpoints land on the home view (#home-view is
    // visible by default in the markup, so no action needed here).

    els.sidebarCategories.addEventListener("click", (e) => {
      const btn = e.target.closest(".sidebar-cat-item");
      if (!btn) return;
      if (btn.dataset.all) browseAllProducts();
      else openCategory(btn.dataset.cat);
    });
    els.desktopCartBtn.addEventListener("click", openSheet);

    els.brandLink.addEventListener("click", goHome);
    els.homeBtn.addEventListener("click", goHome);
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
      const raw = els.searchInput.value;
      const rawTrimmed = raw.trim();
      const wasSearching = !!state.searchQuery;

      const { text, minPrice, maxPrice } = parseSearchQuery(rawTrimmed);
      state.searchQuery = text;
      // A price phrase in the query (e.g. "bags under 1500") drives price
      // filtering the same way a budget chip does, for as long as the box
      // has text in it; clearing just the phrase clears the price filter.
      if (rawTrimmed) {
        state.filters.minPrice = minPrice;
        state.filters.maxPrice = maxPrice;
        const matchedKey = Object.keys(BUDGET_PRESETS).find((key) => {
          const preset = BUDGET_PRESETS[key];
          return preset.min === minPrice && preset.max === maxPrice;
        });
        state.budgetKey = matchedKey || null;
        updateBudgetChipsUI();
        updateFiltersBadge();
      }

      renderSuggestions(text);

      if (!rawTrimmed) {
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
        renderSidebarCategories();
      }
      state.pagination.page = 1;
      renderProducts();
    });

    els.searchInput.addEventListener("keydown", (e) => {
      if (els.searchSuggest.hidden) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        suggestActiveIndex = Math.min(suggestActiveIndex + 1, suggestItems.length - 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        suggestActiveIndex = Math.max(suggestActiveIndex - 1, -1);
      } else if (e.key === "Enter" && suggestActiveIndex >= 0) {
        e.preventDefault();
        applySuggestion(suggestItems[suggestActiveIndex]);
        return;
      } else if (e.key === "Escape") {
        hideSuggestions();
        return;
      } else {
        return;
      }
      Array.from(els.searchSuggest.children).forEach((li, i) => {
        li.classList.toggle("is-active", i === suggestActiveIndex);
      });
    });

    els.searchSuggest.addEventListener("mousedown", (e) => {
      // mousedown (not click) so this fires before the input's blur handler
      const item = e.target.closest(".search-suggest-item");
      if (!item) return;
      e.preventDefault();
      applySuggestion(suggestItems[Number(item.dataset.index)]);
    });

    els.searchInput.addEventListener("blur", () => {
      window.setTimeout(hideSuggestions, 120);
    });
    els.searchInput.addEventListener("focus", () => {
      if (els.searchInput.value.trim()) renderSuggestions(els.searchInput.value);
    });
    els.budgetChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      selectBudget(btn.dataset.budget);
    });
    els.kitRow.addEventListener("click", (e) => {
      const btn = e.target.closest(".kit-add-btn");
      if (!btn) return;
      addKitToShortlist(btn.closest(".kit-card").dataset.kitId);
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
    els.reviewBtn.addEventListener("click", showQuoteReviewView);
    els.reviewEditBtn.addEventListener("click", showQuoteFormView);
    els.brandingChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip[data-branding]");
      if (!btn) return;
      selectBranding(btn.dataset.branding);
    });
    qs("client-name").addEventListener("input", updateStickyBar);
    qs("client-budget-per-recipient").addEventListener("input", (e) => setKitBudget(e.target.value));
    els.lightbox.addEventListener("click", closeLightbox);
    qs("lightbox-close").addEventListener("click", closeLightbox);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.lightbox.hidden) closeLightbox();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
