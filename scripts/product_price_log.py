#!/usr/bin/env python3
"""CLI for .claude/skills/livepriceupdate/product-price-log.json -- the
per-product price-sourcing log (see that file's own _description/_usage
fields, and the livepriceupdate skill's Tier C section).

Staleness check: an entry's lastUpdated being old is NOT neutral --
per this project's own "sale prices are snapshots, not durable facts"
rule, a Tier C image-verified match from months ago doesn't mean the
PRICE is still accurate today, only that the match once was. list-stale
is meant to be run regularly (the weekly Saturday scheduled job does)
so these don't just sit there silently drifting.

CLI:
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

    p_stale = sub.add_parser("list-stale", help="List entries older than --days (default 60)")
    p_stale.add_argument("--days", type=int, default=DEFAULT_STALE_DAYS)

    p_show = sub.add_parser("show", help="Print one product's full entry")
    p_show.add_argument("product_id")

    p_touch = sub.add_parser("touch", help="Mark an entry as re-verified today (price re-checked, method unchanged)")
    p_touch.add_argument("product_id")
    p_touch.add_argument("--note", help="Optional note on what was re-checked / found")

    args = parser.parse_args()

    if args.command == "list-stale":
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
