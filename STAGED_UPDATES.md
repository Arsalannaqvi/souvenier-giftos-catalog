# Staged Updates

Workflow: when a preview is approved ("I like it"), it's logged under **Pending**
below instead of shipping right away. Pending updates sit here, implemented but
not live — work keeps moving to the next idea. Saying "make it live" (or similar)
implements and pushes everything in **Pending** in one batch; each item then
moves down into **Shipped** with its commit hash and ship date.

Ask "how many pending" any time for a quick count.

## Pending (4)

1. **Dedicated per-brand pages** — a real static page per brand (not just a
   client-side filter), `brand/<slug>/index.html`, for every brand with 3+
   products (46 of 59 distinct brands in `data/brands.json` clear that bar;
   the other 13 have only 1-2 products and are noise, not a real assortment).
   Monogram hero mark (no real brand logo images exist in this catalog) with
   real computed stats (product count, category count, price range), a
   category chip rail with real counts, and price/sort filters, all client-
   side off a `window.__BRAND__` JSON payload embedded per page (no per-page
   refetch of `products.json`) — same pattern as `scripts/generate_product_pages.py`.
   Product cards reuse the site's real `.product-card` markup and the shared
   shortlist localStorage key, so add-to-enquiry stays in sync with the main
   catalog. New script: `scripts/generate_brand_pages.py` (deletes+rebuilds
   `brand/` each run); new `js/brand.js`. Homepage integration is additive
   only: a "View full brand page →" link appears next to the results summary
   once a brand filter is active (`js/app.js`'s `updateToolbar`) — the
   existing brand-tile click (`selectBrand()`) is untouched and still just
   filters in place, no navigation. Brand pages link back to the homepage
   pre-filtered via a new `?brand=` deep link (mirrors the existing
   `?category=` deep link from product pages). Files: `scripts/generate_brand_pages.py`
   (new), `js/brand.js` (new), `brand/` (new, 46 pages), `css/styles.css`,
   `index.html`, `js/app.js`. Tested locally (mobile + desktop, 3 brands of
   different sizes — Offikraft 147 products, boAt 347, Borosil 7 — price
   filter, sort, the new brand-page link, the back-link round-trip, and the
   homepage brand-tile behavior unchanged); committed locally, not pushed.

2. **Floating budget/cart widget** — replaces the plain sticky cart bar with a
   draggable circular badge (grab and move anywhere on screen). Two modes:
   no budget set shows the item count; a per-recipient budget (reuses the
   "Budget per recipient" field already in the quote form, synced live) shows
   a blue→violet ring filling clockwise from 12 o'clock as the kit's distinct
   item prices approach it, with the remaining amount in the center. Over
   budget, a second red arc sweeps from 12 o'clock in proportion to the
   overage, layered on the completed base ring, with the center switching to
   the overage amount. Clicking (not dragging) opens the existing shortlist
   sheet. Files: `index.html`, `css/styles.css`, `js/app.js`. Tested locally
   (mobile + desktop, live ring updates, drag-vs-click disambiguation, the
   over-budget state); committed locally, not pushed.
   Note: tracks the sum of *distinct* product prices in the shortlist against
   the per-recipient budget (not multiplied by quantity) — i.e. "does this
   combo of items fit one recipient's kit," separate from the bulk order
   quantities the quote builder already handles. Flagging this assumption
   again since it hasn't been explicitly confirmed yet.

3. **"Continue Browsing" (recently viewed) on the homepage — compact sliding
   row with hover preview** — the mobile home view (`#home-view`/discovery
   bar) shows a single horizontally-scrolling row of the visitor's last few
   viewed products, hidden entirely until they've actually viewed something
   (true first-time visitors see nothing). Each item shows only name + price
   (`.cb-item`/`.cb-name`/`.cb-price`); hovering (desktop) or focusing
   (keyboard) reveals a full product preview tile — image, brand, name,
   price — positioned by JS (`getBoundingClientRect()`) in a shared
   `#cb-preview-float` element at `position: fixed`, above the hovered item
   with edge-clamping so it never runs off-screen, and a CSS-variable
   (`--arrow-x`) pointer triangle that stays aimed at the item even when the
   tile itself is clamped away from center. The JS-positioned approach (not a
   CSS child popup) is required because a horizontally-scrolling row
   (`overflow-x: auto`) also clips vertical overflow per spec — a popup
   nested inside would get cut off. Items are still real links
   (`<a href="product/<id>/">`) so clicking navigates normally; the preview
   is purely additive. Supersedes the earlier vertical-card version of this
   same feature (reused `.pd-suggest-card` styling) — replaced before ever
   shipping. Product pages still record each view into the shared
   `wa-catalog:recently-viewed` localStorage key (most-recent-first, deduped,
   capped at 12); the homepage reads it back and resolves real product data.
   Files: `index.html`, `css/styles.css`, `js/app.js`, `js/product.js`.
   Tested locally (mobile viewport, 5-item seeded history, hover preview
   shows correct real image/brand/name/price, right-edge item clamps
   correctly with the arrow still pointing at it, clicking an item navigates
   to the right product page, fresh-visit hidden state); committed locally,
   not pushed. Desktop has no distinct home view to attach this to (it always
   lands on the full product grid) so this is mobile-only for now, same as
   the rest of `#home-view`.
   **Not included**: the companion "Recently Added" section from the same
   original preview. The catalog has no real date-added field, so there's no
   genuine data to show "newest first" without guessing — flagged to the
   user rather than faked.
   **Open question, not yet resolved**: hover doesn't exist on touch devices
   (the primary audience here) — on mobile the preview currently only shows
   via keyboard focus, not touch. Worth a decision (tap-and-hold vs. just
   showing the image inline) before this ships live.

4. **"Shop by Kit" — merged into the old Occasion row** — replaces the old
   2-chip Occasion row (🪔 Diwali Hampers / 🏆 Recognition & Awards) in the
   exact same homepage slot, zero net height added. Shows a horizontally-
   scrolling row of curated kits (3 real products bundled as a set), each
   card with thumbnails of its contents, the kit name, a 2-line-clamped list
   of what's inside, the combined real price, and a "+ Add kit" button that
   adds all of the kit's component products to the shortlist in one tap
   (reuses the existing `setQty()`/shortlist logic — no new cart mechanism).
   New data file `data/kits.json` (3 kits to start — Joining Kit, Festive
   Hamper, Recognition Kit — every product ID in it verified real against
   `data/products.json` before writing); fetched client-side with a graceful
   fallback to an empty array if the file is ever missing, so a missing/empty
   kits file just means the row stays empty rather than breaking the page.
   Files: `index.html`, `css/styles.css`, `js/app.js`, `data/kits.json` (new).
   Tested locally (mobile viewport: all 3 kits render with correct real
   thumbnails/names/contents/prices, "+ Add kit" correctly adds all 3
   component products and updates the budget widget count, no console
   errors); committed locally, not pushed.

## Shipped

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
