"""Harvest, normalise and store museum objects.

This is the only place that talks to the museums. Everything downstream -- the
pair builder, the daily sets, the web app -- reads the local database, which is
what the PRD means by precomputed content and low maintenance.
"""

from __future__ import annotations

import datetime as _dt
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

from . import config, dates, db, media, rights, taxonomy
from .sources import ADAPTERS
from .sources.base import BlockedError, RawObject

#: Sampling windows. Harvesting a quota per window rather than "the first N
#: results" is what gives the game a usable spread of centuries -- without it
#: every pair would be two 19th-century prints.
DATE_WINDOWS = [
    (-4000, 500), (500, 1200), (1200, 1450), (1450, 1600), (1600, 1700),
    (1700, 1800), (1800, 1860), (1860, 1900), (1900, 1940), (1940, 2000),
]

#: Roughly how many objects to aim for per museum. Rijksmuseum costs three HTTP
#: round trips per object, so it gets a smaller quota.
DEFAULT_TARGETS = {"met": 320, "aic": 400, "wellcome": 400, "rijksmuseum": 220}

COLUMNS = [
    "id", "museum", "source_id", "title", "artist", "artist_note", "date_display",
    "year_start", "year_end", "year_mid", "date_precision", "medium",
    "classification", "culture", "department", "region", "credit_line",
    "object_url", "image_url", "image_key", "image_w", "image_h", "local_image",
    "license_id", "license_label", "license_url", "rights_basis", "looks_modern",
    "playable", "exclude_reason", "ingested_at",
]


@dataclass
class MuseumReport:
    museum: str
    seen: int = 0
    stored: int = 0
    playable: int = 0
    excluded: dict[str, int] = field(default_factory=dict)
    error: str | None = None

    def exclude(self, reason: str) -> None:
        key = reason.split("(")[0].strip()
        self.excluded[key] = self.excluded.get(key, 0) + 1


def normalise(raw: RawObject) -> dict:
    """Apply the date logic, the rights gate and the offline taxonomy."""
    now = _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")
    estimate = dates.estimate(raw.date_display, raw.year_start, raw.year_end)
    allowed, reason, licence = rights.evaluate(raw.licence_raw, raw.rights_basis)

    playable = True
    exclude_reason = None
    if not allowed:
        playable, exclude_reason = False, reason
    elif estimate is None:
        playable, exclude_reason = False, f"no usable date ('{raw.date_display or 'absent'}')"
    elif not estimate.playable():
        playable, exclude_reason = False, (
            f"date range too wide or out of bounds ({estimate.start}-{estimate.end})"
        )

    context = (raw.medium, raw.classification, raw.title, raw.department)
    return {
        "id": raw.id,
        "museum": raw.museum,
        "source_id": raw.source_id,
        "title": raw.title,
        "artist": raw.artist,
        "artist_note": raw.artist_note,
        "date_display": raw.date_display or (estimate.display if estimate else ""),
        "year_start": estimate.start if estimate else 0,
        "year_end": estimate.end if estimate else 0,
        "year_mid": estimate.midpoint if estimate else 0,
        "date_precision": estimate.precision if estimate else "unknown",
        "medium": raw.medium,
        "classification": raw.classification,
        "culture": raw.culture,
        "department": raw.department,
        "region": taxonomy.region_for(raw.culture, raw.department, raw.title, raw.artist_note),
        "credit_line": raw.credit_line,
        "object_url": raw.object_url,
        "image_url": raw.image_url,
        "image_key": media.image_key(raw.id),
        "image_w": None,
        "image_h": None,
        "local_image": 0,
        "license_id": licence.get("license_id", ""),
        "license_label": licence.get("license_label", ""),
        "license_url": licence.get("license_url", ""),
        "rights_basis": licence.get("rights_basis", raw.rights_basis),
        "looks_modern": int(taxonomy.reads_modern(*context)),
        "playable": int(playable),
        "exclude_reason": exclude_reason,
        "ingested_at": now,
    }


def store(rows: list[dict]) -> int:
    if not rows:
        return 0
    placeholders = ", ".join("?" for _ in COLUMNS)
    updates = ", ".join(
        f"{c} = excluded.{c}" for c in COLUMNS
        if c not in ("id", "image_w", "image_h", "local_image")
    )
    sql = (
        f"INSERT INTO objects ({', '.join(COLUMNS)}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}"
    )
    with db.write() as conn:
        conn.executemany(sql, [[row[c] for c in COLUMNS] for row in rows])
    return len(rows)


def harvest_museum(slug: str, target: int) -> tuple[list[dict], MuseumReport]:
    """Harvest one museum, keeping whatever it managed to hand over.

    A museum that starts refusing requests mid-run is a normal Tuesday for a
    free public API, so a block ends that museum's harvest and leaves the rest
    of the run -- and everything already collected -- untouched.
    """
    adapter = ADAPTERS[slug]
    per_window = max(1, -(-target // len(DATE_WINDOWS)))
    report = MuseumReport(museum=slug)
    rows: dict[str, dict] = {}
    try:
        for raw in adapter.harvest(DATE_WINDOWS, per_window):
            report.seen += 1
            row = normalise(raw)
            if row["exclude_reason"]:
                report.exclude(row["exclude_reason"])
            rows[row["id"]] = row
    except BlockedError as exc:
        report.error = f"stopped early: {exc}"
    except Exception as exc:  # noqa: BLE001 - one museum must not fail the run
        report.error = f"stopped early: {type(exc).__name__}: {exc}"
    ordered = list(rows.values())
    report.stored = len(ordered)
    report.playable = sum(r["playable"] for r in ordered)
    return ordered, report


def fetch_images(rows: list[dict] | None = None, workers: int | None = None) -> int:
    """Download derivatives for every playable object that lacks one."""
    conn = db.connect()
    if rows is None:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT id, image_key, image_url FROM objects "
                "WHERE playable = 1 AND local_image = 0"
            )
        ]
    if not rows:
        return 0

    def work(row: dict):
        try:
            size = media.ensure(row["image_key"], row["image_url"])
        except Exception:  # noqa: BLE001 - a dead image must not stop the batch
            size = None
        return row["id"], size

    done = 0
    updates: list[tuple] = []
    with ThreadPoolExecutor(max_workers=workers or config.INGEST_WORKERS) as pool:
        for object_id, size in pool.map(work, rows):
            if size is None:
                updates.append((0, None, None, 0, "image could not be fetched", object_id))
            else:
                updates.append((1, size[0], size[1], 1, None, object_id))
                done += 1
    with db.write() as conn:
        conn.executemany(
            "UPDATE objects SET local_image = ?, image_w = ?, image_h = ?, "
            "playable = ?, exclude_reason = COALESCE(?, exclude_reason) WHERE id = ?",
            updates,
        )
    return done


def run(museums: list[str] | None = None, targets: dict | None = None, log=print) -> dict:
    db.init()
    slugs = museums or config.MUSEUM_ORDER
    quotas = {**DEFAULT_TARGETS, **(targets or {})}
    reports: dict[str, MuseumReport] = {}

    log(f"Harvesting {', '.join(slugs)} ...")
    with ThreadPoolExecutor(max_workers=len(slugs)) as pool:
        futures = {
            pool.submit(harvest_museum, slug, quotas.get(slug, 250)): slug for slug in slugs
        }
        # Store each museum's rows as it finishes, so a slow or blocked source
        # never costs us the work another source already completed.
        for future in as_completed(futures):
            slug = futures[future]
            rows, report = future.result()
            store(rows)
            reports[slug] = report
            log(
                f"  {config.museum_name(slug):38} {report.playable:4d} playable "
                f"of {report.stored:4d} stored"
            )
            if report.error:
                log(f"      ! {report.error}")
            for reason, count in sorted(report.excluded.items(), key=lambda kv: -kv[1]):
                log(f"      excluded {count:4d}  {reason}")

    log("Fetching images ...")
    fetched = fetch_images()
    log(f"  {fetched} image derivatives on disk ({media.disk_usage() / 1e6:.1f} MB)")

    db.set_meta("last_ingest", _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds"))
    db.set_meta(
        "ingest_report",
        {s: {"stored": r.stored, "playable": r.playable, "excluded": r.excluded,
             "error": r.error}
         for s, r in reports.items()},
    )
    return db.counts()
