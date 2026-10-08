#!/usr/bin/env python3
"""Generates a static, shareable landing page per product under product/<id>/index.html.

Static (not client-rendered) so each page can carry its own real OG tags --
when a product link is pasted into WhatsApp, the preview card shows that
product's actual photo, name and price, not the generic site icon.

Run from the repo root: python3 scripts/generate_product_pages.py
"""
import html
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT_ROOT = ROOT / "product"

PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2563eb">
<title>{title}</title>
<meta name="description" content="{description}">
<meta property="og:type" content="product">
<meta property="og:title" content="{og_title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="{image}">
<meta property="og:site_name" content="{business_name}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%81%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="../../css/styles.css">
</head>
<body>

<header class="topbar">
  <a href="../../" class="brand" style="text-decoration:none;color:inherit;">
    <img id="brand-logo" src="../../assets/logo.png" alt="" class="brand-logo" aria-hidden="true">
    <div>
      <h1>{business_name}</h1>
      <p class="tagline">{tagline}</p>
    </div>
  </a>
  <button id="theme-toggle" class="icon-btn" type="button" aria-label="Toggle dark mode">🌙</button>
</header>

<main class="pd-main">
  <a href="{back_href}" class="pd-back"><span aria-hidden="true">←</span> {back_label}</a>

  <div class="pd-layout">
    <div class="pd-gallery-col">
      <div class="pd-gallery">
        <div id="pd-gallery-track" class="pd-gallery-track"></div>
        <button id="pd-gallery-prev" class="pd-gallery-nav pd-gallery-nav--prev" type="button" aria-label="Previous image" hidden>‹</button>
        <button id="pd-gallery-next" class="pd-gallery-nav pd-gallery-nav--next" type="button" aria-label="Next image" hidden>›</button>
      </div>
      <div id="pd-gallery-dots" class="pd-gallery-dots" hidden></div>
      <div id="pd-thumbs" class="pd-thumbs"></div>
    </div>

    <div class="pd-info-col">
      <p class="pd-breadcrumb">{category_label}</p>
      <h2 class="pd-title">{name}</h2>
      {brand_html}
      {size_html}
      <p class="pd-price" id="pd-price">{price_html_inner}</p>
      {specs_html}
      {description_html}
      <p class="pd-source" id="pd-source">{source_html_inner}</p>

      <div class="pd-action">
        <button id="pd-add-btn" class="add-btn" type="button">Add to enquiry</button>
        <div id="pd-stepper" class="stepper" hidden>
          <button class="step-btn step-minus" type="button" aria-label="Decrease quantity">−</button>
          <input class="step-input" type="number" inputmode="numeric" min="0" step="1" aria-label="Quantity">
          <button class="step-btn step-plus" type="button" aria-label="Increase quantity">+</button>
        </div>
      </div>
    </div>
  </div>

  <section class="pd-suggest" id="pd-suggest" hidden>
    <h2 class="pd-suggest-title">You might also like</h2>
    <div class="pd-suggest-row" id="pd-suggest-row"></div>
    <div class="pd-suggest-more-wrap"><button id="pd-suggest-more-btn" class="pd-suggest-more-btn" type="button" hidden>Show more products</button></div>
    <div class="pd-suggest-grid" id="pd-suggest-grid"></div>
  </section>
</main>

<a id="pd-sticky-bar" class="pd-sticky-bar" href="../../" hidden>
  <span id="pd-sticky-summary">0 items · 0 pcs</span>
  <span>View shortlist →</span>
</a>

<script>window.__PRODUCT__ = {product_json};</script>
<script src="../../js/product.js" defer></script>
</body>
</html>
"""


def main():
    products = json.loads((DATA / "products.json").read_text())
    config = json.loads((DATA / "config.json").read_text())
    try:
        brands = json.loads((DATA / "brands.json").read_text())
    except FileNotFoundError:
        brands = {}

    category_labels = {c["id"]: c["label"] for c in products["categories"]}
    business_name = config.get("businessName", "Catalog")
    tagline = config.get("tagline", "")
    currency = config.get("currency", "₹")
    show_prices = config.get("showPrices", True)

    # Index products by category once, so "You might also like" is cheap
    # to compute per page instead of re-scanning the whole catalog each time.
    by_category = {}
    for p in products["products"]:
        by_category.setdefault(p["category"], []).append(p)

    def related_products(p, limit=16):
        pid = p["id"]
        brand = brands.get(pid)
        same_cat = [p2 for p2 in by_category.get(p["category"], []) if p2["id"] != pid and p2.get("image")]
        same_brand = [p2 for p2 in same_cat if brand and brands.get(p2["id"]) == brand]
        same_brand_ids = {p2["id"] for p2 in same_brand}
        other = [p2 for p2 in same_cat if p2["id"] not in same_brand_ids]
        picked = (same_brand + other)[:limit]
        return [
            {
                "id": p2["id"],
                "name": p2["name"],
                "price": p2.get("price") if show_prices else None,
                "image": p2.get("image"),
                "brand": brands.get(p2["id"]),
            }
            for p2 in picked
        ]

    if OUT_ROOT.exists():
        shutil.rmtree(OUT_ROOT)
    OUT_ROOT.mkdir(parents=True)

    count = 0
    for p in products["products"]:
        pid = p["id"]
        name = p["name"]
        price = p.get("price")
        image = p.get("image") or ""
        category_label = category_labels.get(p["category"], p["category"])
        brand = brands.get(pid)
        subcategory = p.get("subcategory")
        real_description = p.get("description")
        colours = p.get("colours") or []
        web_colours = p.get("webColours") or []
        sizes = p.get("sizes") or []
        dimensions = p.get("dimensions")
        warranty = p.get("warranty")
        source_url = p.get("sourceUrl")

        meta_parts = []
        if brand:
            meta_parts.append(brand)
        meta_parts.append(category_label)
        if show_prices and price is not None:
            meta_parts.append(f"{currency}{price}")
        meta_description = html.escape(" — ".join(meta_parts))

        breadcrumb = category_label
        if subcategory and subcategory.strip().lower() != category_label.strip().lower():
            breadcrumb = f"{category_label} · {subcategory}"

        size_options = p.get("sizeOptions")

        brand_html = (
            f'<p class="pd-brand">Brand: <strong>{html.escape(brand)}</strong></p>' if brand else ""
        )
        price_html_inner = (
            f'{html.escape(currency)}{price}' if show_prices and price is not None else ""
        )
        description_html = (
            f'<p class="pd-description">{html.escape(real_description)}</p>' if real_description else ""
        )

        size_html = ""
        if size_options:
            pills = []
            for opt in size_options:
                active = " on" if opt.get("default") else ""
                pills.append(
                    f'<button class="pd-size-pill{active}" type="button" '
                    f'data-size-id="{html.escape(opt["id"], quote=True)}">{html.escape(opt["label"])}</button>'
                )
            size_html = (
                '<div class="pd-sizes">'
                '<span class="pd-sizes-label">Size available</span>'
                f'<div class="pd-size-row" id="pd-size-row">{"".join(pills)}</div>'
                '</div>'
            )

        spec_rows = []
        if colours:
            colour_names = ", ".join(html.escape(c.get("label", "")) for c in colours if c.get("label"))
            if colour_names:
                spec_rows.append(f'<p class="pd-spec"><strong>Colours:</strong> {colour_names}</p>')
        elif web_colours:
            colour_names = ", ".join(html.escape(str(c)) for c in web_colours)
            spec_rows.append(f'<p class="pd-spec"><strong>Colours:</strong> {colour_names}</p>')
        if sizes:
            size_names = ", ".join(html.escape(str(s)) for s in sizes)
            spec_rows.append(f'<p class="pd-spec"><strong>Sizes:</strong> {size_names}</p>')
        if dimensions and not size_options:
            spec_rows.append(f'<p class="pd-spec" id="pd-dimensions"><strong>Dimensions:</strong> {html.escape(dimensions)}</p>')
        elif size_options:
            first_dim = next((opt.get("dimensions") for opt in size_options if opt.get("default")), None) \
                or (size_options[0].get("dimensions") if size_options else None)
            if first_dim:
                spec_rows.append(f'<p class="pd-spec" id="pd-dimensions"><strong>Dimensions:</strong> {html.escape(first_dim)}</p>')
        if warranty:
            spec_rows.append(f'<p class="pd-spec"><strong>Warranty:</strong> {html.escape(warranty)}</p>')
        specs_html = "\n  ".join(spec_rows)

        source_html_inner = (
            f'<a href="{html.escape(source_url, quote=True)}" target="_blank" rel="noopener noreferrer">View manufacturer listing ↗</a>'
            if source_url else ""
        )

        back_href = f"../../?category={html.escape(p['category'], quote=True)}"
        back_label = category_label

        product_payload = {
            "id": pid,
            "name": name,
            "price": price if show_prices else None,
            "image": image,
            "images": p.get("images") or ([image] if image else []),
            "category": p["category"],
            "categoryLabel": category_label,
            "subcategory": subcategory,
            "brand": brand,
            "description": real_description,
            "colours": colours,
            "sizes": sizes,
            "dimensions": dimensions,
            "warranty": warranty,
            "sizeOptions": size_options,
            "currency": currency if show_prices else None,
            "related": related_products(p),
        }

        page = PAGE_TEMPLATE.format(
            title=html.escape(f"{name} — {business_name}"),
            og_title=html.escape(name),
            description=meta_description,
            image=html.escape(image, quote=True),
            business_name=html.escape(business_name),
            tagline=html.escape(tagline),
            category_label=html.escape(breadcrumb),
            name=html.escape(name),
            brand_html=brand_html,
            size_html=size_html,
            price_html_inner=price_html_inner,
            specs_html=specs_html,
            description_html=description_html,
            source_html_inner=source_html_inner,
            back_href=back_href,
            back_label=html.escape(back_label),
            product_json=json.dumps(product_payload),
        )

        page_dir = OUT_ROOT / pid
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "index.html").write_text(page)
        count += 1

    print(f"Generated {count} product pages under {OUT_ROOT}")


if __name__ == "__main__":
    main()
