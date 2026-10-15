---
name: livepriceupdate
description: Use when checking, triggering, or triaging the daily live MRP/sale-price verification system for this catalog (Tier A — Shopify-backed suppliers only). Covers how the system runs, how to trigger or inspect a run manually, how to read data/price_check_report.json, and the calibration log of what's actually broken and been fixed.
---

# Live Price Update (Tier A — Shopify)

Daily automated check of every product whose `sourceUrl` is a Shopify
product page (`.../products/<handle>`), comparing the live price against
what's stored in `data/products.json`. Runs entirely on GitHub's own
infrastructure — **never touches Claude usage** (this was the explicit
point of building it this way: "I need something that can be run on low
usage limit").

## How it works

- `scripts/check_live_prices.py` — the checker. For each Tier-A candidate,
  hits the supplier's own free `https://{domain}/products/{handle}.json`
  endpoint (a built-in Shopify feature, no scraping) and compares
  `price`/`compare_at_price` against the stored price.
  - Price deltas ≤25% (`AUTO_APPLY_THRESHOLD_PCT`) auto-apply to
    `products.json`. Bigger deltas are written to the report only — never
    silently overwritten.
  - Products where variants genuinely disagree on price are flagged as
    `multiVariant` (ambiguous — which variant matches our single stored
    price is a human call, never guessed).
  - Non-Shopify domains and products with no `sourceUrl` are Tier B/C —
    out of scope here, counted in `outOfScope`.
- `.github/workflows/daily-price-check.yml` — runs the checker on a cron
  (`30 2 * * *` UTC = 08:00 IST) and on manual `workflow_dispatch`,
  regenerates product/brand pages if anything changed, and commits+pushes
  as `price-check-bot` only when there's an actual diff.
- `data/price_check_report.json` — the output of the latest run:
  `candidates`, `unchanged`, `applied[]`, `flagged[]`, `multiVariant[]`,
  `unreachable[]`, `outOfScope: {noSourceUrl, nonShopifyOrNonProductUrl}`.

## Triggering / inspecting a run manually

Use the GitHub MCP Actions tools against
`Arsalannaqvi/souvenier-giftos-catalog`, workflow file
`daily-price-check.yml`:
- Trigger: `mcp__github__actions_run_trigger` → `run_workflow`, `ref: "main"`.
- Poll: `mcp__github__actions_list` → `list_workflow_runs` (filter by the
  workflow file), then `mcp__github__actions_get` → `get_workflow_run`
  until `status: "completed"`.
- On failure: `mcp__github__get_job_logs` with `failed_only: true,
  return_content: true` to get the real traceback/output without
  downloading a log zip — don't guess at the cause, read it.
- After any run that changed `data/products.json`, `git pull` locally
  before reading `price_check_report.json` fresh.

## Triage checklist after a run

1. **`applied`** — sanity-spot-check a few; these already went live.
2. **`flagged`** — delta >25%. Decide per item whether it's a real price
   move (apply manually) or a bad read (leave it, note why).
3. **`multiVariant`** — pick which variant price is "the" product price,
   or leave as-is if genuinely ambiguous.
4. **`unreachable`** — don't assume "broken site." Check the `error`
   field first: group by domain + error code before concluding anything
   (see calibration log below — this is where real bugs have hidden).
5. **`outOfScope`** — not actionable by this system. `noSourceUrl` needs
   intake work; `nonShopifyOrNonProductUrl` is a future Tier B/C
   candidate, not a bug.

## Calibration log — what's actually been tested and fixed

- **2026-10-14 — crash on `to_number()`.** `int(x)` was called directly on
  Shopify's raw decimal string (`"7999.00"`), which Python's `int()`
  can't parse — needs `float()` first. Passed a syntax check but was
  never run end-to-end before the first real CI run, which crashed
  immediately. Fixed, and — the actual lesson — **always run the full
  script locally before pushing**, not just `ast.parse()`.
- **2026-10-15 — mass false "unreachable" from HTTP 429.** First
  post-fix CI run reported 538 unreachable (vs. 4 locally) — looked like
  a site-availability problem but was 534/538 a flat `HTTP 429: Too Many
  Requests`, concentrated on 5 domains: `boat-lifestyle.com`,
  `coconutlife.in`, `www.portronics.com`, `www.lifelongindiaonline.com`,
  `xech.com`. Root cause: `fetch_json()` treated every `HTTPError`
  (including 429) as non-retryable, on the theory that a real HTTP error
  "won't fix itself." True for 404, false for 429 — and GitHub Actions'
  shared runner IPs get rate-limited by these stores far more than this
  environment does (likely aggregate traffic from unrelated Actions jobs
  worldwide on the same IP pool, not our own request volume). Fixed by
  retrying specifically on 429/502/503, honoring the `Retry-After` header
  when present, capped backoff. **Don't assume "unreachable" means a
  dead link — always break it down by domain + error code first.**
  Cut real failures from 538 to 13 on the next CI run, at the cost of
  runtime going from ~5.5 min to ~15.5 min.
  - **Still not fully resolved**: 9 of those 13 were still `429` (under
    500 — a client-side rate limit, not a server error like 502/503) on
    the same 5 domains, which exhausted all retries during the heaviest
    throttling window: `www.portronics.com` (3), `boat-lifestyle.com`
    (2), `xech.com` (2), `www.lifelongindiaonline.com` (1),
    `coconutlife.in` (1). Decided 2026-10-15 to leave this as-is for now
    rather than push retry/backoff further (diminishing returns against
    rising runtime) — these 5 specifically throttle GitHub's shared
    runner IPs harder than the rest of the Tier-A domain set. If this
    keeps recurring on future runs, the next step is a longer
    *per-domain* base delay for just these 5 (not a global retry-count
    increase), since the problem is sustained throttling on these
    domains specifically, not one-off transient errors.
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

## Known gaps (not yet built, scoped only)

- Tier B (non-Shopify, AI-assisted scraping) for the ~500 non-Shopify
  `sourceUrl` products — not started.
- Tier C for the ~1000 products with no `sourceUrl` at all — not started.
- "Franke Faber FCM 0.6L SS BK Coffee Machine" has a genuinely dead
  `sourceUrl` (404 on faberindia.com) — a real data issue, not a script
  bug, still unfixed.
