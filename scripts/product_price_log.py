#!/usr/bin/env python3
"""CLI for .claude/skills/livepriceupdate/product-price-log.json -- the
per-product price-sourcing log (see that file's own _description/_usage
fields, and the livepriceupdate skill's Tier C section).

Owner's standing rule (2026-10-20): EVERY product the owner hands over
gets an entry here recording where its info/price came from -- a PDF
they gave, a live site, or stated directly. A PDF-sourced product is
marked sourceType=pdf and stays that way until the owner explicitly
asks for an online check; that check becomes its own logged event (how
and where it was checked), via `recheck-online`, not a silent edit.

Staleness check: an entry's lastUpdated being old is NOT neutral --
per this project's own "sale prices are snapshots, not durable facts"
rule, a Tier C image-verified match from months ago doesn't mean the
PRICE is still accurate today, only that the match once was. list-stale
is meant to be run regularly (the weekly Saturday scheduled job does)
so these don't just sit there silently drifting.

CLI:
  python3 scripts/product_price_log.py add <id> --name N --brand B --tier A|B|C
      --source-type pdf|online|owner-provided --price P [--pdf-name "..."]
      [--source-url URL] [--method "..."] [--price-basis ...] [--confidence ...] [--caveats "..."]
  python3 scripts/product_price_log.py recheck-online <id> --source-url URL --method "..."
      [--price P] [--price-basis mrp|sale-price-flagged] [--note "..."]
  python3 scripts/product_price_log.py list-stale [--days 60]
  python3 scripts/product_price_log.py show <id>
  python3 scripts/product_price_log.py touch <id> [--note "..."]
"""
import argparse
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_PATH = ROOT / ".claude" / "skills" / "livepriceupdate" / "product-price-log.json"

DEFAULT_STALE_DAYS = 60
SOURCE_TYPES = {"pdf", "online", "owner-provided"}


def load():
    return json.load(open(LOG_PATH))


def save(data):
    json.dump(data, open(LOG_PATH, "w"), ensure_ascii=False, indent=2, sort_keys=False)


def is_meta(key):
    return key.startswith("_")


def days_old(last_updated_str):
    try:
        d = date.fromisoformat(last_updated_str)
    except (TypeError, ValueError):
        return None
    return (date.today() - d).days


def list_stale(days=DEFAULT_STALE_DAYS):
    data = load()
    stale = []
    for pid, entry in data.items():
        if is_meta(pid):
            continue
        age = days_old(entry.get("lastUpdated"))
        if age is None:
            stale.append((pid, entry, "unparseable-date"))
        elif age >= days:
            stale.append((pid, entry, age))
    # oldest/worst first; unparseable dates sort last since they're a data
    # problem, not necessarily a staleness one
    stale.sort(key=lambda t: (t[2] == "unparseable-date", -(t[2] if isinstance(t[2], int) else 0)))
    return stale


def show(product_id):
    data = load()
    entry = data.get(product_id)
    if entry is None:
        raise SystemExit(f"{product_id} is not in {LOG_PATH.name}")
    return entry


def add(product_id, name, brand, tier, source_type, price, pdf_name=None,
        source_url=None, method=None, price_basis=None, confidence=None,
        caveats=None, markup_applied="none"):
    if source_type not in SOURCE_TYPES:
        raise SystemExit(f"--source-type must be one of {sorted(SOURCE_TYPES)}, got {source_type!r}")
    if source_type == "pdf" and not pdf_name:
        raise SystemExit("--pdf-name is required when --source-type pdf (which PDF did this come from?)")
    if source_type == "online" and not source_url:
        raise SystemExit("--source-url is required when --source-type online")

    data = load()
    if product_id in data:
        raise SystemExit(f"{product_id} already has an entry -- use recheck-online to log a re-check, or edit the JSON directly for a correction")

    today = date.today().isoformat()
    entry = {
        "name": name,
        "brand": brand,
        "tier": tier,
        "sourceType": source_type,
        "pdfName": pdf_name,
        "sourceUrl": source_url,
        "method": method or (f"Provided by owner from PDF: {pdf_name}" if source_type == "pdf" else "Provided by owner" if source_type == "owner-provided" else None),
        "priceAtEntry": price,
        "priceBasis": price_basis,
        "markupApplied": markup_applied,
        "confidence": confidence,
        "caveats": caveats,
        "lastUpdated": today,
        "history": [f"{today} added (source: {source_type}" + (f", PDF: {pdf_name}" if pdf_name else "") + ")"],
    }
    data[product_id] = entry
    save(data)
    return entry


def recheck_online(product_id, source_url, method, price=None, price_basis=None, note=None):
    data = load()
    entry = data.get(product_id)
    if entry is None:
        raise SystemExit(f"{product_id} is not in {LOG_PATH.name} -- use `add` first")

    today = date.today().isoformat()
    old_source_type = entry.get("sourceType")
    old_price = entry.get("priceAtEntry")

    entry["sourceType"] = "online"
    entry["sourceUrl"] = source_url
    entry["method"] = method
    entry["lastUpdated"] = today
    if price_basis:
        entry["priceBasis"] = price_basis
    if price is not None:
        entry["priceAtEntry"] = price

    history_line = f"{today} checked online (was {old_source_type}" + (f" from PDF {entry.get('pdfName')}" if entry.get('pdfName') else "") + f") via {source_url} -- method: {method}"
    if price is not None and old_price is not None and price != old_price:
        history_line += f" -- price {old_price} -> {price}"
    if note:
        history_line += f" -- {note}"
        entry["caveats"] = note
    entry.setdefault("history", []).append(history_line)

    save(data)
    return entry


def touch(product_id, note=None):
    data = load()
    entry = data.get(product_id)
    if entry is None:
        raise SystemExit(f"{product_id} is not in {LOG_PATH.name} -- add a full entry first, touch is only for re-confirming an existing one")
    today = date.today().isoformat()
    old_date = entry.get("lastUpdated")
    entry["lastUpdated"] = today
    history_note = f"re-verified {today}" + (f": {note}" if note else " (price re-checked, still accurate -- no method change)")
    entry.setdefault("history", []).append(history_note)
    if note:
        entry["caveats"] = note
    save(data)
    return old_date, today


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="Add a new product -- always record where its info/price came from")
    p_add.add_argument("product_id")
    p_add.add_argument("--name", required=True)
    p_add.add_argument("--brand", required=True)
    p_add.add_argument("--tier", required=True, choices=["A", "B", "C"])
    p_add.add_argument("--source-type", required=True, choices=sorted(SOURCE_TYPES))
    p_add.add_argument("--price", required=True, type=float)
    p_add.add_argument("--pdf-name", help="Required if --source-type pdf -- which PDF this came from")
    p_add.add_argument("--source-url", help="Required if --source-type online")
    p_add.add_argument("--method", help="How this was found/entered, if not already implied by source-type")
    p_add.add_argument("--price-basis", choices=["mrp", "sale-price-flagged", "wholesale-estimate-flagged", "no-mrp-field", "n/a"])
    p_add.add_argument("--confidence")
    p_add.add_argument("--caveats")
    p_add.add_argument("--markup-applied", default="none")

    p_recheck = sub.add_parser("recheck-online", help="Log an online check for a product (e.g. one originally sourced from a PDF) -- records how and where it was checked")
    p_recheck.add_argument("product_id")
    p_recheck.add_argument("--source-url", required=True)
    p_recheck.add_argument("--method", required=True, help="How the check was done, e.g. 'web search -> brand's own site, image-confirmed'")
    p_recheck.add_argument("--price", type=float, help="New price if it changed")
    p_recheck.add_argument("--price-basis", choices=["mrp", "sale-price-flagged", "wholesale-estimate-flagged", "no-mrp-field", "n/a"])
    p_recheck.add_argument("--note")

    p_stale = sub.add_parser("list-stale", help="List entries older than --days (default 60)")
    p_stale.add_argument("--days", type=int, default=DEFAULT_STALE_DAYS)

    p_show = sub.add_parser("show", help="Print one product's full entry")
    p_show.add_argument("product_id")

    p_touch = sub.add_parser("touch", help="Mark an entry as re-verified today (price re-checked, method unchanged)")
    p_touch.add_argument("product_id")
    p_touch.add_argument("--note", help="Optional note on what was re-checked / found")

    args = parser.parse_args()

    if args.command == "add":
        entry = add(args.product_id, args.name, args.brand, args.tier, args.source_type,
                    args.price, pdf_name=args.pdf_name, source_url=args.source_url,
                    method=args.method, price_basis=args.price_basis, confidence=args.confidence,
                    caveats=args.caveats, markup_applied=args.markup_applied)
        print(f"{args.product_id}: added (source: {args.source_type})")
        print(json.dumps(entry, indent=2, ensure_ascii=False))
    elif args.command == "recheck-online":
        entry = recheck_online(args.product_id, args.source_url, args.method,
                                price=args.price, price_basis=args.price_basis, note=args.note)
        print(f"{args.product_id}: logged online re-check via {args.source_url}")
        print(json.dumps(entry, indent=2, ensure_ascii=False))
    elif args.command == "list-stale":
        stale = list_stale(args.days)
        if not stale:
            print(f"No entries older than {args.days} days. Checked {sum(1 for k in load() if not is_meta(k))} products.")
            return 0
        print(f"{len(stale)} entries >= {args.days} days old (or with an unparseable date):\n")
        for pid, entry, age in stale:
            age_label = f"{age}d" if isinstance(age, int) else age
            print(f"  {pid} ({age_label}) -- {entry.get('name')} [{entry.get('brand')}] -- lastUpdated {entry.get('lastUpdated')}")
        print(f"\nRe-verify these: either re-run the method in the entry and `touch` it if the price still holds, or re-research if the sourceUrl/match no longer checks out.")
    elif args.command == "show":
        print(json.dumps(show(args.product_id), indent=2, ensure_ascii=False))
    elif args.command == "touch":
        old, new = touch(args.product_id, args.note)
        print(f"{args.product_id}: lastUpdated {old} -> {new}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
