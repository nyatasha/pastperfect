/**
 * SQLite schema and access.
 *
 * Uses `node:sqlite`, which ships with the runtime, so there is no native
 * module to compile. It is still marked experimental, which is why every use of
 * it is confined to this file: swapping in better-sqlite3 means rewriting this
 * module and nothing else.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import * as config from "./config.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
    id              TEXT PRIMARY KEY,
    museum          TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    title           TEXT NOT NULL,
    artist          TEXT,
    artist_note     TEXT,
    date_display    TEXT NOT NULL,
    year_start      INTEGER NOT NULL,
    year_end        INTEGER NOT NULL,
    year_mid        INTEGER NOT NULL,
    date_precision  TEXT NOT NULL,
    medium          TEXT,
    classification  TEXT,
    culture         TEXT,
    department      TEXT,
    region          TEXT,
    credit_line     TEXT,
    object_url      TEXT NOT NULL,
    image_url       TEXT NOT NULL,
    image_key       TEXT NOT NULL UNIQUE,
    image_w         INTEGER,
    image_h         INTEGER,
    local_image     INTEGER NOT NULL DEFAULT 0,
    license_id      TEXT NOT NULL,
    license_label   TEXT NOT NULL,
    license_url     TEXT NOT NULL,
    rights_basis    TEXT NOT NULL,
    looks_modern    INTEGER NOT NULL DEFAULT 0,
    playable        INTEGER NOT NULL DEFAULT 1,
    exclude_reason  TEXT,
    ingested_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objects_museum ON objects(museum, playable);
CREATE INDEX IF NOT EXISTS idx_objects_year   ON objects(year_mid);

CREATE TABLE IF NOT EXISTS pairs (
    id              TEXT PRIMARY KEY,
    left_id         TEXT NOT NULL REFERENCES objects(id),
    right_id        TEXT NOT NULL REFERENCES objects(id),
    earlier         TEXT NOT NULL CHECK (earlier IN ('left', 'right')),
    guaranteed_gap  INTEGER NOT NULL,
    display_gap     INTEGER NOT NULL,
    approximate     INTEGER NOT NULL,
    difficulty      INTEGER NOT NULL,
    surprise        INTEGER NOT NULL,
    insight         TEXT NOT NULL,
    museums         TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairs_difficulty ON pairs(difficulty);
CREATE INDEX IF NOT EXISTS idx_pairs_museums    ON pairs(museums);

CREATE TABLE IF NOT EXISTS daily_sets (
    date        TEXT NOT NULL,
    edition     TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL,
    pair_id     TEXT NOT NULL REFERENCES pairs(id),
    flipped     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, edition, position)
);

CREATE TABLE IF NOT EXISTS daily_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    edition     TEXT NOT NULL DEFAULT '',
    session     TEXT NOT NULL,
    score       INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (date, edition, session)
);

-- Aggregate right/wrong counts so a question can honestly say how many
-- players got it. Nothing here identifies a player.
CREATE TABLE IF NOT EXISTS pair_stats (
    pair_id     TEXT PRIMARY KEY REFERENCES pairs(id),
    shown       INTEGER NOT NULL DEFAULT 0,
    correct     INTEGER NOT NULL DEFAULT 0
);

-- One row the first time a session answers a given pair. It keeps the
-- "how many players got this" figure honest and stops a reloaded page from
-- counting twice. No IP address, no cookie, no identity -- just a random id
-- the browser made up for itself.
CREATE TABLE IF NOT EXISTS answer_log (
    session     TEXT NOT NULL,
    pair_id     TEXT NOT NULL,
    correct     INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (session, pair_id)
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    session     TEXT NOT NULL,
    props       TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);

CREATE TABLE IF NOT EXISTS meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);
`;

export type Row = Record<string, unknown>;

/** What node:sqlite will bind. Named so call sites cast to something true. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** Widen an untyped row to bindable parameters at one audited point. */
export const params = (values: readonly unknown[]): SqlParam[] => values as SqlParam[];

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

export function connect(): DatabaseSync {
  if (handle && handlePath === config.paths.db) return handle;
  if (handle) handle.close();
  fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
  const db = new DatabaseSync(config.paths.db);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  handle = db;
  handlePath = config.paths.db;
  return db;
}

export function resetConnection(): void {
  if (handle) handle.close();
  handle = null;
  handlePath = null;
}

export function init(): DatabaseSync {
  const db = connect();
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = connect();
  db.exec("BEGIN");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function all<T = Row>(sql: string, paramsIn: unknown[] = []): T[] {
  return connect().prepare(sql).all(...params(paramsIn)) as T[];
}

export function get<T = Row>(sql: string, paramsIn: unknown[] = []): T | undefined {
  return connect().prepare(sql).get(...params(paramsIn)) as T | undefined;
}

export function run(sql: string, paramsIn: unknown[] = []): { changes: number } {
  const result = connect().prepare(sql).run(...params(paramsIn));
  return { changes: Number(result.changes) };
}

export function scalar(sql: string, paramsIn: unknown[] = []): number {
  const row = get<Record<string, number>>(sql, paramsIn);
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

export function setMeta(key: string, value: unknown): void {
  run(
    "INSERT INTO meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

export function getMeta<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export interface Counts {
  objects: number;
  playable: number;
  pairs: number;
  daily_days: number;
  results: number;
  events: number;
}

export function counts(): Counts {
  return {
    objects: scalar("SELECT COUNT(*) AS n FROM objects"),
    playable: scalar("SELECT COUNT(*) AS n FROM objects WHERE playable = 1"),
    pairs: scalar("SELECT COUNT(*) AS n FROM pairs"),
    daily_days: scalar("SELECT COUNT(DISTINCT date) AS n FROM daily_sets"),
    results: scalar("SELECT COUNT(*) AS n FROM daily_results"),
    events: scalar("SELECT COUNT(*) AS n FROM events"),
  };
}

export const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
