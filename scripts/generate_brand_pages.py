#!/usr/bin/env python3
"""Generates a static landing page per brand under brand/<slug>/index.html.

Mirrors scripts/generate_product_pages.py: reads data/products.json,
data/brands.json (productId -> brand name) and data/config.json once,
groups products by brand, and writes one static index.html per brand with
a window.__BRAND__ JSON payload for js/brand.js to render/filter
client-side (no per-page fetch of products.json).

Only brands with at least MIN_PRODUCTS products get a page -- a "brand"
with 1-2 products in this catalog is almost always noise (a one-off
import, a mis-tagged competitor name, etc.), not something worth a
dedicated landing page. 3 was chosen by inspecting the real distribution:
of 59 distinct brand values in data/brands.json, 13 have only 1-2
products and the rest have 3+ (most considerably more), so the cutoff
cleanly separates "real brand" from "noise" without discarding anything
with a real assortment.

Run from the repo root: python3 scripts/generate_brand_pages.py
"""
import html
import json
import re
import shutil
from collections import Counter
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT_ROOT = ROOT / "brand"

MIN_PRODUCTS = 3

PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0d16">
<title>{title}</title>
<meta name="description" content="{description}">
<meta property="og:type" content="website">
<meta property="og:title" content="{og_title}">
<meta property="og:description" content="{description}">
<meta property="og:site_name" content="{business_name}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%81%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../css/styles.css">
</head>
<body>

<header class="topbar">
  <a href="../../" class="brand" style="text-decoration:none;color:inherit;">
    <img id="brand-logo" src="../../assets/logo-white.png" alt="" class="brand-logo" aria-hidden="true">
    <div>
      <h1>{business_name}</h1>
      <p class="tagline">{tagline}</p>
    </div>
  </a>
  <button id="theme-toggle" class="icon-btn" type="button" aria-label="Toggle dark mode">🌙</button>
</header>

<main class="pd-main brand-main">
  <a href="{back_href}" class="pd-back"><span aria-hidden="true">←</span> {back_label}</a>

  <section class="brand-hero">
    <div class="brand-hero-mark" aria-hidden="true">{monogram}</div>
    <div class="brand-hero-body">
      <p class="brand-hero-eyebrow">Brand</p>
      <h2 class="brand-hero-name">{brand_name}</h2>
      <p class="brand-hero-desc">{brand_description}</p>
      <div class="brand-hero-stats">
        <div class="brand-hero-stat"><b>{product_count}</b><span>Products</span></div>
        <div class="brand-hero-stat"><b>{category_count}</b><span>Categories</span></div>
        <div class="brand-hero-stat"><b>{price_range_html}</b><span>Price range</span></div>
      </div>
    </div>
  </section>

  <h3 class="section-title">Shop by category</h3>
  <div class="chip-row" id="brand-category-rail" role="group" aria-label="Filter by category"></div>

  <div class="filter-bar">
    <div class="filter-group">
      <span class="filter-label">Price</span>
      <div class="price-range-inputs">
        <input type="number" id="brand-price-min" placeholder="Min" min="0" aria-label="Minimum price">
        <span>–</span>
        <input type="number" id="brand-price-max" placeholder="Max" min="0" aria-label="Maximum price">
      </div>
    </div>
    <div class="filter-group">
      <span class="filter-label">Sort</span>
      <select class="toolbar-select" id="brand-sort-select" aria-label="Sort products">
        <option value="featured">Featured</option>
        <option value="price-asc">Price: Low to High</option>
        <option value="price-desc">Price: High to Low</option>
        <option value="name-asc">Name: A to Z</option>
      </select>
    </div>
    <button type="button" class="filter-reset" id="brand-filter-reset">Reset filters</button>
  </div>

  <p class="results-summary" id="brand-results-summary"></p>
  <div class="product-grid" id="brand-product-grid"></div>
  <p class="empty-state" id="brand-empty-state" hidden>No {brand_name_escaped} products match these filters.</p>
</main>

<a id="pd-sticky-bar" class="pd-sticky-bar" href="../../" hidden>
  <span id="pd-sticky-summary">0 items · 0 pcs</span>
  <span>View shortlist →</span>
</a>

<script>window.__BRAND__ = {brand_json};</script>
<script src="../../js/brand.js" defer></script>
</body>
</html>
"""


def slugify(name):
    s = name.lower().strip()
    s = s.replace("’", "").replace("'", "")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "brand"


def monogram(name):
    words = re.findall(r"[A-Za-z0-9]+", name)
    if not words:
        return "?"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()


def describe(product_count, category_breakdown):
    labels = [c["label"] for c in category_breakdown[:3]]
    if len(labels) >= 3:
        body = f"{labels[0]}, {labels[1]} and {labels[2]}"
    elif len(labels) == 2:
        body = f"{labels[0]} and {labels[1]}"
    elif len(labels) == 1:
        body = labels[0]
    else:
        body = "corporate gifting"
    return f"{product_count} products across {body} — curated for corporate gifting."


def main():
    products = json.loads((DATA / "products.json").read_text())
    config = json.loads((DATA / "config.json").read_text())
    try:
        brand_by_product = json.loads((DATA / "brands.json").read_text())
    except FileNotFoundError:
        brand_by_product = {}

    category_labels = {c["id"]: c["label"] for c in products["categories"]}
    business_name = config.get("businessName", "Catalog")
    tagline = config.get("tagline", "")
    currency = config.get("currency", "₹")
    show_prices = config.get("showPrices", True)

    products_by_id = {p["id"]: p for p in products["products"]}

    products_by_brand = {}
    for pid, brand_name in brand_by_product.items():
        p = products_by_id.get(pid)
        if not p:
            continue  # brands.json entry for a product no longer in the catalog
        products_by_brand.setdefault(brand_name, []).append(p)

    used_slugs = {}

    if OUT_ROOT.exists():
        shutil.rmtree(OUT_ROOT)
    OUT_ROOT.mkdir(parents=True)

    generated = 0
    skipped = []
    for brand_name in sorted(products_by_brand.keys()):
        brand_products = products_by_brand[brand_name]
        if len(brand_products) < MIN_PRODUCTS:
            skipped.append((brand_name, len(brand_products)))
            continue

        cat_counter = Counter(p["category"] for p in brand_products)
        category_breakdown = [
            {"id": cat_id, "label": category_labels.get(cat_id, cat_id), "count": count}
            for cat_id, count in cat_counter.most_common()
        ]

        prices = [p["price"] for p in brand_products if p.get("price") is not None]
        price_min = min(prices) if prices else None
        price_max = max(prices) if prices else None
        if show_prices and prices:
            price_range_html = (
                f"{html.escape(currency)}{price_min}"
                if price_min == price_max
                else f"{html.escape(currency)}{price_min}&ndash;{price_max}"
            )
        else:
            price_range_html = "—"

        slug = slugify(brand_name)
        if slug in used_slugs:
            used_slugs[slug] += 1
            slug = f"{slug}-{used_slugs[slug]}"
        else:
            used_slugs[slug] = 1

        payload_products = [
            {
                "id": p["id"],
                "name": p["name"],
                "price": p.get("price") if show_prices else None,
                "image": p.get("image"),
                "category": p["category"],
                "categoryLabel": category_labels.get(p["category"], p["category"]),
                "subcategory": p.get("subcategory"),
            }
            for p in brand_products
        ]

        brand_payload = {
            "name": brand_name,
            "slug": slug,
            "description": describe(len(brand_products), category_breakdown),
            "currency": currency if show_prices else None,
            "categories": category_breakdown,
            "priceMin": price_min if show_prices else None,
            "priceMax": price_max if show_prices else None,
            "products": payload_products,
        }

        meta_desc_parts = [brand_name, f"{len(brand_products)} products"]
        if category_breakdown:
            meta_desc_parts.append(category_breakdown[0]["label"])
        meta_description = html.escape(" — ".join(meta_desc_parts))

        back_href = f"../../?brand={quote(brand_name)}"

        page = PAGE_TEMPLATE.format(
            title=html.escape(f"{brand_name} — {business_name}"),
            og_title=html.escape(f"{brand_name} on {business_name}"),
            description=meta_description,
            business_name=html.escape(business_name),
            tagline=html.escape(tagline),
            back_href=back_href,
            back_label=html.escape(brand_name),
            monogram=html.escape(monogram(brand_name)),
            brand_name=html.escape(brand_name),
            brand_name_escaped=html.escape(brand_name),
            brand_description=html.escape(brand_payload["description"]),
            product_count=len(brand_products),
            category_count=len(category_breakdown),
            price_range_html=price_range_html,
            brand_json=json.dumps(brand_payload),
        )

        page_dir = OUT_ROOT / slug
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "index.html").write_text(page)
        generated += 1

    print(f"Generated {generated} brand pages under {OUT_ROOT}")
    if skipped:
        print(f"Skipped {len(skipped)} brands with fewer than {MIN_PRODUCTS} products:")
        for name, count in skipped:
            print(f"  - {name} ({count})")


if __name__ == "__main__":
    main()
