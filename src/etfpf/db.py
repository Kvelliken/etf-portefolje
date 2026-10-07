"""SQLite schema, storage of Nordnet runs and monthly diff."""
import sqlite3
from datetime import datetime, timezone

# Columns stored per ETF in both etf_master (latest value) and etf_snapshot (per run).
DATA_COLS = ["isin", "symbol", "name", "long_name", "currency", "price_unit", "clearing_place",
             "issuer_name", "instrument_type", "instrument_group_type", "is_tradable",
             "is_monthly_saveable", "is_shortable", "category", "fee", "number_of_owners",
             "dividend_policy", "risk", "rating", "fund_size", "replication", "index_name",
             "domicile", "ask_eligible"]
SNAPSHOT_ONLY = ["price", "yield_1y", "yield_3y", "yield_5y", "raw_json"]
# Fields whose changes are logged in `changes`.
TRACKED = ["isin", "symbol", "name", "currency", "clearing_place", "issuer_name", "category",
           "fee", "dividend_policy", "is_tradable"]

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS runs(
    run_id INTEGER PRIMARY KEY AUTOINCREMENT, run_at TEXT, total_hits INTEGER, n_found INTEGER,
    partial INTEGER DEFAULT 0, n_new INTEGER, n_gone INTEGER, n_reappeared INTEGER, n_changed INTEGER);
CREATE TABLE IF NOT EXISTS etf_master(
    instrument_id INTEGER PRIMARY KEY, {", ".join(c + " " + ("REAL" if c in ("fee", "number_of_owners", "fund_size", "rating") else "TEXT") for c in DATA_COLS)},
    first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1, delisted_at TEXT);
CREATE TABLE IF NOT EXISTS etf_snapshot(
    run_id INTEGER, instrument_id INTEGER, {", ".join(c for c in DATA_COLS + SNAPSHOT_ONLY)},
    PRIMARY KEY(run_id, instrument_id));
CREATE TABLE IF NOT EXISTS changes(
    run_id INTEGER, instrument_id INTEGER, change TEXT, field TEXT, old TEXT, new TEXT);
CREATE INDEX IF NOT EXISTS idx_master_isin ON etf_master(isin);
CREATE INDEX IF NOT EXISTS idx_changes_run ON changes(run_id);
"""


class SafetyCheckError(RuntimeError):
    """Raised when a run looks broken; nothing is written."""


def connect(path):
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn):
    """Add columns that older databases (e.g. from nordnet_etf.py) lack."""
    have = {r[1] for r in conn.execute("PRAGMA table_info(etf_master)")}
    for c in DATA_COLS:
        if c not in have:
            conn.execute(f"ALTER TABLE etf_master ADD COLUMN {c}")
    have = {r[1] for r in conn.execute("PRAGMA table_info(runs)")}
    for c in ["partial", "n_new", "n_gone", "n_reappeared", "n_changed"]:
        if c not in have:
            conn.execute(f"ALTER TABLE runs ADD COLUMN {c}")
    conn.commit()


def _norm(v):
    """Compare values as text so 0.2 vs '0.2' or 1 vs True do not register as changes."""
    if v is None:
        return None
    if isinstance(v, bool):
        v = int(v)
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v)


def check_safety(conn, n_found, partial, min_fraction):
    if n_found == 0:
        raise SafetyCheckError("0 ETF-er parset. Nordnet-siden har sannsynligvis endret seg.")
    prior = conn.execute("SELECT COUNT(*) FROM etf_master WHERE active=1").fetchone()[0]
    if prior and not partial and n_found < min_fraction * prior:
        raise SafetyCheckError(
            f"Fant bare {n_found} ETF-er mot {prior} aktive sist (< {min_fraction:.0%}). "
            "Siden har sannsynligvis endret seg. Ingenting er lagret.")


def store(conn, found, total, partial, min_fraction=0.9, now=None):
    """Store a run atomically. Returns a summary dict. Raises SafetyCheckError."""
    check_safety(conn, len(found), partial, min_fraction)
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    cols = DATA_COLS
    existing = {r[0]: dict(zip(["instrument_id"] + cols + ["active"], r)) for r in conn.execute(
        f"SELECT instrument_id, {', '.join(cols)}, active FROM etf_master")}
    new_ids, back_ids, gone_ids, changed = [], [], [], 0
    with conn:  # one transaction
        run_id = conn.execute("INSERT INTO runs(run_at,total_hits,n_found,partial) VALUES(?,?,?,?)",
                              (now, total, len(found), int(partial))).lastrowid
        log_change = lambda iid, ch, f=None, o=None, n=None: conn.execute(
            "INSERT INTO changes VALUES(?,?,?,?,?,?)", (run_id, iid, ch, f, o, n))
        for iid, r in found.items():
            vals = [r.get(c) for c in cols]
            conn.execute(
                f"INSERT INTO etf_snapshot(run_id, instrument_id, {', '.join(cols + SNAPSHOT_ONLY)}) "
                f"VALUES({', '.join('?' * (len(cols) + len(SNAPSHOT_ONLY) + 2))})",
                [run_id, iid] + vals + [r.get(c) for c in SNAPSHOT_ONLY])
            if iid not in existing:
                conn.execute(
                    f"INSERT INTO etf_master(instrument_id, {', '.join(cols)}, first_seen, last_seen, active) "
                    f"VALUES(?, {', '.join('?' * len(cols))}, ?, ?, 1)", [iid] + vals + [now, now])
                log_change(iid, "new", None, None, r.get("name"))
                new_ids.append(iid)
                continue
            old = existing[iid]
            for f in TRACKED:
                if _norm(old[f]) != _norm(r.get(f)) and r.get(f) is not None:
                    log_change(iid, "changed", f, _norm(old[f]), _norm(r.get(f)))
                    changed += 1
            if not old["active"]:
                log_change(iid, "reappeared", None, None, r.get("name"))
                back_ids.append(iid)
            # Keep old value when the new run lacks a field (e.g. legacy parser).
            merged = [r.get(c) if r.get(c) is not None else old[c] for c in cols]
            conn.execute(
                f"UPDATE etf_master SET {', '.join(c + '=?' for c in cols)}, last_seen=?, active=1, "
                "delisted_at=NULL WHERE instrument_id=?", merged + [now, iid])
        if not partial:  # partial runs (--max-pages) never mark anything as gone
            for iid, old in existing.items():
                if old["active"] and iid not in found:
                    conn.execute("UPDATE etf_master SET active=0, delisted_at=? WHERE instrument_id=?", (now, iid))
                    log_change(iid, "gone", None, old["name"], None)
                    gone_ids.append(iid)
        conn.execute("UPDATE runs SET n_new=?, n_gone=?, n_reappeared=?, n_changed=? WHERE run_id=?",
                     (len(new_ids), len(gone_ids), len(back_ids), changed, run_id))
    return {"run_id": run_id, "new": new_ids, "gone": gone_ids, "reappeared": back_ids, "changed": changed}
