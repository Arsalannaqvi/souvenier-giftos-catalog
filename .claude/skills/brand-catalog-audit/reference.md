# Brand Catalog Audit — reference

## Calibration log — audits run so far

Keep entries terse and dated, newest first. Each one is what let the
`SKILL.md` recipe get written in the first place — update this log
instead of letting the next audit re-derive the same lessons from git
history.

### 2026-10-30 — TTH → Botanica (relabel, 13 products)
Not a scheduled audit — surfaced mid-task when TTH's own stored
spec-sheet images never showed "TTH" branding anywhere, only "Botanica"
(an Optiknit/GRS-certified textile line). Owner confirmed Botanica was
correct. Fixed `data/brands.json`'s mapping **and** `data/products.json`'s
`name` field (both said "TTH") — confirmed the hard way that fixing only
one leaves a stale value visible somewhere. Separately, 3 Scott-labeled
products (apparel-73/-75/-77) carrying different sub-brand logos
("spark"/"Six Degrees"/"The Bio Collection") were checked and confirmed
by the owner as Scott's own named sub-lines, not a misattribution — left
as-is. Lesson: a different logo/name on a spec sheet isn't automatically
a misattribution; confirm before assuming either way.

### 2026-10-10 — Magnus Eco (removal, 290 products)
Whole-brand removal once confirmed gone. The real lesson is the cascade,
easy to miss: removing a brand this size meant also removing its brand
page, its hardcoded chip in `index.html`'s homepage brand slider, and
regenerating every *other* product's "related products" list catalog-wide
(removing 290 items shifted array positions everywhere, not just on the
removed products' own pages). The "Sustainable" category had no other
brand in it, so it correctly disappeared from Browse Categories after
regeneration — checked, not assumed.

### 2026-10-10 — Goblin (36 products: 10 kept, 26 removed)
Checked the live site (all 8 "Shop All" pages + Accessories, confirmed
Backpacks category now empty) **and** the current 72-page PDF catalog
before removing anything. One product (Elegance Tote Bag) wasn't live
but was in the PDF — kept, photo cropped from the PDF page and
self-hosted under `assets/products/` since there's no live product URL
to source an image from. The other 26 (the entire former backpack line,
several totes/wallets/purses/sling bags, EON- and Polo-branded items)
were confirmed absent from both sources before removal.

### 2026-10-10 — Samsonite (16 products: 1 typo fix, 1 description added, 5 flagged discontinued, 1 price flagged)
Verified via exhaustive category-page walks on samsonite.in — bags
56/56, backpacks 48/48, travel-accessories 32/32 — not a site search,
which is what reliably separates "actually discontinued" from "my search
just missed it." Fixed a brand-name typo ("Samonite" → "Samsonite").
5 product lines (Carecase, Integra Backpack, Ikonn Eco III, Ebis
Backpack, Tech ICT Medium briefcase) confirmed absent from every live
category listing — left as-is, no fabricated descriptions/specs added,
since their stored images were still visually confirmed as genuine
Samsonite product photos even without a live page to source updates
from. One price (Openroad 2.0) deliberately left blank and flagged for
the owner: live MRP was confirmed, but this catalog's "price" field
doesn't reliably track MRP for sibling products (a sibling, Toiis C,
stores 14831 against a live MRP of 12,400) — filling it from MRP alone
risked conflating MRP with the B2B/offering price.

## Known pitfalls (don't re-learn these)

- **Two files, not one, hold "the brand."** `data/brands.json`'s mapping
  and `data/products.json`'s `name` string can disagree. Fix both when
  both are wrong; fixing only one leaves a stale value somewhere a user
  can still see it.
- **A site search box is not a full audit.** Walk every category/listing
  page and compare real counts. A search miss only means the search
  missed it, not that the product is gone.
- **One source is never enough to declare something discontinued.**
  Check the official site AND any PDF/Excel catalog before removing.
- **Removing products shifts "related products" everywhere**, not just
  on the pages you touched. Regenerate `generate_product_pages.py` for
  the whole catalog after any add/remove, not a partial run.
- **The homepage brand slider in `index.html` is hardcoded**, not
  generated. A brand removal needs a manual edit there; the generator
  scripts won't catch it.
- **This is customer-visible.** Stage on a branch, don't push straight
  to `main`, unless the owner has explicitly said otherwise for this
  specific change.
- **A differently-named logo/sub-brand on a spec sheet isn't
  automatically a misattribution** (see the Scott sub-lines in the TTH
  entry above) — confirm with the owner either way, don't assume in
  either direction.

## A close relative, not (yet) folded in here

The "hide non-gift products" passes (83 products 2026-10-30, 60 more
the same day) share this skill's enumerate → classify → document shape,
but audit *gift-worthiness* via `hideFromCatalog: true`, not brand
identity/accuracy. Worth knowing about if you're about to write a
similar audit skill for that: the second pass modeled a good pattern —
a subagent proposed candidate categories, and the main session reviewed
each against real data and correctly declined 2 of the 4 proposed
categories (personal grooming/fragrance, and "health-claim" wellness
gadgets) as false positives rather than applying them wholesale.
