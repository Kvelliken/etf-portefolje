"""Minimal Yahoo Finance client (the v8 chart and v1 search endpoints that yfinance uses).

Unofficial source: every call has retry with backoff, host rotation (query2/query1) and logging.
No crumb/cookie is needed for these two endpoints.
"""
import logging
import threading
import time
from datetime import datetime, timezone

import pandas as pd
import requests

log = logging.getLogger(__name__)
HEADERS = {"User-Agent": "Mozilla/5.0 (personlig ETF-oversikt)"}
# Yahoo quotes some London listings in pence; convert to the main unit.
SUBUNITS = {"GBp": ("GBP", 0.01), "GBX": ("GBP", 0.01), "ZAc": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}


class Yahoo:
    def __init__(self, cfg):
        self.hosts = cfg.get("yahoo_hosts", ["query2.finance.yahoo.com", "query1.finance.yahoo.com"])
        self.timeout = cfg.get("timeout_seconds", 30)
        self.retries = cfg.get("retries", 4)
        self.delay = cfg.get("delay_seconds", 0.25)
        self._local = threading.local()
        self.n_calls = 0

    def _session(self):
        if not hasattr(self._local, "s"):
            self._local.s = requests.Session()
            self._local.s.headers.update(HEADERS)
        return self._local.s

    def get_json(self, path, params):
        """GET JSON. Returns None for 404 (unknown symbol); raises after repeated failures."""
        last = None
        for attempt in range(self.retries):
            host = self.hosts[attempt % len(self.hosts)]
            try:
                time.sleep(self.delay)
                self.n_calls += 1
                r = self._session().get(f"https://{host}{path}", params=params, timeout=self.timeout)
                if r.status_code == 404:
                    return None
                if r.status_code == 200:
                    return r.json()
                last = f"HTTP {r.status_code}"
            except (requests.RequestException, ValueError) as e:
                last = str(e)
            wait = 2 ** attempt * (5 if last and "429" in last else 1)
            log.debug("Yahoo %s %s: %s, prøver igjen om %ss", path, params, last, wait)
            time.sleep(wait)
        raise YahooError(f"{path} {params}: {last}")

    def chart(self, ticker, **params):
        """Return the chart result dict, or None if Yahoo has no data for the symbol."""
        params.setdefault("events", "div,split")
        params.setdefault("includeAdjustedClose", "true")
        d = self.get_json(f"/v8/finance/chart/{ticker}", params)
        res = ((d or {}).get("chart") or {}).get("result")
        return res[0] if res else None

    def search(self, query):
        d = self.get_json("/v1/finance/search", {"q": query, "quotesCount": 10, "newsCount": 0,
                                                 "listsCount": 0, "enableFuzzyQuery": "false"})
        return (d or {}).get("quotes") or []


class YahooError(RuntimeError):
    pass


def _local_date(ts, gmtoffset):
    return datetime.fromtimestamp(int(ts) + int(gmtoffset or 0), tz=timezone.utc).date()


def parse_chart(res):
    """Parse a chart result into (meta, closes, dividends, splits).

    closes: DataFrame[date, close] (split-adjusted close, not dividend-adjusted)
    dividends: DataFrame[date, amount]; splits: DataFrame[date, ratio]
    Dates are exchange-local trading dates.
    """
    meta = dict(res.get("meta") or {})
    off = meta.get("gmtoffset", 0)
    ts = res.get("timestamp") or []
    quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    closes = list(quote.get("close") or [None] * len(ts))
    # Yahoo often leaves the latest daily bar empty; use the regular market price for that day.
    rmt, rmp = meta.get("regularMarketTime"), meta.get("regularMarketPrice")
    if ts and closes and closes[-1] is None and rmt and rmp and \
            _local_date(rmt, off) == _local_date(ts[-1], off):
        closes[-1] = rmp
    df = pd.DataFrame({"date": [_local_date(t, off) for t in ts], "close": closes}, dtype=object)
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df = df.dropna().query("close > 0").drop_duplicates("date", keep="last").reset_index(drop=True)
    ev = res.get("events") or {}
    divs = pd.DataFrame([(_local_date(v["date"], off), float(v["amount"]))
                         for v in (ev.get("dividends") or {}).values() if v.get("amount")],
                        columns=["date", "amount"])
    splits = pd.DataFrame([(_local_date(v["date"], off),
                            float(v.get("numerator") or 1) / float(v.get("denominator") or 1))
                           for v in (ev.get("splits") or {}).values()], columns=["date", "ratio"])
    return meta, df, divs, splits


def currency_unit(cur):
    """('GBp') -> ('GBP', 0.01); ('EUR') -> ('EUR', 1.0)."""
    return SUBUNITS.get(cur, (cur, 1.0))
