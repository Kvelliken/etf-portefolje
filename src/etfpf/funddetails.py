"""Risk figures per fund from Nordnet: volatility, Sharpe, alpha, beta (NOK) and R² (Morningstar).

Nordnet's fund list has no risk figures, so they are fetched per fund from two sources:

* `api/2/instruments/<id>/fund/info` (small JSON, no login): `risk_statistics` with standard deviation,
  Sharpe ratio, alpha and beta for 1, 3 and 5 years. These are **in NOK** (verified 2026-11: DNB
  Likviditet A has 0.22 % volatility, the SEK money market fund Carnegie Likviditetsfond 6.4 %; Sharpe 1 år
  for KLP AksjeGlobal Indeks −0.12 matches its NOK return 2.7 % minus NOK risk-free rate over 13 %
  volatility). Alpha/beta are missing for funds without a benchmark (mostly money market and bond funds).
* The fund page (`fond/liste/<slug>`, ~1 MB HTML): `risksStatistics` with the same figures plus R² and
  tracking error, as shown on Nordnet's page. These are Morningstar figures **in SEK** (a NOK money market
  fund shows 6.3 % volatility there, a SEK one 0.2 %), so only R² and tracking error are used from here.

Both are stored as raw JSON in the table `fund_details` in data/fond.db (one row per fund, latest fetch).
Funds fetched within `refresh_days` are skipped, so an interrupted run can simply be restarted.
"""
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone

import requests

from .nordnet import HEADERS

log = logging.getLogger(__name__)

API_URL = "https://www.nordnet.no/api/2/instruments/{iid}/fund/info"
PAGE_URL = "https://www.nordnet.no/fond/liste/{slug}"
API_HEADERS = dict(HEADERS, **{"client-id": "NEXT", "Accept": "application/json"})
PERIODS = (1, 3, 5)
PAGE_KEYS = {1: "oneYear", 3: "threeYears", 5: "fiveYears"}
# Parts of the API answer that are kept (holdings and allocations are large and not used).
API_KEEP = ("risk_statistics", "morningstar_info", "inception_date", "is_index_fund", "fund_category_name")

SCHEMA = """
CREATE TABLE IF NOT EXISTS fund_details(
    instrument_id INTEGER PRIMARY KEY, isin TEXT, slug TEXT, fetched_at TEXT,
    api_status INTEGER, api_json TEXT, page_status INTEGER, page_json TEXT);
"""

_RISK_RE = re.compile(r'\\?"risksStatistics\\?"\s*:\s*')


def connect(conn):
    conn.executescript(SCHEMA)
    return conn


def parse_page_risk(html):
    """`risksStatistics` object from a fund page (escaped JSON inside a script), or None."""
    m = _RISK_RE.search(html)
    if not m:
        return None
    # The state is a JS string literal: inside it quotes are written \" . Take a generous window,
    # unescape it and let the JSON decoder find the end of the object.
    chunk = html[m.end():m.end() + 4000]
    if chunk.startswith("{\\"):
        chunk = chunk.replace('\\\\"', "\0").replace('\\"', '"').replace("\0", '\\"')
    try:
        obj, _ = json.JSONDecoder().raw_decode(chunk)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _get(session, url, headers, timeout, retries, sleep):
    """GET with retries. Returns (status, text); status 0 if every attempt failed on the network."""
    status = 0
    for attempt in range(retries):
        try:
            r = session.get(url, headers=headers, timeout=timeout)
            status = r.status_code
            if status == 200:
                return status, r.text
            if status == 404:
                return status, None
            wait = 30 * (attempt + 1) if status == 429 else 5 * 2 ** attempt
        except requests.RequestException as e:
            log.warning("%s: %s", url, e)
            wait = 5 * 2 ** attempt
        sleep(wait)
    return status, None


def fetch_api(session, iid, cfg, sleep=time.sleep):
    status, text = _get(session, API_URL.format(iid=iid), API_HEADERS, cfg["timeout_seconds"], cfg["retries"], sleep)
    if text is None:
        return status, None
    try:
        data = json.loads(text)
    except ValueError:
        return -1, None
    d = data[0] if isinstance(data, list) and data else data if isinstance(data, dict) else {}
    return status, {k: d.get(k) for k in API_KEEP if k in d}


def fetch_page(session, slug, cfg, sleep=time.sleep):
    status, text = _get(session, PAGE_URL.format(slug=slug), HEADERS, cfg["timeout_seconds"], cfg["retries"], sleep)
    if text is None:
        return status, None
    risk = parse_page_risk(text)
    return (status if risk is not None else -1), risk


def funds_to_fetch(conn, refresh_days, now=None):
    """Active funds (instrument_id, isin, slug) whose details are missing or older than refresh_days."""
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=refresh_days)).isoformat(timespec="seconds")
    rows = conn.execute("""
        SELECT m.instrument_id, m.isin, s.raw_json, d.fetched_at, d.api_status, d.page_status
        FROM etf_master m
        JOIN etf_snapshot s ON s.instrument_id = m.instrument_id
          AND s.run_id = (SELECT MAX(run_id) FROM etf_snapshot WHERE instrument_id = m.instrument_id)
        LEFT JOIN fund_details d ON d.instrument_id = m.instrument_id
        WHERE m.active = 1 ORDER BY m.number_of_owners DESC""").fetchall()
    out = []
    for iid, isin, raw, fetched, api_st, page_st in rows:
        fresh = fetched and fetched >= cutoff and api_st == 200 and page_st in (200, 404, -1)
        if fresh:
            continue
        slug = ((json.loads(raw) if raw else {}).get("nnx_info") or {}).get("display_slug")
        out.append((iid, isin, slug))
    return out


def fetch_all(conn, cfg, limit=0, pages=True, sleep=time.sleep, session=None, progress_every=50):
    """Fetch details for every fund that needs it. Commits after each fund. Returns counts."""
    connect(conn)
    todo = funds_to_fetch(conn, cfg.get("refresh_days", 20))
    if limit:
        todo = todo[:limit]
    s = session or requests.Session()
    n = {"todo": len(todo), "api_ok": 0, "page_ok": 0}
    log.info("Henter risikotall for %d fond%s ...", len(todo), " (API + fondsside)" if pages else " (bare API)")
    for k, (iid, isin, slug) in enumerate(todo, 1):
        api_st, api = fetch_api(s, iid, cfg, sleep)
        sleep(cfg["delay_seconds"])
        page_st, page = (None, None)
        if pages and slug:
            page_st, page = fetch_page(s, slug, cfg, sleep)
            sleep(cfg["delay_seconds"])
        n["api_ok"] += api_st == 200
        n["page_ok"] += page_st == 200
        conn.execute("INSERT OR REPLACE INTO fund_details VALUES (?,?,?,?,?,?,?,?)",
                     (iid, isin, slug, datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      api_st, json.dumps(api, ensure_ascii=False) if api is not None else None,
                      page_st, json.dumps(page, ensure_ascii=False) if page is not None else None))
        conn.commit()
        if k % progress_every == 0 or k == len(todo):
            log.info("  %d/%d (API ok %d, side ok %d)", k, len(todo), n["api_ok"], n["page_ok"])
    return n


# ---------------------------------------------------------------- to site data

def _num(x, scale=1.0, nd=4):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return round(v * scale, nd) if v == v else None


def risk_fields(api, page):
    """Per period P in (1, 3, 5): vol{P}, sharpe{P}, alpha{P}, beta{P} (NOK, from the API) and
    r2{P}, te{P} (Morningstar on the fund page, SEK). Volatility, alpha, R² and TE as fractions."""
    rs = (api or {}).get("risk_statistics") or {}
    out = {}
    for P in PERIODS:
        pg = (page or {}).get(PAGE_KEYS[P]) or {}
        out[f"vol{P}"] = _num(rs.get(f"standard_deviation_y{P}"), 0.01, 6)
        out[f"sharpe{P}"] = _num(rs.get(f"sharpe_ratio_y{P}"), 1, 3)
        out[f"alpha{P}"] = _num(rs.get(f"alpha_y{P}"), 0.01, 6)
        out[f"beta{P}"] = _num(rs.get(f"beta_y{P}"), 1, 3)
        out[f"r2{P}"] = _num(pg.get("r2"), 0.01, 4)
        out[f"te{P}"] = _num(pg.get("trackingError"), 0.01, 5)
    return out


def load_details(conn):
    """{instrument_id: (api dict | None, page dict | None, fetched_at)} for funds with stored details."""
    have = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='fund_details'").fetchone()
    if not have:
        return {}
    out = {}
    for iid, api, page, fetched in conn.execute("SELECT instrument_id, api_json, page_json, fetched_at FROM fund_details"):
        out[iid] = (json.loads(api) if api else None, json.loads(page) if page else None, fetched)
    return out
