# Codex briefing — livepriceupdate

Ongoing log for the weekly Saturday 🔴 pricey-tier scheduled run (and any
ad hoc session doing the same kind of work mid-week): what's already
been covered recently, so it isn't re-investigated from scratch. Newest
entries first. Terse and factual — full reasoning for anything below
lives in `SKILL.md`'s "Domain reachability"/"Known gaps" sections and
in `check_live_prices_tier_b_jsonld.py`'s own `DOMAIN_MRP_PATTERNS`
comment blocks; this file is the index of what happened, not the
reasoning itself.

## 2026-11-07 — Tier A multiVariant false-positive fix (reconciled branch, 3 fixes in one script)

Branch `tier-b-offikraft-mrp-fix` (merged `origin/main` and
`add-brand-catalog-audit-skill` into it first — see below). Picked Tier A
"re-discovery work" this week: 163 of 195 yellow `tier_a_shopify` items
were generic `"unresolved"`, all really `multiVariant` entries. Root
cause: `check_live_prices.py` flagged a product as ambiguous whenever its
variants' **selling** price disagreed (colour/engraving options), even
when every variant agreed on the exact same `compare_at_price` (the real
MRP this script stores). 121 of 178 multiVariant flags were
`boat-lifestyle.com` alone — e.g. "Airdopes 141" sells at 4 different
colour/engraving prices but all 4 share one `compare_at_price` (4490),
so there was never a real MRP ambiguity.

**Fix 1** — check `compare_at_price` agreement instead of selling-price
agreement. Still correctly flags genuine ambiguity: `compare_at_price`
itself disagreeing across variants (e.g. `storm-call-3-smartwatch`, 2
variants, MRP 8499 vs 8999), or no `compare_at_price` anywhere AND
selling price varies (e.g. `nottynuts.in`'s weight-based variants, no
MRP concept at all, 200g/400g/600g/800g at 4 real prices — stays
flagged, correctly, needs a human to match the catalog's stated weight
to the right variant).
**Fix 2** — a store can report `compare_at_price: "0.00"` instead of
leaving it null (`sunflame.com`); that string is truthy in Python, so a
naive filter treated "no MRP set" as "MRP is ₹0." Excluded non-positive
values explicitly.
**Fix 3** — an MRP can't legitimately be *below* the current selling
price. When it is anyway (`coconutlife.in`'s "Type C Dock 8 in 1 A",
"X650 Premium Power Supply", "MP03 Mouse Pad" — all three already
resolved once manually on the Notion Catalog Staging side 2026-10-31 for
this exact reason), fall back to the live selling price instead of
re-flagging the same known-bad `compare_at_price` every week.

**Result**: multiVariant 178 → 83 (95 were false positives, now resolved
— the vast majority landed on "unchanged" since the stored price was
already correct, confirming these were flagging noise, not a real price
problem). 3 applied (electronics-569, electronics-614, coconut-263 —
all ≤25% deltas), 9 genuinely flagged for human review (real deltas,
mostly >100% jumps worth an actual look — TintBox, Xech Mini Chef,
Sunflame Chimney, boAt Rockerz 255 Pro+, NoiseFit Halo 2, temptindia Mag
Mount, coconut-27 C32 cable). 83 still correctly held as genuine
multi-variant ambiguity, unchanged behavior for those.

**Branch reconciliation, same session**: `tier-b-offikraft-mrp-fix` had
drifted from `main` for 2+ weeks while the daily Tier A cron kept
committing directly to `main` on its own schedule. Merged
`origin/main` and `origin/add-brand-catalog-audit-skill` into this
branch (both clean, no conflicts) before starting this week's work, to
stop the two from diverging further. Not yet merged back into `main` —
flagged to the owner as a separate decision (this branch's price-data
fixes are customer-visible, so didn't push straight to `main` without
asking first, per this repo's branch discipline).

## 2026-10-31 — Tier B domain-discovery sweep (yellow-queue "no JSON-LD offers.price found")

Branch `tier-b-offikraft-mrp-fix`. Worked the priority-ordered list of
domains still failing Tier B extraction with "no JSON-LD offers.price
found" (10 domains/domain-groups, ~43 affected products combined).

**Verified MRP patterns added to `DOMAIN_MRP_PATTERNS`** (all
hand-verified against live pages, not just "a price field parsed"):
- `www.skullcandy.in` (12 products) — `<div class="sp-price">` block;
  prefers the `<s>` strikethrough MRP over the plain span when a
  discount is active, falls back to the plain span when it isn't.
- `powerpl.us` / `www.powerpl.us` (7 products) — JSON-LD
  `offers.priceSpecification[0].price` (the generic walker only checks
  `offers.price`/`offers.lowPrice`, missing this shape entirely).
- `www.dealsmagnet.com` (2 products) — plain-English "MRP: 845" in the
  page's own deal-description prose (no JSON-LD Product block exists).
- `www.dailyobjects.com` (1 product) — embedded page-state `"mrp"` key,
  verified it's the FIRST occurrence on the page (a recommendation
  carousel's other products' "mrp" fields render later) — only checked
  on one product/page, re-verify the ordering assumption if a second
  dailyobjects.com product ever needs this.
- `www.amazon.ae` (1 product, apparel-37) — Amazon's own embedded
  `"priceAmount":86.00` JSON; NOT blocked on this one product (contrast
  with amazon.in below). Stored price (604) doesn't reconcile to any
  plausible AED→INR rate against 86, but that's NOT a new bug —
  `product-price-log.json`'s existing Tier C entry already explains it:
  604 came from a same-SKU-family amazon.in listing in a different
  size, logged back on 2026-10-20 because this exact amazon.ae listing
  was "Currently unavailable" at the time. Logged a recheck-online
  event rather than re-raising it as new.

**Confirmed genuine dead ends** (comment blocks added, no
`DOMAIN_MRP_PATTERNS` entry — don't re-investigate without new
information):
- `www.mi.com` + `store.mi.com` (8 products combined) — identical,
  item-ID-agnostic client-rendered SPA shell regardless of URL; real
  data needs a client-side API call this script can't make. Not
  escalated to Apify (cost control: only Amazon gets that per this
  task's instructions).
- `www.ferrerorocher.com` (6 products) — brand marketing site, not a
  retailer; zero price data of any kind on the page (not even a sale
  price to confuse with MRP) — genuinely nothing to extract.
- `www.hunarsetu.com` (3 products) — pure client-rendered Vue SPA,
  empty `<div id="body"></div>` server response.
- `www.gopaisa.com` (1 product, apparel-80) — has a real preloaded
  state object, but it's the generic homepage shell for this deal URL,
  not deal-specific data.
- `www.tatacliq.com` (non-luxury, 1 product) — re-confirmed an existing
  note already in the script's top-of-file docstring; no new finding.
- `www.amazon.in` (4 products) — blocked by BOTH a plain fetch AND one
  Apify `rag-web-browser` attempt (both got the same
  "click to continue shopping" interstitial). Same disposition as
  myntra.com. Notably the opposite outcome from amazon.ae on the same
  product family in this same sweep — Amazon's bot-defense isn't a
  blanket per-domain rule, it's inconsistent per-request/per-URL.

**Script change (not domain-specific):** `main()`'s pattern-match logic
now picks the LAST non-`None` capturing group out of a domain pattern's
match, instead of always `group(1)` — needed so `www.skullcandy.in`'s
pattern can carry an optional second group (the strikethrough MRP) that
only exists on a discounted page. Every pre-existing single-group
pattern is unaffected (with one group, "last non-None" and `group(1)`
are the same value).

**Before/after this sweep** (full catalog run,
`data/price_check_report_tier_b_jsonld.json`):
- Before: candidates 425, unchanged 175, applied 37, flagged 93,
  unreachable 120.
- After: unchanged 224, applied 5, flagged 104, unreachable 92 (applied
  dropped from 37 because most of the previous run's applied deltas are
  now baked into `products.json` and read back as `unchanged` this
  time, not a regression).

**Not done, left for a future session:** the ~190 remaining
catalog-wide Tier B candidates across the rest of its domains
(ttkprestige, marshall, samsonite, puma, etc.) are still unverified for
the MRP-vs-sale split — this sweep only covered the specific
"no JSON-LD offers.price found" domains named in this task, not a full
audit. mi.com/store.mi.com and gopaisa.com are plausible Apify
candidates for a future session that wants to spend 🟡-tier cost on
them specifically.
