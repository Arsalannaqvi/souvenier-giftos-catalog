#!/usr/bin/env python3
"""Generates data/colors.json: {product_id: ["Black", "Blue", ...]}.

Products carry colour info two ways -- a structured `colours` list
({label, colorHex, images}) or a plain `webColours` list of strings. Both
are messy marketing names ("Active Black", "Olive Yellow", "Cherry
Blossom", "Charcoal Melange" -- 650+ distinct raw labels across the
catalog), too noisy to use directly as filter options. This buckets every
raw label into one of a small set of base colours a shopper would actually
filter by, by matching words in the label (last word first, since the
naming pattern is almost always "<modifier> <base colour>") against
COLOR_WORD_MAP below.

Products with no colour data, or whose labels don't match any known word,
are simply omitted -- no bucket is guessed for them.

Run from the repo root: python3 scripts/generate_colors.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Bucket display order (also the order new filter chips render in) and the
# swatch hex shown next to each one in the UI -- see BUCKET_SWATCHES below,
# kept in sync manually since JS can't import this file.
BUCKET_ORDER = [
    "Black", "White", "Grey", "Silver", "Blue", "Green", "Red", "Pink",
    "Purple", "Yellow", "Orange", "Brown", "Beige", "Gold", "Multicolor",
]

# Last-word-first, else first-matching-word. Order within a bucket's list
# doesn't matter; order of insertion across buckets doesn't matter either
# since every raw label is looked up by exact word, not substring.
COLOR_WORD_MAP = {
    "black": "Black",
    "white": "White", "ivory": "White",
    "grey": "Grey", "gray": "Grey", "charcoal": "Grey", "ash": "Grey", "melange": "Grey",
    "graphite": "Grey", "carbon": "Grey",
    "silver": "Silver", "sliver": "Silver", "steel": "Silver", "platinum": "Silver",
    "chrome": "Silver", "gunmetal": "Silver",
    "blue": "Blue", "navy": "Blue", "teal": "Blue", "cyan": "Blue",
    "indigo": "Blue", "aqua": "Blue", "sky": "Blue", "denim": "Blue", "cobalt": "Blue",
    "royalblue": "Blue", "turquoise": "Blue", "petrol": "Blue",
    "green": "Green", "olive": "Green", "mint": "Green", "sage": "Green",
    "forest": "Green", "lime": "Green", "emerald": "Green", "jade": "Green",
    "red": "Red", "maroon": "Red", "crimson": "Red", "wine": "Red", "burgundy": "Red",
    "ruby": "Red", "indianred": "Red",
    "pink": "Pink", "rose": "Pink", "magenta": "Pink", "fuchsia": "Pink", "blossom": "Pink",
    "purple": "Purple", "violet": "Purple", "lavender": "Purple", "lilac": "Purple",
    "plum": "Purple", "mauve": "Purple",
    "yellow": "Yellow", "mustard": "Yellow", "lemon": "Yellow", "gold": "Gold", "golden": "Gold",
    "orange": "Orange", "peach": "Orange", "coral": "Orange", "rust": "Orange", "darkorange": "Orange",
    "brown": "Brown", "chocolate": "Brown", "coffee": "Brown", "khaki": "Brown",
    "camel": "Brown", "tan": "Brown", "bronze": "Brown", "mocha": "Brown",
    "beige": "Beige", "cream": "Beige", "nude": "Beige", "sand": "Beige",
    "multicolor": "Multicolor", "multicolour": "Multicolor", "multi": "Multicolor",
    "assorted": "Multicolor", "rainbow": "Multicolor", "printed": "Multicolor",
}
# "gold"/"golden" above map to Gold explicitly (re-stated to win over a
# stray generic match); keep Gold out of the generic Yellow bucket since
# gifting products (pens, bottles) are often marketed specifically by a
# metallic gold finish, a distinct buyer intent from "yellow".
COLOR_WORD_MAP["gold"] = "Gold"
COLOR_WORD_MAP["golden"] = "Gold"
COLOR_WORD_MAP["rosegold"] = "Gold"


def classify(label):
    words = re.findall(r"[a-zA-Z]+", str(label).lower())
    if not words:
        return None
    if words[-1] in COLOR_WORD_MAP:
        return COLOR_WORD_MAP[words[-1]]
    for w in words:
        if w in COLOR_WORD_MAP:
            return COLOR_WORD_MAP[w]
    return None


def main():
    products = json.loads((DATA / "products.json").read_text())["products"]

    result = {}
    unmatched = {}
    for p in products:
        labels = []
        for c in (p.get("colours") or []):
            if c.get("label"):
                labels.append(c["label"])
        for c in (p.get("webColours") or []):
            labels.append(str(c))

        buckets = set()
        for label in labels:
            bucket = classify(label)
            if bucket:
                buckets.add(bucket)
            else:
                unmatched[label] = unmatched.get(label, 0) + 1

        if buckets:
            # Keep BUCKET_ORDER's order for a stable, predictable payload.
            result[p["id"]] = [b for b in BUCKET_ORDER if b in buckets]

    (DATA / "colors.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

    from collections import Counter
    bucket_counts = Counter()
    for buckets in result.values():
        for b in buckets:
            bucket_counts[b] += 1

    print(f"Wrote data/colors.json: {len(result)} of {len(products)} products got at least one colour bucket.")
    print("Products per bucket:")
    for b in BUCKET_ORDER:
        print(f"  {b:12s} {bucket_counts.get(b, 0)}")
    if unmatched:
        top_unmatched = sorted(unmatched.items(), key=lambda x: -x[1])[:20]
        print(f"\n{len(unmatched)} distinct raw labels didn't match any bucket (top 20 by frequency):")
        for label, count in top_unmatched:
            print(f"  {count:4d}  {label}")


if __name__ == "__main__":
    main()
