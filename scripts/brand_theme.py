"""Shared per-brand visuals: a deterministic accent-color pair and the real
logo file (if we have one) for a brand name. Used by both
generate_product_pages.py (subtle price/gallery tint on product pages) and
generate_brand_pages.py (brand hero mark), so the same brand always gets the
same color and logo everywhere on the site.

Logos live in assets/brands/<slug>.png -- see assets/brands/README.md (if
present) for how that set was sourced. Not every brand has one; callers must
handle the "no logo" case by falling back to the existing monogram badge.
"""
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRAND_LOGO_DIR = ROOT / "assets" / "brands"

# Pairs chosen to sit in the same "dark navy / electric-blue / violet
# futuristic luxury" family as the default --accent/--accent-2 tokens, just
# with distinct hues so brands read as visually different from one another.
# Index 0 intentionally matches the existing default accent exactly, so a
# product with no identifiable brand looks unchanged.
ACCENT_PALETTE = [
    ("#5b8aff", "#9b81f7"),  # blue -> violet (default)
    ("#a78cfa", "#f0abfc"),  # violet -> orchid
    ("#22d3ee", "#38bdf8"),  # cyan -> sky
    ("#fb7185", "#fb923c"),  # rose -> amber
    ("#34d399", "#2dd4bf"),  # emerald -> teal
    ("#fbbf24", "#f97316"),  # gold -> orange
    ("#818cf8", "#c084fc"),  # indigo -> purple
    ("#f472b6", "#e879f9"),  # pink -> magenta
]


def slugify(name):
    s = str(name).lower().strip()
    s = s.replace("’", "").replace("'", "")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "brand"


def brand_accent(name):
    """Returns (accent, accent2) hex pair, deterministic per brand name."""
    if not name:
        return ACCENT_PALETTE[0]
    digest = hashlib.md5(name.encode("utf-8")).hexdigest()
    index = int(digest, 16) % len(ACCENT_PALETTE)
    return ACCENT_PALETTE[index]


def brand_logo_rel_path(name, depth=2):
    """Returns a relative path (e.g. "../../assets/brands/boat.png") to this
    brand's logo if we have one on disk, else None."""
    if not name:
        return None
    slug = slugify(name)
    if (BRAND_LOGO_DIR / f"{slug}.png").exists():
        prefix = "../" * depth
        return f"{prefix}assets/brands/{slug}.png"
    return None
