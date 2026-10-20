#!/usr/bin/env python3
"""Daily live price check — Tier A (Shopify-backed suppliers only).

For every product whose sourceUrl looks like a Shopify product page
(".../products/<handle>"), fetches that supplier's own
"<handle>.json" endpoint -- a free, structured, no-scraping Shopify
feature -- and compares the live price/compare_at_price against what's
stored in data/products.json.

- Small changes (<= AUTO_APPLY_THRESHOLD_PCT) are applied automatically.
- Bigger changes are left untouched and written to the report instead,
  so a scraper fluke or a supplier's own error can't silently reprice
  something on the live site.
- Products with more than one variant are ambiguous (which variant is
  "the" stored price?) and are always flagged, never auto-applied.
- Non-Shopify domains, and products with no sourceUrl, are Tier B/C --
  out of scope here; see data/price_check_report.json's "outOfScope"
  counts.

Run from the repo root: python3 scripts/check_live_prices.py
Exits 0 always; the caller (CI) decides what to do with any diff.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import escalation_queue

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PRODUCTS_PATH = DATA / "products.json"
REPORT_PATH = DATA / "price_check_report.json"

AUTO_APPLY_THRESHOLD_PCT = 25.0
REQUEST_TIMEOUT = 12
REQUEST_DELAY_SECONDS = 0.25  # politeness delay between requests to the same supplier
USER_AGENT = "Mozilla/5.0 (compatible; SouvenierGiftosPriceCheck/1.0)"

SHOPIFY_PRODUCT_URL_RE = re.compile(r"^https?://([^/]+)/products/([^/?#]+)")


def to_number(x):
    """Shopify prices are decimal strings ("449.00"); the site's stored
    prices are ints. Collapse whole-number floats back to int so pages
    don't render "₹449.0" instead of "₹449"."""
    if x is None:
        return None
    f = float(x)
    return int(f) if f.is_integer() else f


# 429/502/503 are transient -- worth retrying with backoff. Other HTTP
# errors (404, etc.) are real and won't fix themselves, so raise
# immediately. Confirmed 2026-10-15: GitHub Actions' shared runner IPs get
# rate-limited (429) by some Shopify stores (boat-lifestyle.com,
# coconutlife.in, portronics.com, lifelongindiaonline.com, xech.com) far
# more than this environment ever did -- likely aggregate traffic from
# unrelated Actions jobs worldwide sharing the same IP pool, not our own
# request volume. Same run also hit a one-off 502 on temptindia.com.
RETRYABLE_HTTP_STATUS = {429, 502, 503}


def fetch_json(url, retries=3):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    last_err = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                ctype = resp.headers.get("Content-Type", "")
                if "application/json" not in ctype:
                    raise ValueError(f"not JSON (content-type={ctype})")
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code not in RETRYABLE_HTTP_STATUS or attempt >= retries:
                raise
            retry_after = e.headers.get("Retry-After") if e.headers else None
            try:
                delay = float(retry_after)
            except (TypeError, ValueError):
                delay = 2.0 * (attempt + 1)
            last_err = e
            time.sleep(min(delay, 15.0))
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last_err


def main():
    products = json.load(open(PRODUCTS_PATH))
    items = products["products"]

    candidates = []  # (product, domain, handle)
    out_of_scope_no_url = 0
    for p in items:
        url = p.get("sourceUrl")
        if not url:
            out_of_scope_no_url += 1
            continue
        m = SHOPIFY_PRODUCT_URL_RE.match(url)
        if not m:
            continue  # not a /products/<handle> URL shape -- Tier B candidate, skip
        domain, handle = m.group(1), m.group(2)
        candidates.append((p, domain, handle))

    print(f"Candidates with a /products/<handle> sourceUrl: {len(candidates)}")
    print(f"Products with no sourceUrl at all (out of scope): {out_of_scope_no_url}")

    applied = []
    flagged = []
    multi_variant = []
    unreachable = []
    unchanged_count = 0
    last_request_at = {}

    for p, domain, handle in candidates:
        # Be polite: small delay between consecutive requests to the same domain.
        now = time.monotonic()
        wait = REQUEST_DELAY_SECONDS - (now - last_request_at.get(domain, 0))
        if wait > 0:
            time.sleep(wait)
        last_request_at[domain] = time.monotonic()

        json_url = f"https://{domain}/products/{quote(handle, safe='')}.json"
        try:
            data = fetch_json(json_url)
        except (urllib.error.HTTPError, urllib.error.URLError, ValueError, TimeoutError, json.JSONDecodeError) as e:
            unreachable.append({"id": p["id"], "name": p["name"], "domain": domain, "error": str(e)})
            continue

        product = data.get("product") or {}
        variants = product.get("variants") or []
        if not variants:
            unreachable.append({"id": p["id"], "name": p["name"], "domain": domain, "error": "no variants in response"})
            continue

        try:
            variant_prices = {float(v["price"]) for v in variants}
        except (KeyError, TypeError, ValueError):
            unreachable.append({"id": p["id"], "name": p["name"], "domain": domain, "error": "variant price missing/invalid"})
            continue

        if len(variant_prices) > 1:
            # Variants genuinely differ in price (e.g. size-based pricing) --
            # which one matches our single stored price is ambiguous, so
            # this needs a human to pick rather than a silent guess.
            multi_variant.append({
                "id": p["id"], "name": p["name"], "domain": domain,
                "variantCount": len(variants),
                "variantPrices": [to_number(v) for v in sorted(variant_prices)],
                "sourceUrl": p.get("sourceUrl"),
            })
            continue

        # Every variant (colour/size/etc.) shares the same price, so there's
        # no real ambiguity -- treat it like a single-variant product.
        live_price = variant_prices.pop()
        compare_ats = {v.get("compare_at_price") for v in variants if v.get("compare_at_price")}
        live_mrp = to_number(sorted(compare_ats)[0]) if compare_ats else None

        stored_price = p.get("price")
        record = {
            "id": p["id"], "name": p["name"], "domain": domain,
            "storedPrice": stored_price, "livePrice": to_number(live_price), "liveMrp": live_mrp,
            "sourceUrl": p.get("sourceUrl"),
        }

        if stored_price is None:
            p["price"] = to_number(live_price)
            record["action"] = "applied (no prior stored price)"
            applied.append(record)
            continue

        if stored_price == live_price:
            unchanged_count += 1
            continue

        delta_pct = abs(live_price - stored_price) / stored_price * 100 if stored_price else 100.0
        record["deltaPct"] = round(delta_pct, 1)

        if delta_pct <= AUTO_APPLY_THRESHOLD_PCT:
            p["price"] = to_number(live_price)
            record["action"] = "applied"
            applied.append(record)
        else:
            record["action"] = "flagged (exceeds threshold, not applied)"
            flagged.append(record)

    if applied:
        json.dump(products, open(PRODUCTS_PATH, "w"), ensure_ascii=False, indent=2)
        print(f"Applied {len(applied)} price updates to {PRODUCTS_PATH.name}")
    else:
        print("No price updates applied.")

    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "tier": "A (Shopify products.json endpoint)",
        "autoApplyThresholdPct": AUTO_APPLY_THRESHOLD_PCT,
        "candidates": len(candidates),
        "unchanged": unchanged_count,
        "applied": applied,
        "flagged": flagged,
        "multiVariant": multi_variant,
        "unreachable": unreachable,
        "outOfScope": {
            "noSourceUrl": out_of_scope_no_url,
            "nonShopifyOrNonProductUrl": len(items) - len(candidates) - out_of_scope_no_url,
        },
    }
    json.dump(report, open(REPORT_PATH, "w"), ensure_ascii=False, indent=2)

    # Cost-ladder escalation queue (see scripts/escalation_queue.py):
    # anything this free/🟢 pass couldn't resolve enters (or stays in)
    # the queue at 🟡, so it isn't forgotten the moment tomorrow's report
    # overwrites this one. Anything that WAS stuck but is resolved now
    # (applied/unchanged today) drops out of the queue.
    unresolved = flagged + multi_variant + unreachable
    unresolved_ids = {u["id"] for u in unresolved}
    checked_ids = {p["id"] for p, _, _ in candidates}
    escalation_queue.sync_unresolved("A", "tier_a_shopify", unresolved)
    escalation_queue.sync_resolved("tier_a_shopify", checked_ids, unresolved_ids)

    print(f"Unchanged: {unchanged_count}")
    print(f"Applied: {len(applied)}")
    print(f"Flagged (needs manual review): {len(flagged)}")
    print(f"Multi-variant (ambiguous, skipped): {len(multi_variant)}")
    print(f"Unreachable: {len(unreachable)}")
    print(f"Report written to {REPORT_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
