"""How many of Nordnet's mutual funds have usable price history on Yahoo?

Used by scripts/probe_fund_history.py. Pure functions (sampling, return checks, summaries) live
here so they can be tested without network.

A fund counts as *usable* for the backtest/optimisation pipeline when
  1. a Yahoo ticker was found (tickers.map_tickers: Nordnet symbol, Yahoo search on ISIN, OpenFIGI),
  2. the ticker is the right share class: Yahoo's price return in Yahoo's currency agrees with
     Nordnet's yield_1y/yield_3y (and the last price with Nordnet's price), and
  3. there are at least 3 years of monthly prices.
"""
import math
import random
from collections import Counter, defaultdict
from datetime import date, timedelta

import pandas as pd

from .yahoo import currency_unit

YEARS = (1, 3, 5, 10)
USABLE_YEARS = 3


# ---------------------------------------------------------------- data from the fund database

def latest_rows(conn):
    """One dict per active ISIN with the latest snapshot values. When an ISIN has several
    listings, the NOK one is preferred."""
    q = """SELECT m.isin, m.name, m.fund_type, m.category, m.domicile, m.issuer_name, m.start_date,
                  s.currency, s.price, s.yield_1y, s.yield_3y, r.run_at
           FROM etf_master m
           JOIN etf_snapshot s ON s.instrument_id = m.instrument_id
            AND s.run_id = (SELECT MAX(run_id) FROM etf_snapshot WHERE instrument_id = m.instrument_id)
           JOIN runs r ON r.run_id = s.run_id
           WHERE m.active = 1 AND m.isin IS NOT NULL
           ORDER BY m.isin, CASE WHEN s.currency = 'NOK' THEN 0 ELSE 1 END, m.instrument_id"""
    cols = ["isin", "name", "fund_type", "category", "domicile", "issuer_name", "start_date",
            "currency", "price", "yield_1y", "yield_3y", "run_at"]
    out = {}
    for r in conn.execute(q):
        d = dict(zip(cols, r))
        out.setdefault(d["isin"], d)
    return list(out.values())


# ---------------------------------------------------------------- sampling

def stratified_sample(rows, n, seed=1, key="fund_type"):
    """Proportional stratified sample of `rows` on `key` (largest remainder, at least one per
    group when n allows). n <= 0 or n >= len(rows) returns all rows. Deterministic for a seed."""
    if n <= 0 or n >= len(rows):
        return list(rows)
    groups = defaultdict(list)
    for r in sorted(rows, key=lambda r: r["isin"]):
        groups[r.get(key) or "Ukjent"].append(r)
    total = len(rows)
    quota = {g: n * len(v) / total for g, v in groups.items()}
    alloc = {g: int(math.floor(q)) for g, q in quota.items()}
    if n >= len(groups):
        for g in groups:
            alloc[g] = max(alloc[g], 1)
    left = n - sum(alloc.values())
    for g in sorted(groups, key=lambda g: quota[g] - math.floor(quota[g]), reverse=True):
        if left <= 0:
            break
        if alloc[g] < len(groups[g]):
            alloc[g] += 1
            left -= 1
    while sum(alloc.values()) > n:  # minimum-one rule overshot: trim the largest groups
        g = max(alloc, key=lambda g: alloc[g])
        alloc[g] -= 1
    rng = random.Random(seed)
    out = []
    for g in sorted(groups):
        out.extend(rng.sample(groups[g], min(alloc[g], len(groups[g]))))
    return out


# ---------------------------------------------------------------- share-class check

def price_return(close, end, days, max_gap_days=10):
    """Cumulative price return in percent over `days` calendar days up to `end` (a date).
    close: Series indexed by date. None when the series does not reach back far enough or the
    last price is more than `max_gap_days` before `end`."""
    s = close[close.index <= end].dropna().sort_index()
    if s.empty or (end - s.index[-1]).days > max_gap_days:
        return None
    target = s.index[-1] - timedelta(days=days)
    base = s[s.index <= target]
    if base.empty or (target - base.index[-1]).days > max_gap_days:
        return None
    return (s.iloc[-1] / base.iloc[-1] - 1) * 100


def to_nok(s, currency, fx):
    """Price series in `currency` -> NOK with daily rates (fx: DataFrame[date, currency, nok]).
    None when the currency has no rates."""
    if currency == "NOK":
        return s
    r = fx[fx["currency"] == currency].set_index("date")["nok"].sort_index()
    if r.empty:
        return None
    r = r.reindex(r.index.union(s.index)).ffill().reindex(s.index)
    return (s * r).dropna()


def check_share_class(closes, yahoo_currency, row, tol_1y=2.0, tol_3y=5.0, price_tol=0.03, fx=None):
    """Compare a Yahoo close series with the Nordnet row it was mapped from.

    Nordnet's fund returns (yield_1y/3y) are in NOK, also for funds in USD/EUR/SEK (verified
    2026-11 against Yahoo + Norges Bank rates), so with `fx` the Yahoo returns are converted to
    NOK before the comparison. The price check needs the same currency and is skipped otherwise.
    Without `fx` the returns are compared in the quote currency (as for ETFs, whose Nordnet
    returns are in the listing currency).

    closes: DataFrame[date, close] from yahoo.parse_chart. Returns a dict with the Yahoo and
    Nordnet returns, differences, price ratio and `status`:
      ok          every available check within tolerance
      avvik       at least one check outside tolerance (probably wrong share class or bad data)
      ulik valuta another currency than Nordnet and no rates to convert; not comparable
      ukjent      nothing to compare (no Nordnet returns, or too short Yahoo history)
    """
    cur, factor = currency_unit(yahoo_currency)
    out = {"yahoo_currency": cur, "r1_yahoo": None, "r1_nordnet": row.get("yield_1y"), "d1": None,
           "r3_yahoo": None, "r3_nordnet": row.get("yield_3y"), "d3": None, "price_ratio": None}
    if closes is None or closes.empty:
        out["status"] = "ukjent"
        return out
    s = pd.Series(closes["close"].to_numpy(dtype=float) * factor, index=list(closes["date"])).sort_index()
    end = date.fromisoformat(str(row["run_at"])[:10]) if row.get("run_at") else s.index[-1]
    same_cur = not row.get("currency") or cur == row["currency"]
    sr = s if fx is None else to_nok(s, cur, fx)
    if sr is None or (fx is None and not same_cur):
        out["r1_yahoo"] = price_return(s, end, 365)
        out["r3_yahoo"] = price_return(s, end, 3 * 365)
        out["status"] = "ulik valuta"
        return out
    out["r1_yahoo"] = price_return(sr, end, 365)
    out["r3_yahoo"] = price_return(sr, end, 3 * 365)
    checks = []
    for k, tol in (("1", tol_1y), ("3", tol_3y)):
        y, n = out[f"r{k}_yahoo"], out[f"r{k}_nordnet"]
        if y is not None and n is not None:
            out[f"d{k}"] = y - n
            checks.append(abs(y - n) <= tol)
    last = s[s.index <= end]
    if same_cur and row.get("price") and not last.empty:
        out["price_ratio"] = float(last.iloc[-1] / row["price"])
        checks.append(abs(out["price_ratio"] - 1) <= price_tol)
    out["status"] = "ukjent" if not checks else ("ok" if all(checks) else "avvik")
    return out


# ---------------------------------------------------------------- summary

def is_usable(rec):
    return bool(rec.get("ticker")) and rec.get("status") == "ok" and (rec.get("years") or 0) >= USABLE_YEARS


def _stats(recs):
    n = len(recs)
    mapped = [r for r in recs if r.get("ticker")]
    st = Counter(r.get("status") for r in mapped)
    d = {"n": n, "med_ticker": len(mapped),
         **{f"minst_{y}_år": sum(1 for r in mapped if (r.get("years") or 0) >= y) for y in YEARS},
         "dekker_start": sum(1 for r in mapped if r.get("covers_start")),
         "andelsklasse_ok": st.get("ok", 0), "avvik": st.get("avvik", 0),
         "ulik_valuta": st.get("ulik valuta", 0), "ukjent": st.get("ukjent", 0),
         "brukbar": sum(1 for r in recs if is_usable(r))}
    d["andel_brukbar"] = round(d["brukbar"] / n, 3) if n else None
    return d


def summarize(records, by=("fund_type", "domicile"), top=8):
    """Overall stats plus per group. Groups beyond the `top` largest are folded into 'Andre'."""
    out = {"totalt": _stats(records), "per": {}}
    for key in by:
        counts = Counter(r.get(key) or "Ukjent" for r in records)
        keep = {g for g, _ in counts.most_common(top)}
        groups = defaultdict(list)
        for r in records:
            g = r.get(key) or "Ukjent"
            groups[g if g in keep else "Andre"].append(r)
        out["per"][key] = {g: _stats(v) for g, v in sorted(groups.items(), key=lambda kv: -len(kv[1]))}
    out["kilder"] = dict(Counter(s for r in records if r.get("ticker")
                                 for s in (r.get("source") or "").split(",") if s).most_common())
    out["børser"] = dict(Counter(r.get("exchange") or "?" for r in records if r.get("ticker")).most_common(10))
    return out


def _pct(a, n):
    return f"{a:4d} ({a / n:4.0%})" if n else f"{a:4d}"


def format_summary(summary, label="ISIN-er"):
    """Plain-text table of a summary from `summarize`."""
    cols = [("med_ticker", "ticker"), ("minst_3_år", "≥3 år"), ("minst_5_år", "≥5 år"),
            ("minst_10_år", "≥10 år"), ("andelsklasse_ok", "klasse ok"), ("brukbar", "brukbar")]
    head = f"{'':28s}{'n':>5s}" + "".join(f"{h:>12s}" for _, h in cols)
    lines = [head]

    def line(name, s):
        return f"{name[:28]:28s}{s['n']:5d}" + "".join(f"{_pct(s[k], s['n']):>12s}" for k, _ in cols)

    t = summary["totalt"]
    lines.append(line("Totalt", t))
    for key, groups in summary["per"].items():
        lines.append(f"-- per {key}")
        lines.extend(line("  " + str(g), s) for g, s in groups.items())
    lines.append(f"Avvik i andelsklassekontrollen: {t['avvik']}, ulik valuta: {t['ulik_valuta']}, "
                 f"ukjent: {t['ukjent']}. Dekker fondets startdato: {t['dekker_start']} av {t['med_ticker']}.")
    lines.append("Kilder: " + ", ".join(f"{k} {v}" for k, v in summary["kilder"].items()))
    lines.append("Børser: " + ", ".join(f"{k} {v}" for k, v in summary["børser"].items()))
    lines.append(f"«Brukbar» = ticker + andelsklasse ok + minst {USABLE_YEARS} år månedskurser ({label}).")
    return "\n".join(lines)
