#!/usr/bin/env python3
"""Daily live price check — Tier B, generic (schema.org JSON-LD).

Covers every remaining non-Shopify sourceUrl EXCEPT stovekraft.com
(which has its own dedicated script, check_live_prices_tier_b_stovekraft.py,
since it's 48% of Tier B on its own). decathlon.in and havells.com embed
a standard schema.org Product block with offers.price/priceCurrency in
a plain <script type="application/ld+json"> tag -- no JS execution
needed to read it, so this is one generic extractor instead of one
script per domain. **IMPORTANT, found and fixed Oct 2026 by actually
running this script for real and hand-verifying its output on live
pages, not just trusting that it parsed something**: that offers.price
field is reliably the current SALE price on both domains, never MRP,
which breaks this project's "stored price tracks live MRP" rule outright
-- the 25%-threshold auto-apply logic was about to silently bake a
site's current discount depth into the catalog as if it were a real MRP
update. Real MRP lives in a separate, non-JSON-LD field on each site
(see DOMAIN_MRP_PATTERNS below), which this script now prefers whenever
a per-domain pattern exists, falling back to the generic extractor only
when it doesn't. This same risk applies to every other domain this
script reaches: "a price field parsed successfully" is NOT sufficient
evidence it's the RIGHT price field -- hand-verify MRP vs. sale price
specifically before trusting a new domain, the same discipline that
caught this bug in the first place.

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
import http.client
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import escalation_queue

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

# Per-domain MRP extractors. CONFIRMED BUG (Oct 2026): decathlon.in and
# havells.com both expose a clean, parseable JSON-LD offers.price -- but
# that field is reliably the current SALE price on both, never MRP, which
# directly breaks this project's "stored price tracks live MRP" rule. Real
# MRP lives in a separate, non-JSON-LD field each site embeds in its own
# page state, hand-verified against several live product pages before
# trusting either pattern:
# - decathlon.in: a client-state object `a.price={sellingPrice:N,mrp:M,...}`
#   appears exactly once per page and is unambiguously the page's own
#   product (not a cross-sell/related-product card, which use a different
#   key, `priceForFront`/nested `price:{...}` inside a product-list array).
# - havells.com: a Magento-style JSON blob `"pricing":{"regularPrice":M,...}`
#   appears exactly once per page; regularPrice is the MRP even when
#   specialPrice is null (no active discount).
# - luxury.tatacliq.com: found the same way, by hand, fixing one specific
#   flagged product (bagsLuggageTravel-163) rather than a planned sweep --
#   `"mrpPrice":{...,"doubleValue":M,...}` appears once per page; confirmed
#   against a live page where it agreed exactly (6499) with this catalog's
#   own stored brand-poster MRP for the same SKU, independent of the
#   JSON-LD offers.price (3249, the sale price).
# Only use these on the domain they were verified against -- do NOT assume
# any other domain in MARKETPLACE_DOMAINS or elsewhere has the same split
# without checking by hand first (that's exactly the mistake this fixes).
DOMAIN_MRP_PATTERNS = {
    "decathlon.in": re.compile(r"a\.price=\{sellingPrice:\d+,mrp:(\d+)"),
    "www.decathlon.in": re.compile(r"a\.price=\{sellingPrice:\d+,mrp:(\d+)"),
    "havells.com": re.compile(r'"pricing":\{"regularPrice":(\d+(?:\.\d+)?)'),
    "www.havells.com": re.compile(r'"pricing":\{"regularPrice":(\d+(?:\.\d+)?)'),
    "luxury.tatacliq.com": re.compile(r'"mrpPrice":\{[^}]*?"doubleValue":(\d+(?:\.\d+)?)'),
    # offikraft.in (OpenCart, 109 products -- by far the largest single Tier B
    # domain): same bug shape as decathlon.in/havells.com, confirmed by hand
    # 2026-10-30 on 2 live pages (product_id=175 and =71). The page has TWO
    # price spans -- <span class="price-old">₹1,999.00</span> (the real MRP)
    # and <span class="price-new" itemprop="price">₹1,399.00 (the discounted
    # selling price) -- and it's price-new, not price-old, that carries the
    # itemprop="price" microdata tag the generic MICRODATA_PRICE_RE fallback
    # looks for. Without this pattern, every offikraft.in product would have
    # silently tracked its sale price as if it were MRP. Confirmed against
    # this catalog's own stored price for computerAccessories-1 (Offikraft
    # Caspian Executive Bag): stored 1999 matches price-old, not price-new's
    # 1399.
    # IMPORTANT: must anchor to the price-old immediately followed by the
    # itemprop="price" span, not a bare "price-old" class search -- a first
    # attempt at this pattern matched a cross-sell/related-product widget's
    # price-old instead of the main product's (449.00 instead of 1999.00 on
    # the same page), the exact "not the page's own product" trap this
    # project's own decathlon.in/havells.com notes above already warn about.
    # The adjacent-pair anchor is unique to the real schema.org Offer block;
    # cross-sell widgets on this theme carry no itemprop="price" markup.
    # If a product has no active discount, price-old is presumably absent
    # and this pattern won't match -- falls through to the generic
    # extractor, which then correctly reads the single itemprop="price"
    # value (not a bug in that case, since there's only one real price).
    "offikraft.in": re.compile(r'class="price-old">₹([\d,]+\.\d{2})</span>\s*<span class="price-new" itemprop="price"'),
    "www.offikraft.in": re.compile(r'class="price-old">₹([\d,]+\.\d{2})</span>\s*<span class="price-new" itemprop="price"'),
    # wayona.in (WooCommerce, 17 products): different shape again, confirmed
    # by hand 2026-10-30 -- the top-level offer.price (what extract_offer_price
    # would read) is the current/sale price; the real MRP sits inside a
    # nested priceSpecification entry explicitly tagged
    # "priceType":"https://schema.org/ListPrice" -- an unambiguous schema.org
    # semantic marker, not a CSS-class heuristic like offikraft.in's. Example
    # (personalAccessories-4): top-level price "499.00", ListPrice-tagged
    # entry "1499.00". This catalog's own stored price (513) is close to the
    # SALE price, not the ListPrice -- meaning this product's record has
    # likely been tracking the wrong field already; the resulting ~192%
    # delta is well above the 25% auto-apply threshold, so it's reported for
    # manual review, not auto-applied, same as any large delta.
    "wayona.in": re.compile(r'"price":"([\d.]+)"[^{}]*"priceType":"https://schema\.org/ListPrice"'),
    "www.wayona.in": re.compile(r'"price":"([\d.]+)"[^{}]*"priceType":"https://schema\.org/ListPrice"'),
    # www.indiaorbit.in (Next.js headless storefront, 16 products): TRIED
    # and REJECTED 2026-10-30, not fixed. No JSON-LD/microdata at all, but
    # the __NEXT_DATA__ script tag embeds real props with an unambiguous
    # "mrp" key (confirmed against this catalog's own stored price for
    # homeAppliances-27: stored 1290 matches mrp, not sellingPrice 799).
    # A "first mrp occurrence in the HTML" regex worked on the one sample
    # page tested, but failed on a full 16-product run: 6 of 16 products
    # returned the exact same value (7300) -- a featured/cross-sell
    # product's mrp, not the page's own product, confirming the
    # featured-products block isn't consistently positioned after the
    # main product's data across pages. This needs real JSON parsing of
    # __NEXT_DATA__ down to props.pageProps.catalog.variantsDetails[0]
    # .variantAttributes.price.mrp specifically, not a regex -- not built
    # here. Do not add a domain entry for this until that's done; the
    # generic extractor correctly falls through to "no price found"
    # (reported as unreachable) in the meantime, which is safe.

    # --- Hand-verified 2026-10-31, domain-discovery sweep of the yellow
    # escalation queue's remaining "no JSON-LD offers.price found" domains ---

    # www.skullcandy.in (12 products): no JSON-LD/microdata at all, but a
    # consistent server-rendered `<div class="sp-price">` block. Confirmed by
    # hand on two live pages: electronics-805 (crusher-evo-wireless-headphone,
    # no active discount) renders ONE price
    # (`<span><i class="fa fa-rupee"></i>19999</span>`), which exactly matches
    # this catalog's stored price (19999) -- group 1 below. push-play-active
    # (NOT one of this catalog's listed examples, checked only to see a
    # discounted page) renders a SECOND, later number wrapped in `<s>...</s>`
    # (strikethrough) -- `<span>4999</span><s>7999</s><span
    # class="discount">(38% OFF)</span>` -- and that strikethrough number,
    # not the plain span, is the real MRP -- group 2 below, only present when
    # a discount is active. IMPORTANT: the page's own `<div class="mrp-tx">
    # <span>MRP(Inclusive of all taxes)</span></div>` directly below sp-price
    # is generic legal boilerplate that renders unconditionally regardless of
    # which number (sale or MRP) sp-price is currently showing -- do NOT treat
    # that text as proof the group-1 span is specifically "the MRP one"; it
    # is only true by coincidence when no discount is active. Only one
    # `sp-price` div exists per page (confirmed, not a cross-sell trap).
    "www.skullcandy.in": re.compile(
        r'<div class="sp-price"><span>.*?(\d[\d,]*\.?\d*)</span>(?:<s>.*?(\d[\d,]*\.?\d*)</s>)?'
    ),

    # powerpl.us / www.powerpl.us (7 products, WordPress WPSSO plugin): HAS a
    # `<script type="application/ld+json">` Product block with a real
    # `offers` object -- but that Offer carries NO top-level `price` field at
    # all, only a `priceSpecification` array
    # (`[{"@type":"UnitPriceSpecification","price":"829.00",...}]`), which is
    # exactly why the generic `extract_offer_price()` walker (which only
    # checks `offer.price` / `offer.lowPrice`) reports "no JSON-LD offers.price
    # found" despite there being real, valid JSON-LD on the page. Confirmed by
    # hand on two live pages: drinkware-115 (829 -> 829.00) and drinkware-117
    # (1789 -> 1789.00), both exact matches to this catalog's own stored
    # price, and both pages have exactly one `priceSpecification` occurrence
    # (no cross-sell block uses this shape here) with no `<del>`/`<ins>`
    # WooCommerce discount markup present -- there's no separate sale price
    # to confuse this with on any page checked.
    "powerpl.us": re.compile(r'"priceSpecification":\s*\[\s*\{[^}]*?"price":\s*"(\d+(?:\.\d+)?)"'),
    "www.powerpl.us": re.compile(r'"priceSpecification":\s*\[\s*\{[^}]*?"price":\s*"(\d+(?:\.\d+)?)"'),

    # www.dealsmagnet.com (2 products, already in MARKETPLACE_DOMAINS -- this
    # only fixes extraction, the +10% markup still applies on top as normal):
    # no JSON-LD Product/Offer block at all (its one `<script
    # type="application/ld+json">` is just sitewide WebSite/Organization
    # schema), but the page's own deal-description prose spells MRP out in
    # plain English and labels it explicitly: "...available online in India
    # at an offer price of ₹254 (70% discount from MRP) on Croma.
    # Discounted Price: ₹254. MRP: 845. Savings: ₹591." Confirmed by
    # hand on two live pages: electronics-219 ("MRP: 845", vs. stored 667 --
    # a real ~27% delta, above the 25% auto-apply threshold, so this will be
    # FLAGGED not auto-applied, which is correct -- a genuine price move or
    # bad original intake, a human call, not an extraction bug) and
    # homeKitchenAppliances-593 ("MRP: 2299" vs. stored 370, an even larger
    # delta, same "flagged not applied" outcome). The literal digits-required
    # `[\d,]+` in the pattern is deliberate -- some unrelated page sections
    # also emit a bare "MRP: " with no number (a template placeholder for
    # other deal cards on the same page); requiring at least one digit skips
    # those automatically rather than matching the first (empty) occurrence.
    "www.dealsmagnet.com": re.compile(r"MRP:\s*([\d,]+)"),

    # www.dailyobjects.com (1 product): no JSON-LD Product/Offer (its one
    # `<script type="application/ld+json">` is just a BreadcrumbList), but an
    # embedded page-state JS object explicitly tags both numbers:
    # `"price":{"text":"₹3499"},"mrp":{"text":"₹6093",...}`, next to
    # `"priceDescription":{"text":"MRP Inclusive of all taxes"}` -- an
    # unambiguous "mrp" key, not a CSS-class guess. Confirmed against
    # bagsLuggageTravel-299 (stored 6093, matches "mrp" exactly, not "price"
    # 3499). CAUTION, confirmed by hand: this exact page also renders several
    # OTHER products' "mrp" fields later in the same script block (a
    # "recommended for you" carousel) -- e.g. this page also has "mrp":
    # 1405/1499/1874/1999/2499/999 blocks further down. The pattern below
    # relies on `.search()` returning the FIRST match, and confirmed (by
    # checking each match's byte offset) that the page's own product is
    # always the first "mrp" key to appear, immediately preceded by a
    # "subtitle" matching the URL's own product-id slug -- the carousel's
    # entries all come later in the document. Only verified on this one
    # product/page; if a future dailyobjects.com product ever turns up with
    # the wrong number, re-check this ordering assumption before trusting it
    # blindly on a new product.
    "www.dailyobjects.com": re.compile(r'"mrp":\{"text":"₹([\d,]+)"'),

    # www.amazon.ae (1 product, apparel-37): unlike www.amazon.in (see "Known
    # gaps" below -- blocked outright, both plain fetch AND one Apify
    # rag-web-browser attempt served the same "click the button below to
    # continue shopping" bot-block page), a plain fetch of this specific
    # amazon.ae product page was NOT blocked and returned the real,
    # full product page (no JSON-LD on it, but Amazon's own embedded pricing
    # JSON is). `"priceAmount":86.00` appears exactly once on the page
    # (the "priceToPay" price block), and no separate "basisPrice"/List-Price
    # markup renders on this page (no active discount), so this is the full
    # price, not a sale price hidden alongside a bigger MRP. CAUTION: this
    # catalog's own stored price for apparel-37 is 604 -- not a plausible
    # AED-to-INR conversion of 86 at any real-world rate (604/86 =~ 7.02,
    # while the real AED->INR rate is roughly 22-23). Checked
    # product-price-log.json's existing Tier C entry for this product
    # BEFORE assuming that's a new currency bug: 604 was never derived from
    # this amazon.ae listing at all -- this exact listing was "Currently
    # unavailable" during the original Tier C pilot (2026-10-20), so 604
    # came from a same-SKU-family amazon.in sponsored ad in a different
    # size instead. The two numbers were never expected to reconcile; this
    # is a pre-existing "which size/source is the right one" open question
    # from that Tier C entry, not a new extraction bug. Logged as an
    # updated recheck-online event rather than silently reconciled; this
    # delta will also show up FLAGGED in this script's own report, which is
    # the correct, safe outcome either way. Amazon's own bot-defense is
    # known to be inconsistent run-to-run (see the amazon.in note below) --
    # a future run hitting this same product could still get blocked even
    # though this one didn't; that's expected, not a regression.
    "www.amazon.ae": re.compile(r'"priceAmount":([\d.]+)'),

    # www.mi.com AND store.mi.com (8 products combined): TRIED and REJECTED
    # 2026-10-31. Both domains serve the EXACT same generic React/Redux SPA
    # shell regardless of item ID in the URL -- confirmed on
    # bagsLuggageTravel-377 (mi.com/in/item/3201100017/) and electronics-818
    # (store.mi.com/in/item/3194500001): both responses carry an identical,
    # item-agnostic `window.__PRELOADED_STATE__` (`"pagedata":{...,
    # "product_list":null,"group_list":null,"data":null}`, generic title
    # "Item - Mi Xiaomi India", canonical/og:url collapsed to the bare
    # "https://www.mi.com/in/item/" with no id). The real per-product data is
    # fetched client-side via an API call after JS executes -- there is
    # nothing server-rendered to regex, not even an obfuscated one. Needs a
    # genuine browser-rendered fetch (Apify) to get real data, which this
    # per-domain sweep intentionally did not spend on a non-Amazon domain
    # (see task method: only Amazon gets an Apify attempt at this cost tier).
    # Do not add a domain entry until that's actually tried and verified.

    # www.ferrerorocher.com (6 products): TRIED and REJECTED 2026-10-31. This
    # is Ferrero's own brand/marketing site, not a retailer -- confirmed on
    # edible-49 (pack-32-pieces): its only JSON-LD is a BreadcrumbList plus an
    # unrelated Recipe schema (a cupcake recipe using the product as an
    # ingredient), and there is no currency symbol, no "price"/"MRP" text,
    # and no `itemprop="price"` anywhere on the page at all -- just a generic
    # "Buy Now" icon/button with no visible destination URL in the static
    # HTML (presumably a JS-driven retailer-picker modal). A genuine
    # structural dead end, not a missing pattern -- there is no price on this
    # page to extract by any method short of following wherever "Buy Now"
    # goes, which is Tier C work (a different retailer URL per product), not
    # a Tier B extractor fix.

    # www.hunarsetu.com (3 products): TRIED and REJECTED 2026-10-31. Pure
    # client-rendered Vue 3 SPA ("mystore" platform) -- confirmed on
    # homeKitchenAppliances-316 (orbit-bullet-mixer-grinder...): the entire
    # server-rendered response is `<div id="body"></div>`, completely empty,
    # with only `<script>` tags loading Vue/Vue Router/axios and the store's
    # own JS bundles. No JSON-LD, no microdata, no embedded page-state object
    # of any kind -- genuinely nothing server-rendered to read, same category
    # as Flipkart/Croma, confirmed the same way (reading the actual response
    # body, not assuming from a bot-block status code; this one was a clean
    # HTTP 200, just an empty shell).

    # www.gopaisa.com (1 product, apparel-80): TRIED and REJECTED 2026-10-31.
    # A React SPA with a real `window.__PRELOADED_STATE__` object (unlike
    # hunarsetu's empty shell) -- but for this specific deal-page URL, that
    # state is the generic homepage/navigation shell
    # (`"seoData":null,"homeData":{}`, empty `retailerReducer`/
    # `categoryReducer`, only sitewide nav menu data) with no deal-specific
    # price data server-rendered at all. The only JSON-LD on the page is
    # sitewide WebSite/Organization schema. The actual deal content (price,
    # MRP, savings) is fetched client-side after the initial page load, same
    # failure mode as mi.com above -- confirmed by reading the full decoded
    # state object, not assumed from an empty-looking page.

    # www.tatacliq.com (NOT luxury.tatacliq.com -- that one already has its
    # own pattern above) (1 product, bagsLuggageTravel-290): RE-CONFIRMED
    # 2026-10-31, matches this script's own top-of-file docstring note
    # ("plain tatacliq.com (non-luxury): empty React shell via both methods,
    # no data to extract either way"). Checked by hand on the actual example
    # product (tommy-hilfiger-hobart.../p-mp000000025245264): the response is
    # a 14KB React app shell whose only JSON-LD is sitewide WebSite/
    # Organization schema, and the product ID from the URL
    # ("mp000000025245264") does not appear anywhere in the response body at
    # all. No change needed -- already correctly documented, this just
    # re-verifies it's still true rather than silently assuming so.

    # www.amazon.in (4 products): TRIED and REJECTED 2026-10-31, the SAME
    # outcome via BOTH methods this task's method calls for trying on Amazon
    # specifically. Plain fetch (apparel-33,
    # Adidas-Mens-Cap-IL6983_Black-White/dp/B0BVRBWBGQ): served Amazon's
    # "Click the button below to continue shopping" bot-interstitial, not the
    # real product page. ONE Apify `rag-web-browser` call at the same URL
    # (per the task's "don't burn more than one attempt" instruction):
    # SUCCEEDED as an Apify run, but the content it actually scraped was the
    # exact same "Click the button below to continue shopping" interstitial
    # -- confirming the block isn't a plain-urllib-specific fingerprint, it's
    # IP/fleet-level bot defense that caught Apify's browser too this time.
    # Same disposition as myntra.com: not viably scrapable right now by
    # either route tried. (Contrast with www.amazon.ae above, which was NOT
    # blocked on its one example product -- Amazon's bot-defense is evidently
    # inconsistent across domains/requests, not a blanket rule.)
}

RETRYABLE_HTTP_STATUS = {429, 502, 503}


def to_number(x):
    f = float(str(x).replace(",", ""))
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
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, http.client.HTTPException) as e:
            unreachable.append({"id": p["id"], "name": p["name"], "domain": domain, "sourceUrl": url, "error": str(e)})
            continue

        mrp_pattern = DOMAIN_MRP_PATTERNS.get(domain)
        used_mrp_extractor = False
        raw_price = None
        if mrp_pattern is not None:
            m = mrp_pattern.search(html)
            if m:
                # Some domain patterns need >1 capturing group (skullcandy.in:
                # group 1 is the single on-page price when there's no active
                # discount, group 2 is the real strikethrough MRP that only
                # appears when there IS a discount -- see the comment by that
                # pattern below). Take the LAST group that actually matched,
                # not always group(1), so a pattern can write its fallback
                # group first and its more-specific MRP-override group after.
                # Every pre-existing single-group pattern is unaffected: with
                # one group, "last non-None" and "group(1)" are the same thing.
                raw_price = next((g for g in reversed(m.groups()) if g is not None), None)
                used_mrp_extractor = raw_price is not None
        if raw_price is None:
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
            "priceSource": "mrp" if used_mrp_extractor else "offers.price (generic -- unverified MRP vs sale)",
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

    unresolved = flagged + unreachable
    unresolved_ids = {u["id"] for u in unresolved}
    checked_ids = {p["id"] for p, _, _ in candidates}
    escalation_queue.sync_unresolved("B", "tier_b_jsonld", unresolved)
    escalation_queue.sync_resolved("tier_b_jsonld", checked_ids, unresolved_ids)

    print(f"Unchanged: {unchanged_count}")
    print(f"Applied: {len(applied)}")
    print(f"Flagged (needs manual review): {len(flagged)}")
    print(f"Unreachable: {len(unreachable)}")
    print(f"Report written to {REPORT_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
