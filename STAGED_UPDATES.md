# Staged Updates

Workflow: when a preview is approved ("I like it"), it's logged under **Pending**
below instead of shipping right away. Pending updates sit here, implemented but
not live — work keeps moving to the next idea. Saying "make it live" (or similar)
implements and pushes everything in **Pending** in one batch; each item then
moves down into **Shipped** with its commit hash and ship date.

Ask "how many pending" any time for a quick count.

## Pending (1)

1. **Floating budget/cart widget** — replaces the plain sticky cart bar with a
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
