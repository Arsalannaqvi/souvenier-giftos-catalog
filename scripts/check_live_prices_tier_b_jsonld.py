#!/usr/bin/env python3
"""Daily live price check — Tier B, generic (schema.org JSON-LD).

Covers every remaining non-Shopify sourceUrl EXCEPT stovekraft.com
(which has its own dedicated script, check_live_prices_tier_b_stovekraft.py,
since it's 48% of Tier B on its own). Confirmed by hand on real pages:
decathlon.in and havells.com embed a standard schema.org Product block
with offers.price/priceCurrency in a plain <script type=
"application/ld+json"> tag -- no JS execution needed to read it, so
this is one generic extractor instead of one script per domain.

Two more shapes are handled beyond plain Offer.price, both confirmed
hand-verified on real pages during the Oct 2026 PowerPlus/Rico/Artis/
Aquaminder/Offikraft brand sweep:
- AggregateOffer (offers.lowPrice instead of offers.price) -- seen on
  pricee.com.
- Plain schema.org microdata with no <script> block at all, either a
  <meta itemprop="price" content="..."> tag or an itemprop="price"
  attribute directly on the visible price element -- seen on
  pricebefore.com and offikraft.in (OpenCart).
What this script still can NOT extract, confirmed the same sweep:
Flipkart and Croma product pages (pure client-rendered React, zero
JSON-LD/microdata of any kind -- not a bot block, genuinely nothing
server-rendered to read), smartprix.com category/comparison pages
(as opposed to a real product page), and any page where the only
sourceUrl on file is a brand's generic storefront/category/company
page rather than a single product (BigBasket's aquaminder storefront,
IndiaMART company pages) -- those need a real per-product URL found
first (Tier C work), not an extractor fix.

Reseller/marketplace domains (the product's own brand doesn't run the
site -- Myntra, Flipkart, Nykaa, etc.) get a flat MARKETPLACE_MARKUP_PCT
added to whatever live price is found there before comparing/storing,
per the owner's explicit call: a marketplace listing price often runs
below true MRP, so pad it rather than trust it at face value. Direct
manufacturer/supplier sites are NOT marked up. Note the markup is
applied to live_price BEFORE the delta-vs-stored comparison, so it can
push a product from auto-apply into flagged (and never the reverse).

Same auto-apply/flag discipline as Tier A/stovekraft: deltas <=
AUTO_APPLY_THRESHOLD_PCT apply automatically, bigger ones are reported
but never silently overwritten.

Known limitation, re-verified Oct 2026 with real plain-curl AND
Apify-browser fetches, domain by domain -- the two methods do NOT agree
on which sites are reachable:
- myntra.com: blocked by BOTH methods (plain curl: connection reset;
  Apify's browser fetch: served an Akamai "Site Maintenance" error
  page). Not viably scrapable right now by either route.
- nykaa.com / nykaafashion.com: no JSON-LD/microdata at all (price is
  plain DOM text in hashed/data-attribute CSS classes) AND plain HTTP
  403s. Apify's browser fetch does get through to real content, but
  extracting the price would need a dedicated CSS-attribute scraper
  (same pattern as the stovekraft script), not this JSON-LD extractor
  -- and wiring Apify into the free GitHub Actions cron changes its
  cost profile, so that's deliberately not done here pending an
  explicit decision. See codex-briefing.md.
- luxury.tatacliq.com: the OPPOSITE of the above -- a plain HTTP GET
  (what this script already does) returns full server-rendered JSON-LD
  and just works; Apify's browser fetch actually does WORSE here,
  getting stuck behind a reCAPTCHA Enterprise wall. No code change
  needed, this one is already correctly handled by the plain-fetch
  approach below.
- plain tatacliq.com (non-luxury): empty React shell via both methods,
  no data to extract either way.

Run from the repo root: python3 scripts/check_live_prices_tier_b_jsonld.py
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
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PRODUCTS_PATH = DATA / "products.json"
REPORT_PATH = DATA / "price_check_report_tier_b_jsonld.json"

AUTO_APPLY_THRESHOLD_PCT = 25.0
MARKETPLACE_MARKUP_PCT = 10.0
REQUEST_TIMEOUT = 15
REQUEST_DELAY_SECONDS = 0.5
USER_AGENT = "Mozilla/5.0 (compatible; SouvenierGiftosPriceCheck/1.0)"

SHOPIFY_PRODUCT_URL_RE = re.compile(r"^https?://([^/]+)/products/([^/?#]+)")
EXCLUDED_DOMAINS = {"stovekraft.com"}  # has its own dedicated script

# Sites where the product's own brand does NOT run the storefront --
# a resale/marketplace listing, not the manufacturer's direct price.
# Everything else that has a sourceUrl is treated as a direct
# supplier/brand site (no markup).
MARKETPLACE_DOMAINS = {
    "myntra.com", "www.myntra.com",
    "flipkart.com", "www.flipkart.com",
    "nykaa.com", "www.nykaa.com",
    "nykaafashion.com", "www.nykaafashion.com",
    "tatacliq.com", "luxury.tatacliq.com", "www.tatacliq.com",
    "bigbasket.com", "www.bigbasket.com",
    "croma.com", "www.croma.com",
    "shakedeal.com", "marketplace.shakedeal.com",
    "indiamart.com", "m.indiamart.com", "www.indiamart.com",
    "paisawapas.com", "www.paisawapas.com",
    "pricee.com", "www.pricee.com",
    "pricebefore.com", "www.pricebefore.com",
    "smartprix.com", "www.smartprix.com", "us.smartprix.com",
    "pepperfry.com", "www.pepperfry.com", "ii1.pepperfry.com",
    "dealsmagnet.com", "www.dealsmagnet.com",
}

# JSON-LD can appear as a single object or an array of objects/graphs;
# this regex just finds every <script type="application/ld+json">
# block so each can be parsed on its own -- more forgiving than relying
# on one global json.loads() for the whole page.
JSONLD_BLOCK_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)

# Fallback for sites with no <script type="application/ld+json"> at all --
# confirmed on pricebefore.com and offikraft.in (OpenCart), which mark up
# price as plain schema.org microdata instead: either a <meta itemprop="price"
# content="1670.00"> tag, or an itemprop="price" attribute directly on the
# visible price element with no content attribute (offikraft.in: <span
# class="price-new" itemprop="price">₹105.00<span itemprop="availability"...).
# Captures the whole opening tag (group 1) plus whatever immediately follows
# it up to the next tag (group 2), since which one holds the price varies by
# site -- a plain content="" match on the tag text would wrongly swallow the
# attribute separator for the no-content-attribute case.
MICRODATA_PRICE_RE = re.compile(
    r'(<[^>]*\bitemprop=["\']price["\'][^>]*>)([^<]*)',
    re.IGNORECASE,
)

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


def extract_offer_price(html):
    """Return the first numeric offers.price found in any JSON-LD block
    on the page, searching nested dicts/lists (some sites wrap the
    Product in a @graph array, or offers in a list of Offer objects)."""

    def walk(node):
        if isinstance(node, dict):
            offers = node.get("offers")
            if offers is not None:
                for offer in (offers if isinstance(offers, list) else [offers]):
                    if not isinstance(offer, dict):
                        continue
                    price = offer.get("price")
                    if price in (None, ""):
                        # AggregateOffer shape (confirmed on pricee.com) has
                        # no single "price", only a lowPrice/highPrice range.
                        # Use lowPrice -- the same conservative choice the
                        # site itself leads with.
                        price = offer.get("lowPrice")
                    if price not in (None, ""):
                        return price
            for v in node.values():
                found = walk(v)
                if found is not None:
                    return found
        elif isinstance(node, list):
            for item in node:
                found = walk(item)
                if found is not None:
                    return found
        return None

    for block in JSONLD_BLOCK_RE.findall(html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        price = walk(data)
        if price is not None:
            return price

    m = MICRODATA_PRICE_RE.search(html)
    if m:
        tag, trailing = m.group(1), m.group(2)
        content_m = re.search(r'content=["\']([^"\']+)["\']', tag, re.IGNORECASE)
        raw = (content_m.group(1) if content_m else trailing).strip()
        digits = re.sub(r"[^\d.]", "", raw)
        if digits:
            return digits
    return None


def main():
    products = json.load(open(PRODUCTS_PATH))
    items = products["products"]

    candidates = []
    for p in items:
        url = p.get("sourceUrl")
        if not url:
            continue
        if SHOPIFY_PRODUCT_URL_RE.match(url):
            continue  # Tier A
        domain = urlparse(url).netloc
        if domain in EXCLUDED_DOMAINS:
            continue  # handled by the dedicated stovekraft script
        candidates.append((p, domain, url))

    print(f"Tier B (generic JSON-LD) candidates: {len(candidates)}")

    applied = []
    flagged = []
    unreachable = []
    unchanged_count = 0
    last_request_at = {}

    for p, domain, url in candidates:
        now = time.monotonic()
        wait = REQUEST_DELAY_SECONDS - (now - last_request_at.get(domain, 0))
        if wait > 0:
            time.sleep(wait)
        last_request_at[domain] = time.monotonic()

        try:
            html = fetch_html(url)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            unreachable.append({"id": p["id"], "name": p["name"], "domain": domain, "sourceUrl": url, "error": str(e)})
            continue

        raw_price = extract_offer_price(html)
        if raw_price is None:
            unreachable.append({"id": p["id"], "name": p["name"], "domain": domain, "sourceUrl": url, "error": "no JSON-LD offers.price found"})
            continue

        try:
            live_price = float(str(raw_price).replace(",", ""))
        except ValueError:
            unreachable.append({"id": p["id"], "name": p["name"], "domain": domain, "sourceUrl": url, "error": f"unparseable price {raw_price!r}"})
            continue

        is_marketplace = domain in MARKETPLACE_DOMAINS
        if is_marketplace:
            live_price = live_price * (1 + MARKETPLACE_MARKUP_PCT / 100)
        live_price = to_number(live_price)

        stored_price = p.get("price")
        record = {
            "id": p["id"], "name": p["name"], "domain": domain,
            "storedPrice": stored_price, "livePrice": live_price,
            "marketplaceMarkupApplied": is_marketplace,
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
        "tier": "B (generic JSON-LD, non-stovekraft)",
        "autoApplyThresholdPct": AUTO_APPLY_THRESHOLD_PCT,
        "marketplaceMarkupPct": MARKETPLACE_MARKUP_PCT,
        "candidates": len(candidates),
        "unchanged": unchanged_count,
        "applied": applied,
        "flagged": flagged,
        "unreachable": unreachable,
    }
    json.dump(report, open(REPORT_PATH, "w"), ensure_ascii=False, indent=2)

    print(f"Unchanged: {unchanged_count}")
    print(f"Applied: {len(applied)}")
    print(f"Flagged (needs manual review): {len(flagged)}")
    print(f"Unreachable: {len(unreachable)}")
    print(f"Report written to {REPORT_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
