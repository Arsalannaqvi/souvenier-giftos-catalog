---
name: livepriceupdate
description: Use whenever asked to check, run, or triage a live MRP/sale-price verification pass on this catalog — on demand, not just the daily cron (Tier A — Shopify-backed suppliers only). One invocation triggers the GitHub Action, waits for it, pulls the fresh report, and reports a before/after triage back in chat.
---

# Live Price Update (Tier A — Shopify)

Checks every product whose `sourceUrl` is a Shopify product page
(`.../products/<handle>`) against the live price on the supplier's own
site, and applies safe changes automatically. Runs on GitHub's own
infrastructure — **never touches Claude usage** (the explicit point of
building it this way: "I need something that can be run on low usage
limit"). This skill is for running/checking it **on demand** — it also
runs itself daily on a cron regardless of whether this skill is invoked.

## The recipe (run this whenever asked to do a live price check)

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
   - `multiVariant` — ambiguous; pick the right variant or leave as-is.
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

## How it works (architecture reference)

- `scripts/check_live_prices.py` — the checker. For each Tier-A
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

## Calibration log — what's actually been tested and fixed

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

## Known gaps (not yet built, scoped only)

- Tier B (non-Shopify, AI-assisted scraping) for the ~500 non-Shopify
  `sourceUrl` products — not started.
- Tier C for the ~1000 products with no `sourceUrl` at all — not started.
- "Franke Faber FCM 0.6L SS BK Coffee Machine" has a genuinely dead
  `sourceUrl` (404 on faberindia.com) — a real data issue, not a script
  bug, still unfixed.
