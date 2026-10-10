# Staged Updates

Workflow: when a preview is approved ("I like it"), it's logged under **Pending**
below instead of shipping right away. Pending updates sit here, implemented but
not live — work keeps moving to the next idea. Saying "make it live" (or similar)
implements and pushes everything in **Pending** in one batch; each item then
moves down into **Shipped** with its commit hash and ship date.

Ask "how many pending" any time for a quick count.

## Pending (1)

1. **Desktop gets a real home page — no sidebar at all while on it** —
   desktop used to skip straight to a flat "All Products" grid on landing
   (and whenever you clicked back/home), with no equivalent of the mobile
   home screen. Now both breakpoints land on the same curated home
   experience. Browsing a specific category (or "All Products") keeps
   today's two-column layout unchanged: sidebar (Search, Categories,
   Budget, Shop by Kit, Brand) + product grid.
   **The home page itself drops the sidebar entirely** — Search, Brand,
   Budget, Shop by Kit, and Continue Browsing (only once the visitor has
   viewed a product) become full-width sections stacked above the "Browse
   Categories" tile grid (widened to 4 columns on desktop instead of the
   phone's 2), the same single-column shape as mobile just at desktop
   width, instead of being squeezed into a narrow side column. "All
   Products" is still one click away once inside a category, via the
   sidebar's "All Products" entry. Categories list is skipped on the home
   page since the tile grid already covers that job. A `home-active` class
   on `<body>` swaps the desktop grid between the single-column home layout
   and the two-column sidebar+grid layout, set/cleared by `goHome()` /
   `openCategory()` / `browseAllProducts()` / `enterBrowseAll()` (same
   functions that already track which view is active). Removed the old
   auto-switch-to-all-products listener that fired when resizing across the
   1024px breakpoint while idle on the home grid, since home is now a valid
   view at both sizes.
   Files: `index.html`, `js/app.js`, `css/styles.css`.
   Tested locally at 1440×900: home page renders with no sidebar column
   (verified `body`'s computed grid-template-columns is a single `1fr`,
   `#discovery-bar`'s rendered width matches the full container) and the
   right section order top-to-bottom (Search, Brand, Budget, Shop by Kit,
   Continue Browsing populated from seeded view history, then Browse
   Categories); opening a category correctly restores the 272px sidebar +
   product-grid layout unchanged; the "← All categories" back button
   returns to the no-sidebar home layout. Committed locally, not pushed.

## Shipped

- **2026-10-10** — Dedicated per-brand pages — a real static page per brand
  (not just a client-side filter), `brand/<slug>/index.html`, for every brand
  with 3+ products (46 of 59). Monogram hero, real computed stats, category
  chip rail, price/sort filters, all off a `window.__BRAND__` JSON payload
  per page. "View full brand page →" link appears next to the results
  summary once a brand filter is active; brand pages deep-link back via
  `?brand=` — `07f9e6d2`
- **2026-10-10** — Floating budget/cart widget — replaces the sticky cart bar
  with a draggable circular badge. No budget set shows item count; a
  per-recipient budget shows a blue→violet ring filling clockwise from
  12 o'clock, with a red overflow arc if the shortlist goes over. Clicking
  (not dragging) opens the shortlist sheet — `decdc421`
  _(tracks the sum of **distinct** product prices in the shortlist against
  the per-recipient budget, not ×quantity — flagging this assumption since
  it's never been explicitly confirmed)_
- **2026-10-10** — "Continue Browsing" (recently viewed) on the homepage —
  compact name+price sliding row; hovering/focusing an item reveals a full
  preview tile (image, brand, name, price) positioned by JS with
  edge-clamping, since a horizontal-scroll row clips a nested CSS popup.
  Items are real links, so clicking navigates normally. Product pages record
  views into `wa-catalog:recently-viewed` (localStorage, capped at 12) —
  `b4ffdfeb`, `fdcb8ffd`
  _(not included: a "Recently Added" companion section — no real date-added
  field exists to source it from, so it was flagged rather than faked)_
  _(open question: hover doesn't exist on touch devices — mobile currently
  only gets the preview via keyboard focus, not tap; worth revisiting)_
- **2026-10-10** — "Shop by Kit" — merged into the old Occasion row, same
  slot, zero net height added. Horizontally-scrolling row of curated kits
  (`data/kits.json`) with real thumbnails/contents/price and a "+ Add kit"
  button that drops all of a kit's products into the shortlist in one tap —
  `fdcb8ffd`
- **2026-10-09** — Bulk quotation builder — adds Branding (logo engraving /
  screen print / embroidery / no branding), delivery city, needed-by date,
  recipient count, and budget-per-recipient (indicative, labelled as such) to
  the shortlist form; sending now goes through a Review screen first
  (Edit / Confirm) before opening WhatsApp with a fully itemized, structured
  message instead of the old loose list — `bed33740`
- **2026-10-09** — Brand slider on the homepage, fixed — the "Brand" quick-row's
  flat text chips are now compact tiles (monogram badge + name), sized so 5
  are visible at once on a phone screen with a 6th peeking at the edge; a
  follow-up fix made every brand name render in full (no ellipsis, no
  mid-word breaks). Same underlying `selectBrand()`/filter logic, just
  restyled — `fc6284d9`, `30c65709`
- **2026-10-09** — Dark navy / electric-blue / violet "futuristic luxury" rebrand
  (hero/welcome-screen glow, gradient CTAs and price text, Space Grotesk +
  Inter typography, gradient size-picker pills) — `8116747a`
  _(shipped immediately, before this staging workflow was set up)_
