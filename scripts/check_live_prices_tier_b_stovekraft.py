#!/usr/bin/env python3
"""Daily live price check — Tier B, stovekraft.com only.

stovekraft.com (Pigeon/Gilma brands) isn't Shopify, so it has no free
JSON endpoint like Tier A -- but its product pages render the MRP as
plain server-side HTML (confirmed by fetching a live page: no JS
execution needed), e.g.:

    MRP :
    <span class="text-red-600">₹3495.00</span>

That makes a plain HTML fetch + regex just as cheap as Tier A: no
scraping library, no AI, no browser. This is the single biggest Tier-B
domain (269 of 557 non-Shopify-sourceUrl products, ~48%), so it gets
its own dedicated script rather than a generic multi-domain Tier B
framework -- see codex-briefing.md for why the rest of Tier B (smaller
domains + marketplaces) is handled differently.

Same auto-apply/flag discipline as Tier A (scripts/check_live_prices.py):
deltas <= AUTO_APPLY_THRESHOLD_PCT apply automatically, bigger ones are
reported but never silently overwritten.

Run from the repo root: python3 scripts/check_live_prices_tier_b_stovekraft.py
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

import escalation_queue

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PRODUCTS_PATH = DATA / "products.json"
REPORT_PATH = DATA / "price_check_report_tier_b_stovekraft.json"

AUTO_APPLY_THRESHOLD_PCT = 25.0
REQUEST_TIMEOUT = 15
REQUEST_DELAY_SECONDS = 0.5  # politeness delay between requests to the same supplier
USER_AGENT = "Mozilla/5.0 (compatible; SouvenierGiftosPriceCheck/1.0)"
DOMAIN = "stovekraft.com"

# "MRP :" followed (possibly across a span/markup boundary) by a rupee
# amount, e.g. `MRP :\n<span class="text-red-600">₹3495.00</span>`.
# Non-greedy .{0,80} bridges the markup between the label and the
# number without accidentally matching across to a different product's
# price if the label text changes slightly between page templates.
MRP_RE = re.compile(r"MRP\s*:.{0,80}?₹\s*([\d,]+(?:\.\d+)?)", re.DOTALL)

RETRYABLE_HTTP_STATUS = {429, 502, 503}


def to_number(x):
    f = float(x)
    return int(f) if f.is_integer() else f


def fetch_html(url, retries=2):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    last_err = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read().decode("utf-8", errors="replace")
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

    candidates = [p for p in items if (p.get("sourceUrl") or "").find(f"//{DOMAIN}/") != -1]
    print(f"stovekraft.com candidates: {len(candidates)}")

    applied = []
    flagged = []
    unreachable = []
    unchanged_count = 0

    for p in candidates:
        time.sleep(REQUEST_DELAY_SECONDS)
        url = p["sourceUrl"]
        try:
            html = fetch_html(url)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            unreachable.append({"id": p["id"], "name": p["name"], "sourceUrl": url, "error": str(e)})
            continue

        m = MRP_RE.search(html)
        if not m:
            unreachable.append({"id": p["id"], "name": p["name"], "sourceUrl": url, "error": "MRP pattern not found on page"})
            continue

        try:
            live_price = to_number(m.group(1).replace(",", ""))
        except ValueError:
            unreachable.append({"id": p["id"], "name": p["name"], "sourceUrl": url, "error": f"unparseable MRP text {m.group(1)!r}"})
            continue

        stored_price = p.get("price")
        record = {
            "id": p["id"], "name": p["name"], "domain": DOMAIN,
            "storedPrice": stored_price, "livePrice": live_price,
            "sourceUrl": url,
        }

        if stored_price is None:
            p["price"] = live_price
            record["action"] = "applied (no prior stored price)"
            applied.append(record)
            continue

        if stored_price == live_price:
            unchanged_count += 1
            continue

        delta_pct = abs(live_price - stored_price) / stored_price * 100 if stored_price else 100.0
        record["deltaPct"] = round(delta_pct, 1)

        if delta_pct <= AUTO_APPLY_THRESHOLD_PCT:
            p["price"] = live_price
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
        "tier": "B (stovekraft.com, regex over plain HTML)",
        "autoApplyThresholdPct": AUTO_APPLY_THRESHOLD_PCT,
        "candidates": len(candidates),
        "unchanged": unchanged_count,
        "applied": applied,
        "flagged": flagged,
        "unreachable": unreachable,
    }
    json.dump(report, open(REPORT_PATH, "w"), ensure_ascii=False, indent=2)

    unresolved = flagged + unreachable
    unresolved_ids = {u["id"] for u in unresolved}
    checked_ids = {p["id"] for p in candidates}
    escalation_queue.sync_unresolved("B", "tier_b_stovekraft", unresolved)
    escalation_queue.sync_resolved("tier_b_stovekraft", checked_ids, unresolved_ids)

    print(f"Unchanged: {unchanged_count}")
    print(f"Applied: {len(applied)}")
    print(f"Flagged (needs manual review): {len(flagged)}")
    print(f"Unreachable: {len(unreachable)}")
    print(f"Report written to {REPORT_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
