"""Command line: harvest, build, serve, inspect.

    python3 -m pastperfect ingest      fetch objects and images from the museums
    python3 -m pastperfect build       rebuild pairs, daily sets and share cards
    python3 -m pastperfect serve       run the site on localhost
    python3 -m pastperfect doctor      check the database can actually run a game
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys

from . import config, daily, db, ingest, media, og, pairs, store


def cmd_ingest(args) -> int:
    targets = {slug: args.target for slug in (args.museum or config.MUSEUM_ORDER)} if args.target else None
    counts = ingest.run(museums=args.museum or None, targets=targets)
    print(json.dumps(counts, indent=2))
    return 0


def cmd_images(args) -> int:
    db.init()
    fetched = ingest.fetch_images()
    print(f"{fetched} derivatives fetched · {media.disk_usage() / 1e6:.1f} MB on disk")
    return 0


def cmd_retag(args) -> int:
    """Recompute the derived taxonomy columns from stored metadata.

    Region, the "reads modern" signal and the representative year are all
    derived from fields we already hold, so improving any of them should not
    mean re-harvesting four museums.
    """
    from . import dates, taxonomy

    conn = db.connect()
    rows = [dict(r) for r in conn.execute(
        "SELECT id, medium, classification, title, department, culture, artist_note, "
        "date_display, year_start, year_end, date_precision FROM objects"
    )]
    updates = []
    for r in rows:
        estimate = dates.DateEstimate(
            r["year_start"], r["year_end"], r["date_precision"], r["date_display"] or ""
        )
        updates.append((
            taxonomy.region_for(r["culture"], r["department"], r["title"], r["artist_note"]),
            int(taxonomy.reads_modern(r["medium"], r["classification"], r["title"], r["department"])),
            dates.representative_year(estimate),
            r["id"],
        ))
    with db.write() as conn:
        conn.executemany(
            "UPDATE objects SET region = ?, looks_modern = ?, year_mid = ? WHERE id = ?", updates
        )
    modern = sum(u[1] for u in updates)
    print(f"{len(updates):,} objects retagged · {modern:,} read as modern")
    print("Run 'pairs' next: difficulty and insights are derived from these columns.")
    return 0


def cmd_pairs(args) -> int:
    print("Building pairs ...")
    pairs.build(log=print)
    for row in pairs.distribution():
        print(
            f"  difficulty {row['difficulty']}  {row['n']:6,} pairs  "
            f"gaps {row['min_gap']}-{row['max_gap']}y  {row['surprising'] or 0} surprising"
        )
    # Rebuilding the pool invalidates every stored daily set, so regenerate them
    # here rather than leaving the site with no puzzle until someone remembers.
    print("Rebuilding daily sets ...")
    daily.ensure(days=getattr(args, "days", 45), log=print)
    return 0


def cmd_daily(args) -> int:
    print("Building daily sets ...")
    daily.ensure(days=args.days, log=print)
    return 0


def cmd_cards(args) -> int:
    db.init()
    made = 0
    today = daily.today()
    for offset in range(args.days):
        day = today + _dt.timedelta(days=offset)
        og.render(day, force=args.force)
        made += 1
    og.default_card(force=args.force)
    print(f"{made} share cards rendered")
    return 0


def cmd_build(args) -> int:
    cmd_pairs(args)
    cmd_cards(args)
    return cmd_doctor(args)


def cmd_serve(args) -> int:
    from .server import serve

    serve(host=args.host, port=args.port)
    return 0


def cmd_stats(args) -> int:
    counts = db.counts()
    overall = store.overall_stats()
    print(f"objects        {counts['objects']:,} stored, {overall['objects']:,} in play")
    print(f"pairs          {counts['pairs']:,}")
    print(f"daily days     {counts['daily_days']}")
    print(f"results        {counts['results']:,}")
    print(f"events         {counts['events']:,}")
    print(f"span           {overall['earliest']} to {overall['latest']}")
    print(f"media on disk  {media.disk_usage() / 1e6:.1f} MB")
    events = store.event_summary()
    if events:
        print("\nrecent events")
        for row in events:
            print(f"  {row['name']:26} {row['n']:6,}  from {row['sessions']} sessions")
    return 0


def cmd_doctor(args) -> int:
    """Check the database can actually run a game, and that answers are provable."""
    db.init()
    problems: list[str] = []
    overall = store.overall_stats()
    if overall["objects"] < 50:
        problems.append(f"only {overall['objects']} objects in play")
    if overall["pairs"] < 200:
        problems.append(f"only {overall['pairs']} pairs built")

    conn = db.connect()
    overlapping = conn.execute(
        "SELECT COUNT(*) FROM pairs p JOIN objects l ON l.id = p.left_id "
        "JOIN objects r ON r.id = p.right_id "
        "WHERE NOT (l.year_end < r.year_start OR r.year_end < l.year_start)"
    ).fetchone()[0]
    if overlapping:
        problems.append(f"{overlapping} pairs have overlapping date ranges")

    mislabelled = conn.execute(
        "SELECT COUNT(*) FROM pairs p JOIN objects l ON l.id = p.left_id "
        "JOIN objects r ON r.id = p.right_id WHERE "
        "(p.earlier = 'left'  AND NOT l.year_end < r.year_start) OR "
        "(p.earlier = 'right' AND NOT r.year_end < l.year_start)"
    ).fetchone()[0]
    if mislabelled:
        problems.append(f"{mislabelled} pairs record the wrong earlier side")

    unlicensed = conn.execute(
        "SELECT COUNT(*) FROM objects WHERE playable = 1 AND license_id NOT IN "
        f"({','.join('?' for _ in config.ALLOWED_LICENCES)})",
        tuple(config.ALLOWED_LICENCES),
    ).fetchone()[0]
    if unlicensed:
        problems.append(f"{unlicensed} playable objects carry a licence outside the allow list")

    imageless = conn.execute(
        "SELECT COUNT(*) FROM pairs p JOIN objects l ON l.id = p.left_id "
        "JOIN objects r ON r.id = p.right_id WHERE l.local_image = 0 OR r.local_image = 0"
    ).fetchone()[0]
    if imageless:
        problems.append(f"{imageless} pairs reference an object with no local image")

    today = daily.today()
    for edition in ["", *config.MUSEUM_ORDER]:
        rows = daily.questions(today, edition)
        name = edition or "mixed"
        if len(rows) < config.DAILY_QUESTIONS:
            problems.append(f"today's {name} daily has {len(rows)} questions")

    if problems:
        print("FAIL")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(
        f"OK · {overall['objects']:,} objects · {overall['pairs']:,} pairs · "
        f"{len(daily.available_days())} daily days · every answer provable"
    )
    return 0


def cmd_export_seed(args) -> int:
    """Write the normalised objects to JSON so the database can be rebuilt offline."""
    conn = db.connect()
    rows = [
        dict(row)
        for row in conn.execute(
            "SELECT * FROM objects WHERE playable = 1 ORDER BY museum, source_id"
        )
    ]
    config.SEED_DIR.mkdir(parents=True, exist_ok=True)
    target = config.SEED_DIR / "objects.json"
    target.write_text(json.dumps(rows, indent=1, ensure_ascii=False), "utf-8")
    print(f"{len(rows):,} objects written to {target}")
    return 0


def cmd_import_seed(args) -> int:
    source = config.SEED_DIR / "objects.json"
    if not source.exists():
        print(f"no seed at {source}", file=sys.stderr)
        return 1
    rows = json.loads(source.read_text("utf-8"))
    db.init()
    # The snapshot carries metadata, not pictures. Trust the disk rather than the
    # file for whether a derivative exists, so a fresh clone knows it still has
    # images to fetch and a repeat import does not re-download what it has.
    present = 0
    for row in rows:
        row["local_image"] = int(media.has_local(row["image_key"]))
        present += row["local_image"]
    ingest.store(rows)
    missing = len(rows) - present
    print(f"{len(rows):,} objects loaded, {present:,} with images already on disk.")
    if missing:
        print(f"Run 'images' to fetch the remaining {missing:,}, then 'build'.")
    else:
        print("Run 'build' next.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pastperfect", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command")

    p = subparsers.add_parser("ingest", help="harvest objects and images from the museums")
    p.add_argument("--museum", action="append", choices=config.MUSEUM_ORDER)
    p.add_argument("--target", type=int, help="objects to aim for per museum")
    p.set_defaults(func=cmd_ingest)

    p = subparsers.add_parser("images", help="fetch missing image derivatives")
    p.set_defaults(func=cmd_images)

    p = subparsers.add_parser("retag", help="recompute region and visual-age heuristics")
    p.set_defaults(func=cmd_retag)

    p = subparsers.add_parser("pairs", help="rebuild the question pool and daily sets")
    p.add_argument("--days", type=int, default=45)
    p.set_defaults(func=cmd_pairs)

    p = subparsers.add_parser("daily", help="precompute daily sets")
    p.add_argument("--days", type=int, default=45)
    p.set_defaults(func=cmd_daily)

    p = subparsers.add_parser("cards", help="render OpenGraph share cards")
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_cards)

    p = subparsers.add_parser("build", help="pairs + daily sets + cards + checks")
    p.add_argument("--days", type=int, default=45)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_build)

    p = subparsers.add_parser("serve", help="run the site on localhost")
    p.add_argument("--host", default=config.HOST)
    p.add_argument("--port", type=int, default=config.PORT)
    p.set_defaults(func=cmd_serve)

    p = subparsers.add_parser("stats", help="what is in the database")
    p.set_defaults(func=cmd_stats)

    p = subparsers.add_parser("doctor", help="check every answer is provable")
    p.set_defaults(func=cmd_doctor)

    p = subparsers.add_parser("export-seed", help="write objects.json for offline rebuilds")
    p.set_defaults(func=cmd_export_seed)

    p = subparsers.add_parser("import-seed", help="rebuild the database from objects.json")
    p.set_defaults(func=cmd_import_seed)

    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    db.init()
    return args.func(args)
