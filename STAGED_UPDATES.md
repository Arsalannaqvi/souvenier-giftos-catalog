# Staged Updates

Workflow: when a preview is approved ("I like it"), it's logged under **Pending**
below instead of shipping right away. Pending updates sit here, implemented but
not live — work keeps moving to the next idea. Saying "make it live" (or similar)
implements and pushes everything in **Pending** in one batch; each item then
moves down into **Shipped** with its commit hash and ship date.

Ask "how many pending" any time for a quick count.

## Pending (0)

Nothing waiting right now — everything approved so far is live.

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
