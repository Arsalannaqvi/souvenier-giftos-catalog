---
name: livepriceupdate
description: Use whenever asked to check, run, or triage a live MRP/sale-price verification pass on this catalog, at any tier — the daily Tier A cron (Shopify-backed suppliers), a Tier B run (non-Shopify sourceUrl, direct fetch + JSON-LD/microdata), or a Tier C pass (no sourceUrl at all — search + mandatory image verification). One invocation triggers/runs the relevant tier, waits for it, pulls the fresh report, and reports a before/after triage back in chat.
---

# Live Price Update (Tier A/B/C)

Three tiers, by how a product's `sourceUrl` is shaped:
- **Tier A** — a Shopify product URL (`.../products/<handle>`). Free,
  structured, zero scraping — runs on GitHub's own infra via cron.
- **Tier B** — a non-Shopify `sourceUrl` exists. Direct HTTP fetch +
  JSON-LD/microdata parsing. Two scripts: one dedicated
  (`check_live_prices_tier_b_stovekraft.py`, wired into the daily cron)
  and one generic multi-domain extractor
  (`check_live_prices_tier_b_jsonld.py`, run on demand so far, not yet
  wired into the cron — see "Known gaps").
- **Tier C** — no `sourceUrl` at all. No free structured source exists,
  so this is search + **mandatory image verification** before trusting
  any match — categorically different cost/rigor profile from A/B, see
  its own section below.

## Cost ladder: 🟢 cheap → 🟡 a little expensive → 🔴 pricey

Within EACH tier, options range from free/near-free to genuinely
expensive in tokens and/or metered API calls. Owner's policy
(2026-10-20): for any price-update request, run 🟢 automatically, let
it escalate to 🟡 automatically when 🟢 doesn't find/fix something, but
**don't silently reach for 🔴** — either tell the owner what the 🔴
option would cost before doing it, or let it wait for the weekly
Saturday scheduled run (`trig_011cw8syyvNTkxQFZTGUd2jx`, recurring,
see below) rather than running it ad hoc mid-week.

| Tier | 🟢 Cheap (free/near-free) | 🟡 A little expensive | 🔴 Pricey |
|---|---|---|---|
| A | Shopify `/products/<handle>.json`, zero Claude usage, daily cron | This session triaging flagged/unreachable/multiVariant items (reads logs, reasons once, no paid APIs) | Re-discovering a broken/ambiguous product's correct Shopify listing — effectively a mini Tier C search+image-verify for just that item |
| B | Plain `urllib` fetch + JSON-LD/microdata/`DOMAIN_MRP_PATTERNS` parsing, zero Claude usage once scripted | A handful of Apify `web-fetch`/`rag-web-browser` calls for bot-blocked domains (nykaa.com-style) — metered but no heavy reasoning | Reverse-engineering a brand-new domain's MRP pattern by hand (what produced today's decathlon.in/havells.com/luxury.tatacliq.com fixes) — real token spend per domain, and should be batched, not one-off |
| C | Check for a secret structured catalog first (Shopify `/products.json` or similar) and match locally — no search, no subagents (the Coconut technique) | One Claude session doing search + fetch + image-verify directly, product by product, no subagents | The full multi-subagent parallel pilot-batch treatment (2-3 parallel agents, ~300-450k tokens each) — this IS the Saturday-scheduled work |

Escalation order within a tier is always 🟢 first; 🟡 only when 🟢
comes up empty/ambiguous for a specific item; 🔴 only on explicit ask
or the Saturday schedule — never jump straight to 🔴 because 🟢 or 🟡
"might not be worth trying."

## Tier A (Shopify)

Checks every product whose `sourceUrl` is a Shopify product page
(`.../products/<handle>`) against the live price on the supplier's own
site, and applies safe changes automatically. Runs on GitHub's own
infrastructure — **never touches Claude usage** (the explicit point of
building it this way: "I need something that can be run on low usage
limit"). This skill is for running/checking it **on demand** — it also
runs itself daily on a cron regardless of whether this skill is invoked.

### The recipe (run this whenever asked to do a live price check)

1. **Trigger it**: `mcp__github__actions_run_trigger` → `run_workflow`,
   `owner: "Arsalannaqvi"`, `repo: "souvenier-giftos-catalog"`,
   `workflow_id: "daily-price-check.yml"`, `ref: "main"`.
2. **Get the new run's id**: `mcp__github__actions_list` →
   `list_workflow_runs`, `resource_id: "daily-price-check.yml"`,
   `perPage: 1` — take the newest run's `id`.
3. **Poll, don't block**: `mcp__github__actions_get` →
   `get_workflow_run` with that `resource_id`. Typical runtime is
   **~5-15 min** (longer when several Tier-A domains are rate-limiting
   that hour and retries kick in — see calibration log). Check every
   3-10 min via `ScheduleWakeup`/background checks rather than polling
   tightly; don't `sleep` and block the turn.
4. **On completion**:
   - `conclusion: "success"` → `mcp__github__actions_list` →
     `list_workflow_jobs` (that run's id) to get the job id, then
     `mcp__github__get_job_logs` (`return_content: true`) and read the
     printed `Candidates / Unchanged / Applied / Flagged / Multi-variant
     / Unreachable` line — that's the headline summary.
   - `conclusion: "failure"` → `mcp__github__get_job_logs` with
     `failed_only: true, return_content: true` immediately. Read the
     actual traceback before proposing any fix or re-triggering blind.
5. **Sync locally**: `git pull origin main` in
   `/home/user/souvenier-giftos-catalog` (the workflow commits+pushes
   its own changes when anything changed) *before* reading
   `data/price_check_report.json` or `data/products.json` — otherwise
   you're looking at a stale report.
6. **Triage the fresh report** and report back to the user as a
   before/after table (candidates / unchanged / applied / flagged /
   multiVariant / unreachable vs. the last known run):
   - `applied` — sanity-spot-check a few; these already went live.
   - `flagged` (delta >25%) — a human call per item: real price move
     (apply manually) vs. a bad read (leave it, note why).
   - `multiVariant` — ambiguous; 🟡 pick the right variant by hand or
     leave as-is. If the ambiguity can't be resolved from the report
     alone, that's 🔴 territory (re-discovering which listing is
     right) — say so rather than guessing or silently skipping it.
   - `unreachable` — **never assume "broken site" from the count
     alone.** Group by `domain` + `error` first (see step 7).
   - `outOfScope` — not actionable here; `noSourceUrl` needs intake
     work, `nonShopifyOrNonProductUrl` is future Tier B/C, neither is a
     bug in this system.
7. **If `unreachable` is above the known baseline (~4-13)**, break it
   down before concluding anything:
   ```
   python3 -I -c "
   import json, collections
   r = json.load(open('data/price_check_report.json'))
   by_domain = collections.Counter(u['domain'] for u in r['unreachable'])
   for d, c in by_domain.most_common(): print(c, d)
   for u in r['unreachable']: print(u['domain'], '-', u['error'])
   "
   ```
   A spike concentrated on a handful of domains, all `HTTP 429`/`502`/
   `503`, is the rate-limiting pattern already seen twice (see
   calibration log) — not a new outage. A spike spread across many
   unrelated domains, or a new error shape, is worth actually
   investigating.

### How it works (architecture reference)

- 🟢 `scripts/check_live_prices.py` — the checker. For each Tier-A
  candidate, hits the supplier's own free
  `https://{domain}/products/{handle}.json` endpoint (a built-in Shopify
  feature, no scraping) and compares `price`/`compare_at_price` against
  the stored price.
  - Price deltas ≤25% (`AUTO_APPLY_THRESHOLD_PCT`) auto-apply to
    `products.json`. Bigger deltas go to the report only — never
    silently overwritten.
  - Products where variants genuinely disagree on price are flagged as
    `multiVariant` (which variant matches our single stored price is a
    human call, never guessed).
  - Non-Shopify domains and products with no `sourceUrl` are Tier B/C —
    out of scope here, counted in `outOfScope`.
  - Transient fetch failures (`429`/`502`/`503`) retry with backoff,
    honoring `Retry-After` when present; other HTTP errors (404, etc.)
    raise immediately since they won't fix themselves.
- `.github/workflows/daily-price-check.yml` — runs the checker on a
  cron (`30 2 * * *` UTC = 08:00 IST) and on manual `workflow_dispatch`,
  regenerates product/brand pages if anything changed, and commits+pushes
  as `price-check-bot` only when there's an actual diff.
- `data/price_check_report.json` — latest run's output: `candidates`,
  `unchanged`, `applied[]`, `flagged[]`, `multiVariant[]`,
  `unreachable[]`, `outOfScope: {noSourceUrl, nonShopifyOrNonProductUrl}`.

### Calibration log — what's actually been tested and fixed

- **2026-10-14 — crash on `to_number()`.** `int(x)` was called directly
  on Shopify's raw decimal string (`"7999.00"`), which Python's `int()`
  can't parse — needs `float()` first. Passed a syntax check but was
  never run end-to-end before the first real CI run, which crashed
  immediately. Fixed, and — the actual lesson — **always run the full
  script locally before pushing**, not just `ast.parse()`.
- **2026-10-15 — mass false "unreachable" from HTTP 429.** First
  post-bugfix CI run reported 538 unreachable (vs. 4 locally) — looked
  like a site-availability problem but was 534/538 a flat `HTTP 429: Too
  Many Requests`, concentrated on 5 domains: `boat-lifestyle.com`,
  `coconutlife.in`, `www.portronics.com`, `www.lifelongindiaonline.com`,
  `xech.com`. Root cause: `fetch_json()` treated every `HTTPError`
  (including 429) as non-retryable, on the theory that a real HTTP
  error "won't fix itself." True for 404, false for 429 — GitHub
  Actions' shared runner IPs get rate-limited by these stores far more
  than this environment does (likely aggregate traffic from unrelated
  Actions jobs worldwide on the same IP pool, not our own request
  volume). Fixed by retrying specifically on 429/502/503, honoring
  `Retry-After` when present, capped backoff. Cut real failures from
  538 to 13 on the next run, at the cost of runtime going from ~5.5 min
  to ~15.5 min.
  - **Still not fully resolved**: 9 of those 13 were still `429` on the
    same 5 domains, exhausting all retries during the heaviest
    throttling window. Decided 2026-10-15 to leave this as-is rather
    than push retry/backoff further (diminishing returns against rising
    runtime). If it keeps recurring, the next step is a longer
    *per-domain* base delay for just these 5, not a global retry-count
    increase.
- Multi-variant flagging was initially over-aggressive (flagged ANY
  product with >1 variant, ~36% of candidates) until sampled and found
  75% had identical prices across variants (colour/size, no real price
  difference) — fixed to only flag genuine price disagreement.
- Shopify-detection false positive: checking only HTTP 200 on
  `/products.json` misidentified `www.decathlon.in` as Shopify (it
  soft-404s its SPA shell with a 200). Fixed by requiring
  `Content-Type: application/json`.
- Non-ASCII handles (™, emoji in a product slug) broke the raw request
  line — fixed with `urllib.parse.quote(handle, safe='')`.
- `www.globallinker.com` is a persistent false Tier-A match (not
  actually Shopify) and `faberindia.com` has one genuinely dead
  `sourceUrl` (404, Franke Faber coffee machine) — both always show up
  in `unreachable` and are expected, not new failures.

### Known gaps (Tier A)

- "Franke Faber FCM 0.6L SS BK Coffee Machine" has a genuinely dead
  `sourceUrl` (404 on faberindia.com) — a real data issue, not a script
  bug, still unfixed.
- See the "Known gaps" subsections under Tier B and Tier C below for
  those tiers' own open items — Tier B/C are NOT "not started" anymore
  (this line used to say that; both have shipped real work, see those
  sections).

---

## Tier B (non-Shopify `sourceUrl` — direct fetch + JSON-LD/microdata)

Two scripts, run manually so far (not on a cron except stovekraft's):

- 🟢 `scripts/check_live_prices_tier_b_stovekraft.py` — dedicated to
  stovekraft.com alone, since it's 48% of all Tier B on its own. MRP
  sits in plain server-rendered HTML (`MRP :\n<span>₹3495.00</span>`),
  a regex over a normal fetch, no JS needed. **Wired into the daily
  cron** (`.github/workflows/daily-price-check.yml`), runs for free
  alongside Tier A every day.
- 🟢 `scripts/check_live_prices_tier_b_jsonld.py` — generic, covers every
  other non-Shopify `sourceUrl` except stovekraft, for every domain
  already in `DOMAIN_MRP_PATTERNS` or confirmed reachable via plain
  fetch below — still 🟢 (zero Claude usage, no metered API) once a
  domain's pattern is known. Tries, in order:
  a per-domain MRP-preferring pattern (`DOMAIN_MRP_PATTERNS`, see the
  MRP bug below — currently decathlon.in and havells.com), then plain
  schema.org JSON-LD `offers.price`, then `AggregateOffer.lowPrice`,
  then plain HTML microdata (`itemprop="price"`, with or without a
  `<meta content="...">` attribute). **NOT wired into the cron yet** —
  run it manually (`python3 scripts/check_live_prices_tier_b_jsonld.py`
  from the repo root) when asked for a Tier B check, the same
  apply/flag/report discipline as Tier A (≤25% auto-applies, bigger
  deltas go to `data/price_check_report_tier_b_jsonld.json` only).

### The MRP-vs-sale-price bug — the single most important lesson here

Confirmed 2026-10-20 by actually running the script for real against
decathlon.in and havells.com and hand-verifying the live pages, not
just trusting that a price field parsed successfully: **a page's
`offers.price` in JSON-LD is reliably the current SALE price on both
sites, never MRP.** MRP lives in a separate, non-JSON-LD field each
site embeds in its own page state:
- decathlon.in: `a.price={sellingPrice:N,mrp:M,...}` — a client-state
  object appearing exactly once per page, unambiguously the page's own
  product (cross-sell cards use a different key shape, `priceForFront`).
- havells.com: `"pricing":{"regularPrice":M,...}` — Magento JSON;
  `regularPrice` is the MRP even when `specialPrice` is null (no active
  discount).
Both are in `DOMAIN_MRP_PATTERNS` now, checked before the generic
fallback. **Treat "a price field parsed" as insufficient evidence it's
the RIGHT field on any domain this script hasn't been hand-verified
against yet** — that's exactly the mistake that produced this bug, and
it's very plausible other domains in `MARKETPLACE_DOMAINS` have the
same split and haven't been checked.

A real symptom to watch for: when a run's "would-apply" deltas cluster
tightly around a few values (e.g. 21-24% on one run) and "would-flag"
deltas cluster around different fixed values (e.g. 29-53%), that's a
tell the site is running fixed category-wide discount tiers, i.e. the
script is reading sale depth, not real price drift — not a coincidence
worth ignoring.

### Domain reachability — plain fetch vs. Apify's browser fetch do NOT agree

Re-verified Oct 2026 with both methods, domain by domain:
- **myntra.com** — blocked by BOTH (plain curl: connection reset;
  Apify's browser fetch: served an Akamai "Site Maintenance" error
  page). Not viably scrapable right now by either route.
- **nykaa.com / nykaafashion.com** — 🟡/🔴. No JSON-LD/microdata at all
  (price is plain DOM text in hashed/data-attribute CSS classes) AND
  plain HTTP 403s. Apify's browser fetch (🟡, metered per call) gets
  through to real content, but extracting the price needs a dedicated
  CSS-attribute scraper (🔴 to build, same pattern as stovekraft's),
  and wiring Apify into the free GitHub Actions cron changes its cost
  profile from free to metered — **that's a real decision for the
  owner, not made yet** (~10 of Tommy Hilfiger's 22 products alone sit
  on these two domains).
- **luxury.tatacliq.com** — reachable via plain HTTP GET (what this
  script already does); Apify's browser fetch does WORSE here, getting
  stuck behind a reCAPTCHA Enterprise wall. BUT it has the same MRP-vs-
  sale-price split as decathlon.in/havells.com: JSON-LD `offers.price`
  is the sale price; real MRP is in a separate `"mrpPrice":{...,
  "doubleValue":M,...}` field. Found and fixed 2026-10-20 while fixing
  one specific flagged product by hand, not a planned sweep — now in
  `DOMAIN_MRP_PATTERNS` too. Verified against a real page where it
  agreed exactly (6499) with this catalog's own stored brand-poster MRP
  for the same SKU.
- **flipkart.com / croma.com** — confirmed genuinely unreachable, not a
  bot block: pure client-rendered React with zero server-rendered
  JSON-LD/microdata of any kind on every real product page tested.
- **smartprix.com** — works for a real product page, but some stored
  `sourceUrl`s on this domain are category/comparison pages
  (`/fans/price-4000_to_5000`, a `..._vs_...` comparison URL) with no
  single offer to extract — a data problem (wrong URL), not a script bug.
- **pricee.com** — needed the `AggregateOffer.lowPrice` fallback (no
  plain `offers.price`).
- **pricebefore.com, offikraft.in** (OpenCart) — need the microdata
  fallback, no `<script type="application/ld+json">` block at all.

### Marketplace markup rule

`MARKETPLACE_DOMAINS` (Myntra, Flipkart, Nykaa, Tatacliq, BigBasket,
Croma, Shakedeal, IndiaMART, PaisaWapas, PriceE, PriceBefore, Smartprix,
Pepperfry, DealsMagnet, us.smartprix.com — direct manufacturer/supplier
sites are NEVER in this set) get a flat `MARKETPLACE_MARKUP_PCT` (10%)
added to whatever live price is found, applied to `live_price` BEFORE
the delta-vs-stored comparison — a marketplace listing often undercuts
true MRP, so it can push a result from auto-apply into flagged, never
the reverse. This is the owner's explicit call, separate from the Tier
C-specific IndiaMART +15% rule below (Tier C's rule is for a *found*
price being hand-applied once, not this script's automated markup).

### Known gaps (Tier B)

- 🔴 The generic script's fix is only hand-verified for decathlon.in,
  havells.com, and luxury.tatacliq.com. The other ~190 catalog-wide
  Tier B candidates across ~30 domains (ttkprestige, wayona, marshall,
  samsonite, mi.com, puma, ferrerorocher, etc.) have NOT been checked
  for the same MRP-vs-sale split — don't assume any of them are safe to
  bulk-apply without checking by hand first. This domain-by-domain
  discovery work is exactly the 🔴 "pricey" Tier B item in the cost
  ladder above — batch it into the Saturday schedule rather than doing
  it piecemeal mid-week.
- Not wired into the daily cron — every run so far has been manual/
  on-demand, scoped to specific domains, never the full catalog-wide
  288 candidates in one go. Don't wire the FULL generic script into the
  cron until the ~190 unverified domains above have been checked —
  doing so now would risk silently auto-applying a sale price as if it
  were MRP on any domain with the same split this script hasn't found
  yet.
- 🟡/🔴 nykaa.com/nykaafashion.com need a dedicated CSS-attribute
  extractor (not built, 🔴) plus an explicit owner decision on the
  Apify cost (🟡 per-call, but changes the cron's cost profile if wired
  in permanently).

---

## Tier C (no `sourceUrl` at all — search + mandatory image verification)

Fundamentally different cost/rigor profile from A/B: there's no free
structured endpoint, so every product needs a web search, a candidate
page fetch, and — **non-negotiable, this is the whole point of the
tier** — both the stored image and the candidate's image downloaded
and actually viewed side by side (Bash `curl -sL <url> -o file.jpg`,
then the Read tool on both local files) before trusting any price. A
name/brand/model match alone is NOT enough; this has caught real wrong
matches (different color, different silhouette/cut, same model-family-
but-wrong-number) that would have silently mispriced a product.

### How to run a batch — always check 🟢 before reaching for 🔴

**🟢 Step 1, always do this first, per brand, before any search:**
check whether the stored `image` URL's domain is `cdn.shopify.com` (or
similarly tells you the brand runs its own structured store). If so,
fetch its WHOLE catalog directly (`https://<store>/products.json
?limit=250&page=N`, paginate to empty) and match locally — no search,
no subagents, no per-product cost. See the Coconut technique further
down. Any match found this way is **Tier A**, not Tier C — add the
`sourceUrl` and stop, the free daily cron takes it from there.

**🟡 Step 2**, for whatever's left after step 1: one Claude session
(not subagents) doing search + candidate fetch + mandatory image
download-and-view, product by product. Fine for a small number of
items or a quick single-product fix (e.g. re-sourcing one flagged
product).

**🔴 Step 3**, the full pilot-batch treatment — only for a real batch
(dozens of products), and **this is the Saturday-scheduled work**, not
a mid-week default. No script exists for this (it can't be scripted —
the verification step requires actually looking at images). Pattern
established across 2 pilot batches: pull a sample of Tier C products
(id, name, stored price, category, stored `image` URL) from
`data/products.json` where `sourceUrl` is empty, **excluding
`trophiesMedalsAwards` and `diwaliHampers`** (see below — these are
structurally out of scope), split across 2-3 parallel subagents
(`Agent` tool, `general-purpose`), each briefed with: the method
above, the exact product list, brand-specific hints (a known-good
direct site to search first, a known false-positive trap to avoid, a
prior finding about a related brand), and explicit instructions to
investigate/report only — never edit `products.json` or commit, the
orchestrating session applies results after reviewing every agent's
report.

### Trophies and hampers are (mostly) structurally out of scope

Confirmed by actually testing it, not assumed: `trophiesMedalsAwards`
(282 products) are overwhelmingly unpriceable this way — the catalog's
own stored images are often stock photos of *already custom-engraved*
demo trophies from unrelated stock libraries, and brand names like
"LEK Trophies" return zero search footprint; there's no live SKU to
find because these are made-to-order. `diwaliHampers` is a **mixed**
case, not fully out of scope: the underlying brands (Ruchoks, etc.) are
real and do sell individually-priced SKUs, but the catalog's generic
product names ("Diwali Gift Hamper") don't identify which SKU, so
matching fails on ambiguity, not true unpriceability — worth a future
pass if names get more specific, but not worth the cost right now.
`edible` (not a hamper category itself) is the opposite case — some of
the best hit rates so far (Loyka, specific pack sizes) came from here.

### Known failure modes, worth checking for before trusting a match

- **B2B wholesale quote-only suppliers** (Idea2cart.com confirmed,
  likely others): publish product photos/specs but deliberately
  withhold price (`"price":"0"` in their own schema, MOQ-based,
  WhatsApp-for-quote model). No amount of better searching fixes this
  — it's a different kind of dead end, not a search failure.
- **The same B2B reseller behind multiple "brands."** joytreeglobal.com
  turned up repeatedly across UCB, M&S, and Puma matches with photography
  pixel-identical to our stored catalog images — likely this catalog's
  original apparel data source. Its prices are quoted in **USD
  wholesale/quote figures**, not INR retail — do not apply those
  directly as a retail-price delta; hold for manual review (a rough
  FX conversion is not a verified retail comparison).
- **Generic-phrase false matches.** A fuzzy name-match pass against a
  brand's own bulk catalog (see the Coconut technique below) WILL
  produce false positives on generic shared phrasing — e.g. 16 unrelated
  "<Name> Office Cabinet" products all matched one single "Vault X3"
  cabinet purely on the word "Office Cabinet." Image verification is
  what catches this, not a higher similarity threshold.
- **Model-code near-misses.** "LS03 Laptop Stand" scored 0.94 similar
  to "LS02 Laptop Stand" in a fuzzy match — different SKU despite the
  high score. Always check an exact model/code match, not just name
  similarity, before accepting.
- **Brand misattribution in the catalog's own stored data** (separate
  from a wrong `sourceUrl`) — found twice: a "TTH Formal Shirt" photo
  carrying a different brand's (Harfun) trademarked tagline, and a
  Diwali hamper candle whose own stored label couldn't be confirmed as
  the brand on file. Flag for manual review per the project's
  brand-vs-competitor "stop and ask" rule — never guess which brand is
  right.
- **A brand secretly running its own Shopify store** is the single
  biggest efficiency win available: check the stored `image` URL's
  domain first — if it's `cdn.shopify.com`, the brand likely has a real
  live store. Confirmed on Coconut (`coconutlife.in`): instead of
  searching per-product, fetch the WHOLE catalog directly
  (`https://<store>/products.json?limit=250&page=N`, paginate until a
  page returns empty — 398 products across 2 pages for Coconut) and
  cross-reference locally. Still image-verify every candidate (the
  false-positive traps above apply just as much to a bulk catalog
  match as to a web search), but it's far cheaper than one search per
  product, and any resulting match belongs in **Tier A**, not Tier C —
  add the `sourceUrl` and the existing free Tier A script picks it up
  automatically (it's already domain-agnostic, matches any
  `/products/<handle>` URL, no allowlist needed).

### Pricing rule, Tier C-specific

Owner's explicit call (2026-10-20): when a found price comes from
**IndiaMART specifically**, apply a flat **+15%** markup before saving
(separate from, and not combined with, Tier B's automated +10%
`MARKETPLACE_MARKUP_PCT` rule — this is a one-time manual-apply rule
for Tier C, decided independently). Everything else found via Tier C
gets applied at face value as found. Always prefer MRP over sale price
when a site shows both separately (see the Tier B MRP bug above — the
same split shows up in Tier C sources too, e.g. Offikraft's OpenCart
`price-new`/`price-old` spans).

### Known gaps (Tier C)

- No script — every batch needs fresh agent briefings. Two pilot
  batches run so far (~75 products total), roughly a third getting a
  confirmed image-verified match with a usable price; the rest split
  between "not found," "no confident match" (correctly rejected), and
  the B2B-quote-only dead end above.
- 1,002 products total have no `sourceUrl`; only a small sample has
  been through this process. Full catalog coverage is a long way off
  and the cost-per-product here is much higher than Tier A/B — don't
  assume it'll ever be cost-effective to run exhaustively the way
  Tier A is. This is the main reason the 🔴 batch treatment is on a
  weekly Saturday schedule rather than run whenever asked.

---

## Weekly Saturday schedule for 🔴 pricey-tier work

A recurring scheduled task (`trig_011cw8syyvNTkxQFZTGUd2jx`, CRON_TZ=
Asia/Kolkata, Saturdays ~8:45 AM IST) fires into this project's Claude
session every week. Its job: check `codex-briefing.md` for what's
already been covered, then run whichever tier's 🔴 pricey-level work is
most valuable that week — another Tier C batch, a Tier B domain-
discovery pass on a few of the ~190 unverified candidates, or Tier A
rediscovery for any broken/ambiguous products accumulated that week —
with the same rigor as every prior session (never guess, image-verify
Tier C matches, flag ambiguous cases, commit+push, log to
`codex-briefing.md`). This is the intended home for 🔴 work: don't
reach for it ad hoc mid-week unless the owner explicitly asks for that
specific thing (as happened with the Monett Business Case fix, which
was 🟡-sized — one product, one fetch — not a reason to skip straight
to a 🔴 batch).
