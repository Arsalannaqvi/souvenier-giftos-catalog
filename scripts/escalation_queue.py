#!/usr/bin/env python3
"""Shared per-product escalation queue for the Tier A/B/C live price
system's cost ladder (🟢 cheap -> 🟡 a little expensive -> 🔴 pricey,
see .claude/skills/livepriceupdate/SKILL.md).

The idea: a product that the free/cheap tier script can't resolve
(flagged, multiVariant, or unreachable) doesn't just vanish when the
next day's report overwrites the old one -- it gets tracked here at
level "yellow" (needs the next-cost-level attention) until either
someone resolves it or explicitly bumps it to "red" (needs the
pricey/Saturday-scheduled level) after a yellow-level attempt also
failed. Tier A/B's own scripts call sync_unresolved()/sync_resolved()
automatically at the end of every run; level bumps to "red" are always
an explicit human/session call (bump()), never automatic -- escalating
to the expensive tier should never happen silently.

Tier C has no automated script (the image-verification step can't be
scripted), so it's not wired in here -- its own backlog is just
`products.json` filtered to `sourceUrl is None`, which doesn't need a
separate queue file to stay accurate.

CLI:
  python3 scripts/escalation_queue.py list [--level yellow|red] [--tier A|B]
  python3 scripts/escalation_queue.py bump <productId> --to red --reason "..."
  python3 scripts/escalation_queue.py resolve <productId>
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
QUEUE_PATH = DATA / "price_check_escalation_queue.json"


def _now():
    return datetime.now(timezone.utc).isoformat()


def load():
    if not QUEUE_PATH.exists():
        return {}
    return json.load(open(QUEUE_PATH))


def save(queue):
    json.dump(queue, open(QUEUE_PATH, "w"), ensure_ascii=False, indent=2, sort_keys=True)


def sync_unresolved(tier, source, items):
    """items: iterable of dicts with at least 'id', 'name', and a reason
    (an 'error' or 'action' or similar field -- whatever the caller's
    report already uses). `source` identifies the specific script (e.g.
    "tier_a_shopify", "tier_b_stovekraft", "tier_b_jsonld") -- NOT just
    the tier letter, because two different Tier B scripts cover disjoint
    domain sets and must never clear each other's queue entries (see
    sync_resolved). New products enter at level 'yellow'. A product
    already in the queue keeps its current level (a daily cheap re-run
    re-flagging something already escalated to 'red' must never silently
    downgrade it back to 'yellow') but gets its reason/lastSeenAt
    refreshed and its history appended.
    """
    queue = load()
    for item in items:
        pid = item["id"]
        reason = item.get("error") or item.get("action") or item.get("reason") or "unresolved"
        entry = queue.get(pid)
        if entry is None:
            queue[pid] = {
                "tier": tier,
                "source": source,
                "name": item.get("name"),
                "level": "yellow",
                "reason": reason,
                "firstFlaggedAt": _now(),
                "lastSeenAt": _now(),
                "history": [f"{_now()} green->yellow: {reason}"],
            }
        else:
            entry["lastSeenAt"] = _now()
            entry["reason"] = reason
            entry.setdefault("history", []).append(f"{_now()} still unresolved at {entry['level']}: {reason}")
    save(queue)


def sync_resolved(source, checked_ids, unresolved_ids):
    """Remove queue entries from this exact `source` script that it
    CHECKED this run (checked_ids -- its full candidate set, not just the
    unresolved subset) but did NOT flag as unresolved this time
    (unresolved_ids) -- i.e. genuinely fixed, not just "this script
    doesn't cover that product." Scoping to `source` rather than `tier`
    matters: Tier B's stovekraft and generic-jsonld scripts cover
    disjoint domains, and a product only one of them ever tracked must
    never be removed by the OTHER one's run just because that other
    script never had it in scope to begin with."""
    queue = load()
    removed = []
    for pid, entry in list(queue.items()):
        if entry.get("source") == source and pid in checked_ids and pid not in unresolved_ids:
            removed.append(pid)
            del queue[pid]
    save(queue)
    return removed


def bump(product_id, to_level, reason):
    queue = load()
    entry = queue.get(product_id)
    if entry is None:
        raise SystemExit(f"{product_id} is not in the escalation queue -- nothing to bump")
    old_level = entry["level"]
    entry["level"] = to_level
    entry["reason"] = reason
    entry["lastSeenAt"] = _now()
    entry.setdefault("history", []).append(f"{_now()} {old_level}->{to_level}: {reason}")
    save(queue)
    print(f"{product_id}: {old_level} -> {to_level} ({reason})")


def resolve(product_id):
    queue = load()
    if product_id not in queue:
        raise SystemExit(f"{product_id} is not in the escalation queue")
    del queue[product_id]
    save(queue)
    print(f"{product_id}: removed from escalation queue (resolved)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list")
    p_list.add_argument("--level", choices=["yellow", "red"])
    p_list.add_argument("--tier", choices=["A", "B"])
    p_list.add_argument("--source")

    p_bump = sub.add_parser("bump")
    p_bump.add_argument("product_id")
    p_bump.add_argument("--to", required=True, choices=["yellow", "red"])
    p_bump.add_argument("--reason", required=True)

    p_resolve = sub.add_parser("resolve")
    p_resolve.add_argument("product_id")

    args = parser.parse_args()

    if args.command == "list":
        queue = load()
        rows = [
            {"id": pid, **entry}
            for pid, entry in queue.items()
            if (args.level is None or entry["level"] == args.level)
            and (args.tier is None or entry["tier"] == args.tier)
            and (args.source is None or entry.get("source") == args.source)
        ]
        rows.sort(key=lambda r: (r["level"], r["tier"], r["id"]))
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        print(f"\n{len(rows)} matching item(s). Total queue size: {len(queue)}.", file=sys.stderr)
    elif args.command == "bump":
        bump(args.product_id, args.to, args.reason)
    elif args.command == "resolve":
        resolve(args.product_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
