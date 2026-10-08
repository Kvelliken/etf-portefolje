"""ISIN -> Yahoo ticker.

Candidates per ISIN come from three sources:
  1. Nordnet: market_info.identifier/symbol + exchange from nnx_info.display_slug (xeta -> .DE)
  2. Yahoo search on the ISIN
  3. OpenFIGI (ISIN lookup; exchCode -> Yahoo suffix)
Each candidate is probed with a cheap monthly chart call. The candidate with the most months
of prices (longest and most complete history) whose last price is recent wins. All candidates
are stored in `ticker_map` with `chosen=1` on the winner, so the lookup is not repeated monthly.
"""
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests

from .yahoo import YahooError

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ticker_map(
    isin TEXT, yahoo_ticker TEXT, source TEXT, verified_at TEXT, ok INTEGER, chosen INTEGER DEFAULT 0,
    currency TEXT, exchange TEXT, yahoo_name TEXT, first_date TEXT, last_date TEXT, n_months INTEGER,
    error TEXT, PRIMARY KEY(isin, yahoo_ticker));
CREATE INDEX IF NOT EXISTS idx_ticker_map_chosen ON ticker_map(chosen, isin);
"""


def ensure_schema(conn):
    conn.executescript(SCHEMA)


# ---------------------------------------------------------------- candidates

def yahoo_symbol(symbol, suffix):
    """Nordnet/Bloomberg symbol -> Yahoo symbol ('XACT OMXS30', '.ST' -> 'XACT-OMXS30.ST')."""
    s = symbol.strip().upper().replace(" ", "-").replace("/", "-")
    return s + suffix if s else None


def nordnet_candidates(raw, suffix_map):
    """Candidates from one Nordnet row (raw JSON dict)."""
    slug = ((raw.get("nnx_info") or {}).get("display_slug") or "")
    exch = slug.rsplit("-", 1)[-1].lower() if "-" in slug else ""
    suffix = suffix_map.get(exch)
    if suffix is None:
        return []
    out = []
    for sym in ((raw.get("market_info") or {}).get("identifier"),
                (raw.get("instrument_info") or {}).get("symbol")):
        t = yahoo_symbol(sym or "", suffix)
        if t and t not in out:
            out.append(t)
    return out


def figi_candidates(items, suffix_map, per_suffix=2):
    """Candidates from OpenFIGI `data` items, ordered by the priority of figi_suffix.
    At most `per_suffix` tickers per Yahoo suffix (OpenFIGI lists many dead composite codes)."""
    order = list(suffix_map)
    found = []
    for n, it in enumerate(items or []):
        code, tick = it.get("exchCode"), it.get("ticker")
        if code in suffix_map and tick:
            found.append((order.index(code), n, yahoo_symbol(tick, suffix_map[code])))
    out, per = [], {}
    for _, _, t in sorted(found):
        suf = t.rsplit(".", 1)[-1]
        if t not in out and per.get(suf, 0) < per_suffix:
            out.append(t)
            per[suf] = per.get(suf, 0) + 1
    return out


def yahoo_search_candidates(quotes, isin=None):
    """Symbols from a Yahoo search on an ISIN. Funds/ETFs only; skip plain US symbols."""
    out = []
    for q in quotes:
        sym = q.get("symbol")
        if not sym or q.get("quoteType") not in ("ETF", "MUTUALFUND", "EQUITY"):
            continue
        if sym not in out:
            out.append(sym)
    return out


def openfigi_lookup(isins, cfg, post=None, sleep=time.sleep):
    """{isin: [data items]} via OpenFIGI. Respects the rate limit; failures give []."""
    key = os.environ.get("OPENFIGI_API_KEY")
    batch = 100 if key else cfg.get("openfigi_batch", 10)
    delay = 0.3 if key else cfg.get("openfigi_delay_seconds", 2.6)
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-OPENFIGI-APIKEY"] = key
    post = post or (lambda body: requests.post(cfg["openfigi_url"], json=body, headers=headers, timeout=60))
    out = {}
    isins = list(isins)
    for i in range(0, len(isins), batch):
        chunk = isins[i:i + batch]
        body = [{"idType": "ID_ISIN", "idValue": x} for x in chunk]
        for attempt in range(5):
            try:
                r = post(body)
                if r.status_code == 429:
                    sleep(min(60, 10 * (attempt + 1)))
                    continue
                r.raise_for_status()
                for isin, res in zip(chunk, r.json()):
                    out[isin] = res.get("data") or []
                break
            except (requests.RequestException, ValueError) as e:
                log.warning("OpenFIGI feil (%s), prøver igjen", e)
                sleep(5 * (attempt + 1))
        else:
            log.warning("OpenFIGI ga opp for %d ISIN-er", len(chunk))
        if (i // batch) % 10 == 0:
            log.info("OpenFIGI: %d/%d ISIN-er", min(i + batch, len(isins)), len(isins))
        sleep(delay)
    return out


# ---------------------------------------------------------------- probing

def probe(yahoo, ticker):
    """Cheap check of a ticker: monthly bars for the whole history."""
    try:
        res = yahoo.chart(ticker, range="max", interval="1mo", events="")
    except YahooError as e:
        return {"ok": 0, "error": str(e)[:200]}
    if not res:
        return {"ok": 0, "error": "ingen data"}
    meta = res.get("meta") or {}
    quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    pts = [t for t, c in zip(res.get("timestamp") or [], quote.get("close") or []) if c]
    if not pts:
        return {"ok": 0, "error": "ingen kurser", "currency": meta.get("currency")}
    d = lambda t: datetime.fromtimestamp(t, tz=timezone.utc).date()
    last = meta.get("regularMarketTime") or pts[-1]
    # Yahoo may return daily bars for short histories despite interval=1mo: count distinct months.
    months = {(d(t).year, d(t).month) for t in pts}
    return {"ok": 1, "currency": meta.get("currency"), "exchange": meta.get("fullExchangeName"),
            "yahoo_name": meta.get("longName") or meta.get("shortName"), "first_date": d(pts[0]).isoformat(),
            "last_date": d(max(last, pts[-1])).isoformat(), "n_months": len(months), "error": None}


def choose(probes, today=None, max_stale_days=30):
    """Pick the best candidate: recent last price, then most months, then source priority
    (candidates are passed in priority order)."""
    today = today or date.today()
    best, best_key = None, None
    for i, (ticker, p) in enumerate(probes):
        if not p.get("ok"):
            continue
        if date.fromisoformat(p["last_date"]) < today - timedelta(days=max_stale_days):
            p["ok"], p["error"] = 0, f"utdatert (siste {p['last_date']})"
            continue
        key = (p["n_months"], -i)
        if best_key is None or key > best_key:
            best, best_key = ticker, key
    return best


# ---------------------------------------------------------------- orchestration

def isins_to_map(conn, recheck_days, force=False, today=None):
    """Active ISINs without a valid chosen ticker, or whose mapping is older than recheck_days."""
    ensure_schema(conn)
    today = today or date.today()
    cutoff = (today - timedelta(days=recheck_days)).isoformat()
    active = [r[0] for r in conn.execute(
        "SELECT DISTINCT isin FROM etf_master WHERE active=1 AND isin IS NOT NULL ORDER BY isin")]
    if force:
        return active
    good = {r[0] for r in conn.execute(
        "SELECT isin FROM ticker_map WHERE chosen=1 AND ok=1 AND verified_at >= ?", (cutoff,))}
    return [i for i in active if i not in good]


def nordnet_rows(conn, isins):
    """{isin: [raw dict per listing]} from the latest snapshot of each instrument."""
    out = {}
    q = """SELECT m.isin, s.raw_json FROM etf_master m JOIN etf_snapshot s
           ON s.instrument_id = m.instrument_id
           AND s.run_id = (SELECT MAX(run_id) FROM etf_snapshot WHERE instrument_id = m.instrument_id)
           WHERE m.active = 1"""
    want = set(isins)
    for isin, raw in conn.execute(q):
        if isin in want and raw:
            out.setdefault(isin, []).append(json.loads(raw))
    return out


def merge_candidates(*sources, limit=8, exclude=()):
    """Merge [(source_name, [tickers])] into ordered [(ticker, "src1,src2")]."""
    srcs = {}
    for name, ts in sources:
        for t in ts:
            if t not in exclude:
                srcs.setdefault(t, []).append(name)
    return [(t, ",".join(dict.fromkeys(s))) for t, s in srcs.items()][:limit]


def covers_start(probe_result, fund_start, slack_days=120, floor="2008-01-01"):
    """True when a probed ticker's history starts near (or before) the fund's launch date.
    Yahoo has little daily data before `floor`, so earlier launch dates count from there."""
    if not probe_result or not probe_result.get("ok") or not fund_start:
        return False
    start = max(date.fromisoformat(fund_start), date.fromisoformat(floor))
    return date.fromisoformat(probe_result["first_date"]) <= start + timedelta(days=slack_days)


def fund_starts(conn):
    return {i: d for i, d in conn.execute(
        "SELECT isin, MIN(start_date) FROM etf_master WHERE active=1 AND start_date IS NOT NULL GROUP BY isin")}


def map_tickers(conn, cfg, yahoo, isins, threads=4, figi_lookup=None, now=None):
    """Look up and store ticker mappings for `isins`. Returns {isin: chosen ticker or None}.

    Step 1: Nordnet symbol and Yahoo search candidates are probed.
    Step 2: ISINs where no candidate covers the fund's start date (or none works) are looked up
            in OpenFIGI (batched, rate limited) and those candidates are probed too.
    """
    ensure_schema(conn)
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not isins:
        return {}
    raws, starts = nordnet_rows(conn, isins), fund_starts(conn)
    limit, stale = cfg.get("max_candidates", 8), cfg.get("max_stale_days", 30)
    cands, probes = {}, {}

    def step1(isin):
        try:
            quotes = yahoo.search(isin) if cfg.get("yahoo_search", True) else []
        except YahooError as e:
            log.warning("Yahoo-søk feilet for %s: %s", isin, e)
            quotes = []
        nn = [t for raw in raws.get(isin, []) for t in nordnet_candidates(raw, cfg["nordnet_suffix"])]
        c = merge_candidates(("nordnet", nn), ("yahoo_search", yahoo_search_candidates(quotes)), limit=limit)
        return isin, c, [(t, probe(yahoo, t)) for t, _ in c]

    def step2(args):
        isin, c = args
        return isin, c, [(t, probe(yahoo, t)) for t, _ in c]

    log.info("Ticker-mapping steg 1 (Nordnet + Yahoo-søk) for %d ISIN-er", len(isins))
    with ThreadPoolExecutor(max_workers=threads) as ex:
        for n, (isin, c, p) in enumerate(ex.map(step1, isins), 1):
            cands[isin], probes[isin] = c, p
            if n % 200 == 0:
                log.info("  %d/%d", n, len(isins))

    need = [i for i in isins
            if not any(covers_start(p, starts.get(i), cfg.get("start_slack_days", 120),
                                    str(cfg.get("yahoo_history_floor", "2008-01-01"))) for _, p in probes[i])]
    log.info("Ticker-mapping steg 2 (OpenFIGI) for %d ISIN-er uten dekkende kandidat", len(need))
    figi = (figi_lookup or openfigi_lookup)(need, cfg) if need else {}
    extra = []
    for isin in need:
        have = {t for t, _ in cands[isin]}
        c = merge_candidates(("openfigi", figi_candidates(figi.get(isin), cfg["figi_suffix"])),
                             limit=max(0, limit - len(have)), exclude=have)
        # A ticker found by both sources gets both names.
        figi_set = set(figi_candidates(figi.get(isin), cfg["figi_suffix"]))
        cands[isin] = [(t, s + ",openfigi" if t in figi_set else s) for t, s in cands[isin]]
        if c:
            extra.append((isin, c))
    with ThreadPoolExecutor(max_workers=threads) as ex:
        for isin, c, p in ex.map(step2, extra):
            cands[isin] += c
            probes[isin] += p

    result = {}
    with conn:
        for isin in isins:
            srcmap, plist = dict(cands[isin]), probes[isin]
            best = choose(plist, max_stale_days=stale)
            conn.execute("DELETE FROM ticker_map WHERE isin=?", (isin,))
            for t, p in plist:
                conn.execute(
                    "INSERT INTO ticker_map VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (isin, t, srcmap[t], now, p.get("ok", 0), int(t == best), p.get("currency"),
                     p.get("exchange"), p.get("yahoo_name"), p.get("first_date"), p.get("last_date"),
                     p.get("n_months"), p.get("error")))
            if not plist:
                conn.execute("INSERT INTO ticker_map(isin, yahoo_ticker, source, verified_at, ok, chosen, error)"
                             " VALUES(?, '', '', ?, 0, 0, 'ingen kandidater')", (isin, now))
            result[isin] = best
    return result


def chosen_tickers(conn):
    """{isin: (ticker, currency)} for valid chosen mappings."""
    ensure_schema(conn)
    return {r[0]: (r[1], r[2]) for r in conn.execute(
        "SELECT isin, yahoo_ticker, currency FROM ticker_map WHERE chosen=1 AND ok=1")}


def invalidate(conn, ticker, error):
    """Mark a chosen ticker as broken so the next mapping run looks it up again."""
    with conn:
        conn.execute("UPDATE ticker_map SET ok=0, error=? WHERE yahoo_ticker=? AND chosen=1", (error, ticker))
