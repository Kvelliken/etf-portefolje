"""What each fund and ETF actually owns: region, sector and asset allocation plus the largest holdings.

Source: Nordnet's `api/2/instruments/<id>/fund/info` (no login; works for both funds and ETFs). It gives
`regional_allocation`, `sector_allocation`, `asset_allocation` (percent, Morningstar) and
`instrument_underlying_info`: up to 25 of the largest holdings as Nordnet instrument ids with weights.
The ids are turned into names with `api/2/instruments/<id,id,...>`. Holdings Nordnet has no instrument for
(most bonds, some foreign shares) are simply missing from the list, so the holdings are a lower bound.

Everything is stored in data/holdings.db (tables `holdings` and `holding_names`), one row per instrument,
latest fetch. Instruments fetched within `refresh_days` are skipped, so an interrupted run can be restarted.
`export` writes site/data/innhold.json for the portfolio page.
"""
import json
import logging
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

from .funddetails import API_HEADERS, API_URL
from .sitedata import write_json

log = logging.getLogger(__name__)

NAMES_URL = "https://www.nordnet.no/api/2/instruments/{ids}"
MIN_WEIGHT = 0.05          # percent; smaller allocation slices are dropped

SCHEMA = """
CREATE TABLE IF NOT EXISTS holdings(
    isin TEXT PRIMARY KEY, kind TEXT, instrument_id INTEGER, fetched_at TEXT, status INTEGER, json TEXT);
CREATE TABLE IF NOT EXISTS holding_names(
    instrument_id INTEGER PRIMARY KEY, name TEXT, isin TEXT, symbol TEXT, fetched_at TEXT);
"""


def connect(path):
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    return conn


def _alloc(rows):
    """[{type, weight}, ...] -> {type: weight} for slices of at least MIN_WEIGHT percent."""
    out = {}
    for r in rows or []:
        try:
            w = float(r.get("weight"))
        except (TypeError, ValueError):
            continue
        name = r.get("type")
        if name and w == w and abs(w) >= MIN_WEIGHT:
            out[name] = round(out.get(name, 0.0) + w, 2)
    return out


def compact(api):
    """The parts of a fund/info answer the site uses, or None if it has no allocation at all."""
    if not isinstance(api, dict):
        return None
    top = []
    for h in api.get("instrument_underlying_info") or []:
        try:
            iid, w = int(h["instrument_id"]), float(h["weight"])
        except (KeyError, TypeError, ValueError):
            continue
        if w == w and w > 0:
            top.append([iid, round(w, 2)])
    top.sort(key=lambda x: -x[1])
    out = {"reg": _alloc(api.get("regional_allocation")), "sec": _alloc(api.get("sector_allocation")),
           "ast": _alloc(api.get("asset_allocation")), "top": top,
           "date": (api.get("morningstar_info") or {}).get("release_top_holding_date")}
    return out if (out["reg"] or out["sec"] or out["ast"] or top) else None


def instruments(conn, kind):
    """(isin, kind, instrument_id) for active instruments in an ETF or fund database, most owners first."""
    rows = conn.execute("""SELECT isin, instrument_id FROM etf_master
                           WHERE active = 1 AND isin IS NOT NULL ORDER BY number_of_owners DESC""").fetchall()
    seen, out = set(), []
    for isin, iid in rows:
        if isin not in seen:
            seen.add(isin)
            out.append((isin, kind, iid))
    return out


def to_fetch(hconn, items, refresh_days, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=refresh_days)).isoformat(timespec="seconds")
    fresh = {r[0] for r in hconn.execute(
        "SELECT isin FROM holdings WHERE fetched_at >= ? AND status IN (200, 404)", (cutoff,))}
    return [it for it in items if it[0] not in fresh]


def _get_json(session, url, cfg, sleep):
    status = 0
    for attempt in range(cfg["retries"]):
        try:
            r = session.get(url, headers=API_HEADERS, timeout=cfg["timeout_seconds"])
            status = r.status_code
            if status == 200:
                return status, r.json()
            if status in (204, 404):
                return 404, None
            wait = 30 * (attempt + 1) if status == 429 else 5 * 2 ** attempt
        except (requests.RequestException, ValueError) as e:
            log.warning("%s: %s", url, e)
            wait = 5 * 2 ** attempt
        sleep(wait)
    return status, None


def fetch_one(session, iid, cfg, sleep=time.sleep):
    status, data = _get_json(session, API_URL.format(iid=iid), cfg, sleep)
    d = data[0] if isinstance(data, list) and data else data if isinstance(data, dict) else None
    return status, compact(d)


def fetch_all(hconn, items, cfg, limit=0, sleep=time.sleep, session=None, progress_every=200):
    """Fetch allocations and holdings for `items` [(isin, kind, instrument_id)] that need it."""
    todo = to_fetch(hconn, items, cfg.get("refresh_days", 20))
    if limit:
        todo = todo[:limit]
    s = session or requests.Session()
    n = {"todo": len(todo), "ok": 0}
    log.info("Henter innhold (beholdninger og fordeling) for %d fond/ETF-er ...", len(todo))

    def work(it):
        res = fetch_one(s, it[2], cfg, sleep)
        sleep(cfg["delay_seconds"])
        return it, res

    with ThreadPoolExecutor(max_workers=max(1, int(cfg.get("threads", 1)))) as ex:
        for k, ((isin, kind, iid), (status, comp)) in enumerate(ex.map(work, todo), 1):
            n["ok"] += status == 200
            hconn.execute("INSERT OR REPLACE INTO holdings VALUES (?,?,?,?,?,?)",
                          (isin, kind, iid, datetime.now(timezone.utc).isoformat(timespec="seconds"), status,
                           json.dumps(comp, ensure_ascii=False, separators=(",", ":")) if comp else None))
            if k % 25 == 0 or k == len(todo):
                hconn.commit()
            if k % progress_every == 0 or k == len(todo):
                log.info("  %d/%d (ok %d)", k, len(todo), n["ok"])
    hconn.commit()
    return n


def missing_names(hconn):
    have = {r[0] for r in hconn.execute("SELECT instrument_id FROM holding_names")}
    want = set()
    for (js,) in hconn.execute("SELECT json FROM holdings WHERE json IS NOT NULL"):
        want.update(h[0] for h in json.loads(js).get("top", []))
    return sorted(want - have)


def fetch_names(hconn, cfg, batch=40, sleep=time.sleep, session=None):
    """Names for holdings that are not known yet. Ids Nordnet does not answer for get an empty name."""
    ids = missing_names(hconn)
    s = session or requests.Session()
    log.info("Slår opp navn på %d beholdninger ...", len(ids))
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    found = 0
    for k in range(0, len(ids), batch):
        chunk = ids[k:k + batch]
        status, data = _get_json(s, NAMES_URL.format(ids=",".join(map(str, chunk))), cfg, sleep)
        got = {}
        for d in data if isinstance(data, list) else []:
            if isinstance(d, dict) and d.get("instrument_id") is not None:
                got[int(d["instrument_id"])] = d
        if status != 200 and not got:
            sleep(cfg["delay_seconds"])
            continue                                   # try again next run
        for iid in chunk:
            d = got.get(iid) or {}
            hconn.execute("INSERT OR REPLACE INTO holding_names VALUES (?,?,?,?,?)",
                          (iid, d.get("name"), d.get("isin_code"), d.get("symbol"), now))
            found += bool(d.get("name"))
        hconn.commit()
        sleep(cfg["delay_seconds"])
    return {"asked": len(ids), "found": found}


# ---------------------------------------------------------------- to site data

def export(hconn, out_dir):
    """Write innhold.json: {names: {id: [name, country]}, items: {isin: {reg, sec, ast, top, date}}}.
    Holdings without a name are dropped (their weight is still missing from `top`, i.e. a lower bound)."""
    names = {iid: (name, (isin or "")[:2]) for iid, name, isin in
             hconn.execute("SELECT instrument_id, name, isin FROM holding_names WHERE name IS NOT NULL AND name != ''")}
    items, used = {}, set()
    for isin, js in hconn.execute("SELECT isin, json FROM holdings WHERE json IS NOT NULL ORDER BY isin"):
        d = json.loads(js)
        d["top"] = [h for h in d.get("top", []) if h[0] in names]
        used.update(h[0] for h in d["top"])
        items[isin] = d
    fetched = hconn.execute("SELECT MAX(fetched_at) FROM holdings").fetchone()[0]
    write_json(out_dir / "innhold.json", {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fetched": fetched[:10] if fetched else None, "n": len(items),
        "names": {str(i): list(names[i]) for i in sorted(used)}, "items": items})
    return {"n": len(items), "n_names": len(used), "n_top": sum(bool(d["top"]) for d in items.values())}
