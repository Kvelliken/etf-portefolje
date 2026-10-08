"""Price history (Yahoo), FX to NOK (Norges Bank or Yahoo) and a Parquet cache.

Cache layout (data/prices/):
  close_<YYYY>.parquet  ticker, date, close     split-adjusted close in the listing currency
  dividends.parquet     ticker, date, amount    dividend per share (ex-date)
  fx.parquet            date, currency, nok     NOK per 1 unit of currency
Closes and dividends are append-only, so a monthly update only rewrites the current year's
file. Total return (adjusted) series are computed from them on read: we do not store Yahoo's
adjclose, which is rescaled backwards at every dividend and would rewrite the whole cache.
A split detected after the stored history triggers a full refetch of that ticker.
"""
import io
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from . import tickers as tk
from .yahoo import YahooError, currency_unit, parse_chart

log = logging.getLogger(__name__)

META_SCHEMA = """
CREATE TABLE IF NOT EXISTS price_meta(
    ticker TEXT PRIMARY KEY, currency TEXT, first_date TEXT, last_date TEXT, n_obs INTEGER,
    updated_at TEXT, ok INTEGER, error TEXT);
"""
EPOCH_START = 315532800  # 1980-01-01


class PriceUpdateError(RuntimeError):
    """Too many tickers failed; nothing is written."""


# ---------------------------------------------------------------- cache

class PriceStore:
    def __init__(self, root):
        self.root = Path(root)
        self.close = self._read_glob("close_*.parquet", ["ticker", "date", "close"])
        self.divs = self._read(self.root / "dividends.parquet", ["ticker", "date", "amount"])
        self._orig_years = {y: g.reset_index(drop=True) for y, g in self._by_year(self.close)}
        self._orig_divs = self.divs.copy()

    @staticmethod
    def _read(path, cols):
        if path.exists():
            df = pd.read_parquet(path)
            df["date"] = pd.to_datetime(df["date"]).dt.date
            return df[cols]
        return pd.DataFrame({c: pd.Series(dtype="object" if c in ("ticker", "date") else "float64")
                             for c in cols})

    def _read_glob(self, pattern, cols):
        parts = [self._read(p, cols) for p in sorted(self.root.glob(pattern))]
        parts = [p for p in parts if len(p)]
        return pd.concat(parts, ignore_index=True) if parts else self._read(Path("/nonexistent"), cols)

    @staticmethod
    def _by_year(df):
        if df.empty:
            return []
        years = pd.to_datetime(df["date"]).dt.year
        return [(int(y), g.sort_values(["ticker", "date"]).reset_index(drop=True))
                for y, g in df.groupby(years)]

    def apply(self, updates):
        """Merge fetched data. updates: [(ticker, closes, divs, full)]; full=True replaces all
        stored data for the ticker, otherwise rows from the first fetched date are replaced."""
        if not updates:
            return
        cut = {}
        for ticker, closes, _, full in updates:
            if full:
                cut[ticker] = date.min
            elif len(closes):
                cut[ticker] = closes["date"].min()

        def keep(df):
            if df.empty:
                return df
            c = df["ticker"].map(cut)
            drop = c.notna() & (df["date"] >= c.fillna(date.min))
            return df[~drop]

        nc = [u[1].assign(ticker=u[0])[["ticker", "date", "close"]] for u in updates if len(u[1])]
        nd = [u[2].assign(ticker=u[0])[["ticker", "date", "amount"]] for u in updates if len(u[2])]
        self.close = pd.concat([keep(self.close)] + nc, ignore_index=True)
        self.divs = pd.concat([keep(self.divs)] + nd, ignore_index=True)

    def series(self):
        """{ticker: (close Series by date, dividend Series by date)}."""
        divs = {t: g.groupby("date")["amount"].sum().sort_index() for t, g in self.divs.groupby("ticker")}
        return {t: (g.set_index("date")["close"].sort_index(), divs.get(t))
                for t, g in self.close.groupby("ticker")}

    def save(self):
        """Write only partitions whose content changed. Returns number of files written."""
        self.root.mkdir(parents=True, exist_ok=True)
        n = 0
        new_years = dict(self._by_year(self.close))
        for y, g in new_years.items():
            old = self._orig_years.get(y)
            if old is None or not _frame_equal(old, g):
                g.to_parquet(self.root / f"close_{y}.parquet", index=False, compression="zstd")
                n += 1
        for y in set(self._orig_years) - set(new_years):
            (self.root / f"close_{y}.parquet").unlink(missing_ok=True)
        divs = self.divs.sort_values(["ticker", "date"]).reset_index(drop=True)
        if not _frame_equal(self._orig_divs.sort_values(["ticker", "date"]).reset_index(drop=True), divs):
            divs.to_parquet(self.root / "dividends.parquet", index=False, compression="zstd")
            n += 1
        self._orig_years, self._orig_divs = new_years, divs.copy()
        return n


def _frame_equal(a, b):
    if a.shape != b.shape:
        return False
    a, b = a.reset_index(drop=True), b.reset_index(drop=True)
    for c in a.columns:
        if pd.api.types.is_numeric_dtype(a[c]) and pd.api.types.is_numeric_dtype(b[c]):
            if not np.array_equal(a[c].to_numpy(float), b[c].to_numpy(float), equal_nan=True):
                return False
        elif not (a[c].astype(str).to_numpy() == b[c].astype(str).to_numpy()).all():
            return False
    return True


# ---------------------------------------------------------------- fetching

def fetch_ticker(yahoo, ticker, since=None):
    """Fetch daily data from `since` (date) or the full history. Returns (meta, closes, divs, splits)."""
    p1 = EPOCH_START if since is None else int(datetime(since.year, since.month, since.day,
                                                         tzinfo=timezone.utc).timestamp())
    p2 = int(datetime.now(timezone.utc).timestamp()) + 86400
    res = yahoo.chart(ticker, period1=p1, period2=p2, interval="1d")
    if res is None:
        return None
    return parse_chart(res)


def update_prices(conn, store, yahoo, wanted, cfg, threads=4, full=False, max_fail_fraction=0.25,
                  now=None, today=None):
    """Update `wanted` {ticker: currency} in `store`. Raises PriceUpdateError if too many fail
    (the store is then left unsaved by the caller)."""
    conn.executescript(META_SCHEMA)
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    today = today or date.today()
    overlap = timedelta(days=cfg.get("overlap_days", 14))
    have = store.close.groupby("ticker")["date"].max().to_dict() if len(store.close) else {}

    def work(ticker):
        last = None if full else have.get(ticker)
        try:
            r = fetch_ticker(yahoo, ticker, last - overlap if last else None)
            if r is not None and last is not None and len(r[3]) and (r[3]["date"] > last).any():
                log.info("%s: splitt etter lagret historikk, henter alt på nytt", ticker)
                last = None
                r = fetch_ticker(yahoo, ticker)
        except YahooError as e:
            return ticker, None, last is None, str(e)[:200]
        return ticker, r, last is None, None

    failed, updates, done = [], [], 0
    with ThreadPoolExecutor(max_workers=threads) as ex:
        for ticker, r, is_full, err in ex.map(work, sorted(wanted)):
            done += 1
            if r is None or r[1].empty:
                failed.append((ticker, err or "ingen data"))
            else:
                updates.append((ticker, r[1], r[2], is_full))
            if done % 200 == 0:
                log.info("Priser: %d/%d tickere (%d feil)", done, len(wanted), len(failed))
    if wanted and len(failed) > max_fail_fraction * len(wanted):
        raise PriceUpdateError(f"{len(failed)} av {len(wanted)} tickere feilet (> {max_fail_fraction:.0%}). "
                               f"Eksempler: {failed[:5]}")
    store.apply(updates)
    stale_cut = today - timedelta(days=cfg.get("max_stale_days", 30))
    stats = store.close.groupby("ticker")["date"].agg(["min", "max", "count"]) if len(store.close) else None
    with conn:
        for ticker, err in failed:
            conn.execute("INSERT OR REPLACE INTO price_meta(ticker, currency, updated_at, ok, error) "
                         "VALUES(?,?,?,0,?)", (ticker, wanted[ticker], now, err))
        for ticker, *_ in updates:
            first, last, n = stats.loc[ticker]
            ok = int(last >= stale_cut)
            conn.execute("INSERT OR REPLACE INTO price_meta VALUES(?,?,?,?,?,?,?,?)",
                         (ticker, wanted[ticker], first.isoformat(), last.isoformat(), int(n), now, ok,
                          None if ok else f"utdatert (siste {last})"))
    return failed


# ---------------------------------------------------------------- FX

def parse_norges_bank_csv(text):
    """Norges Bank EXR CSV (semicolon) -> DataFrame[date, currency, nok] (NOK per 1 unit)."""
    df = pd.read_csv(io.StringIO(text), sep=";")
    df = df.rename(columns={"BASE_CUR": "currency", "TIME_PERIOD": "date", "OBS_VALUE": "value"})
    df["nok"] = pd.to_numeric(df["value"], errors="coerce") / 10.0 ** df["UNIT_MULT"].astype(int)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df[["date", "currency", "nok"]].dropna()


def fetch_fx_norges_bank(currencies, start, get=requests.get):
    url = (f"https://data.norges-bank.no/api/data/EXR/B.{'+'.join(sorted(currencies))}.NOK.SP"
           f"?format=csv&startPeriod={start}&locale=en")
    r = get(url, timeout=60)
    r.raise_for_status()
    return parse_norges_bank_csv(r.text)


def fetch_fx_yahoo(yahoo, currencies, start):
    out = []
    for cur in sorted(currencies):
        r = fetch_ticker(yahoo, f"{cur}NOK=X", start)
        if r is not None:
            out.append(r[1].rename(columns={"close": "nok"}).assign(currency=cur))
    return pd.concat(out, ignore_index=True)[["date", "currency", "nok"]] if out else None


def update_fx(root, currencies, cfg, yahoo=None, get=requests.get):
    """Incrementally update fx.parquet for `currencies` (NOK excluded). Returns the full frame."""
    path = Path(root) / "fx.parquet"
    old = PriceStore._read(path, ["date", "currency", "nok"])
    currencies = {c for c in currencies if c and c != "NOK"}
    have = set(old["currency"]) if len(old) else set()
    full_start = date.fromisoformat(str(cfg.get("fx_start", "1999-01-01")))
    frames = [old]
    # New currencies: full history. Existing: from last date minus a margin.
    groups = {}
    for c in currencies:
        last = old.loc[old["currency"] == c, "date"].max() if c in have else None
        groups.setdefault(full_start if last is None else last - timedelta(days=10), set()).add(c)
    for start, curs in groups.items():
        if cfg.get("fx_source", "norges_bank") == "yahoo":
            new = fetch_fx_yahoo(yahoo, curs, start)
        else:
            new = fetch_fx_norges_bank(curs, start.isoformat(), get=get)
        if new is not None and len(new):
            frames.append(new)
    fx = (pd.concat([f for f in frames if len(f)], ignore_index=True)
          .drop_duplicates(["date", "currency"], keep="last").sort_values(["currency", "date"])
          .reset_index(drop=True))
    if not _frame_equal(old.sort_values(["currency", "date"]).reset_index(drop=True), fx):
        path.parent.mkdir(parents=True, exist_ok=True)
        fx.to_parquet(path, index=False, compression="zstd")
    return fx


# ---------------------------------------------------------------- series

def clean_closes(s, spike_ratio=3.0):
    """Drop isolated bad ticks: points deviating more than spike_ratio from a centred median."""
    s = s[s > 0].dropna()
    if len(s) < 5 or not spike_ratio:
        return s
    med = s.rolling(7, center=True, min_periods=1).median()
    ratio = s / med
    return s[(ratio < spike_ratio) & (ratio > 1 / spike_ratio)]


def total_return_index(close, divs=None):
    """Total-return index (same level as close on the last day): r_t = (c_t + d_t) / c_{t-1}.
    close: Series indexed by date (sorted). divs: Series amount indexed by ex-date."""
    close = close.sort_index()
    d = pd.Series(0.0, index=close.index)
    if divs is not None and len(divs):
        # A dividend on a non-trading date belongs to the next trading day.
        pos = close.index.searchsorted(divs.index)
        for p, amt in zip(pos, divs.to_numpy()):
            if p < len(close):
                d.iloc[p] += amt
    growth = (close + d) / close.shift(1)
    growth.iloc[0] = 1.0
    idx = growth.cumprod()
    return idx * close.iloc[-1] / idx.iloc[-1]


def nok_series(close, divs, fx, currency, spike_ratio=3.0):
    """Adjusted (total return) price series in NOK for one ticker. None if FX is missing."""
    if close is None or close.empty:
        return None
    c = clean_closes(close, spike_ratio)
    tr = total_return_index(c, divs) * currency_unit(currency)[1]
    cur = currency_unit(currency)[0]
    if cur == "NOK":
        return tr
    rates = fx[fx["currency"] == cur].set_index("date")["nok"].sort_index()
    if rates.empty:
        return None
    rates = rates.reindex(rates.index.union(tr.index)).ffill().reindex(tr.index)
    out = (tr * rates).dropna()
    return out if len(out) else None


def nok_prices(conn, store, fx, spike_ratio=3.0, isins=None):
    """Wide DataFrame (date x ISIN) of adjusted prices in NOK for all mapped ISINs."""
    series = store.series()
    cols = {}
    for isin, (ticker, cur) in tk.chosen_tickers(conn).items():
        if (isins is not None and isin not in isins) or ticker not in series:
            continue
        s = nok_series(*series[ticker], fx, cur, spike_ratio)
        if s is not None:
            cols[isin] = s
    df = pd.DataFrame(cols)
    df.index = pd.to_datetime(df.index)
    return df.sort_index()


# ---------------------------------------------------------------- coverage

def coverage(conn, prices, years=(1, 3, 5, 10), today=None):
    """Coverage report as a dict."""
    tk.ensure_schema(conn)
    today = pd.Timestamp(today or date.today())
    q = lambda s: conn.execute(s).fetchone()[0]
    n_isin = q("SELECT COUNT(DISTINCT isin) FROM etf_master WHERE active=1")
    n_mapped = q("SELECT COUNT(DISTINCT isin) FROM ticker_map WHERE chosen=1 AND ok=1")
    first = prices.apply(lambda s: s.first_valid_index())
    hist = {f"min_{y}y": int((first <= today - pd.DateOffset(years=y)).sum()) for y in years}
    by_source = dict(conn.execute(
        "SELECT source, COUNT(*) FROM ticker_map WHERE chosen=1 AND ok=1 GROUP BY 1 ORDER BY 2 DESC").fetchall())
    by_suffix = {}
    for (t,) in conn.execute("SELECT yahoo_ticker FROM ticker_map WHERE chosen=1 AND ok=1"):
        suf = "." + t.rsplit(".", 1)[1] if "." in t else "(US)"
        by_suffix[suf] = by_suffix.get(suf, 0) + 1
    asks = q("""SELECT COUNT(DISTINCT isin) FROM etf_master WHERE active=1 AND ask_eligible=1""")
    return {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "active_isins": n_isin, "ask_eligible_isins": asks, "mapped_isins": n_mapped,
            "with_prices": int(prices.shape[1]), "coverage_pct": round(100 * prices.shape[1] / max(n_isin, 1), 1),
            "history": hist, "by_source": by_source,
            "by_suffix": dict(sorted(by_suffix.items(), key=lambda kv: -kv[1])),
            "last_price_date": str(prices.index.max().date()) if len(prices) else None}
