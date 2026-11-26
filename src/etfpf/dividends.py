"""Dividends in the ETF price series: yield, and repair of distributing ETFs whose dividends are missing.

The site uses total return (dividends reinvested, see prices.total_return_index). Yahoo misses the
dividends of some distributing ETFs, entirely or partly. Their total return then looks too low, and a
good ETF can lose in the explorer, the twin table and the suggestion. Two checks:

* A distributing ETF in a cluster (same index) with an accumulating member is compared with that member
  over the common period (at least `min_years`, at most `window_years`). If it lags by more than
  `max_lag` per year after the fee difference, its daily series is rebuilt from the accumulating
  member's growth minus the fee difference, anchored at its own last price (so the price shown is real).
  When the accumulating member is another product (another name, not just another share class), the
  two can differ for real, so the lag must exceed `max_lag_other` and be larger than the dividends that
  are registered for the period (a lag the registered dividends already explain is not a gap).
* A distributing ETF with no registered dividend in the last 12 months after at least `min_days` of
  prices, and no member to repair it from, is flagged `div_missing`.

`yield12` is the dividends of the last 365 days divided by the last close, both in the listing currency.
"""
import pandas as pd

from . import tickers as tk
from .universe import normalize_name

DEFAULTS = {"max_lag": 0.005, "max_lag_other": 0.01, "min_years": 2.0, "window_years": 5.0, "min_days": 400}


def registered_yield(close, divs, start, end):
    """Registered dividends per year between two dates / mean close (listing currency)."""
    if close is None or divs is None or divs.empty:
        return 0.0
    c = close[(close.index >= start) & (close.index <= end)].dropna()
    d = divs[(divs.index > start) & (divs.index <= end)]
    yrs = (end - start).days / 365.25
    return float(d.sum() / c.mean() / yrs) if len(c) and yrs > 0 and c.mean() > 0 else 0.0


def trailing_yield(close, divs, days=365):
    """Dividends of the last `days` days / last close (listing currency). None without a price."""
    if close is None or close.dropna().empty:
        return None
    last = close.dropna()
    if divs is None or divs.empty:
        return 0.0
    end = last.index[-1]
    d = divs[(divs.index > end - pd.Timedelta(days=days)) & (divs.index <= end)]
    return float(d.sum() / last.iloc[-1]) if last.iloc[-1] > 0 else None


def annual_growth(s, start, end):
    """Annualized growth of series s between two dates (both must have values)."""
    yrs = (end - start).days / 365.25
    return (s.loc[end] / s.loc[start]) ** (1 / yrs) - 1


def rebuild(dist, ref, fee_diff):
    """Daily series for `dist` from `ref`'s growth over their common dates, minus `fee_diff` per year,
    anchored at dist's value on the last common date. Dist's own values before and after the common
    period are kept and joined smoothly."""
    common = dist.dropna().index.intersection(ref.dropna().index)
    t0, t1 = common[0], common[-1]
    yrs_back = (t1 - common).days / 365.25
    new = dist.loc[t1] * ref.loc[common] / ref.loc[t1] * (1 + fee_diff) ** yrs_back
    out = dist.copy()
    out.loc[common] = new.to_numpy()
    before = dist.index < t0
    if before.any():
        out.loc[before] = dist.loc[before] * new.loc[t0] / dist.loc[t0]
    return out


def check(meta, prices, series, isin_ticker, cfg=None):
    """Yield per ETF and repair of missing dividends.

    meta: DataFrame indexed by ISIN with accumulating (0/1, NaN), cluster_id, fee.
    prices: daily NOK total-return panel (date x ISIN). series: {ticker: (close, divs)} in listing currency.
    isin_ticker: {isin: ticker}. Returns (prices with repaired columns, {isin: info}, report dict).
    """
    c = {**DEFAULTS, **(cfg or {})}
    info, fixed, flagged = {}, {}, []
    dt = lambda x: None if x is None else x.set_axis(pd.to_datetime(x.index))
    series = {t: (dt(cl), dt(dv)) for t, (cl, dv) in series.items() if t in set(isin_ticker.values())}
    px = prices.copy()
    for isin, t in isin_ticker.items():
        if t in series and isin in px.columns:
            close, divs = series[t]
            y = trailing_yield(close, divs)
            n = 0 if divs is None else int(len(divs))
            info[isin] = {"yield12": None if y is None else round(y, 5), "n_div": n}
    m = meta[meta.index.isin(px.columns)]
    for cid, g in m.groupby("cluster_id"):
        acc = g[g["accumulating"] == 1]
        dist = g[g["accumulating"] == 0]
        if acc.empty or dist.empty:
            continue
        for isin, row in dist.iterrows():
            d = px[isin].dropna()
            best = None
            for ref_isin, rrow in acc.iterrows():
                r = px[ref_isin].dropna()
                common = d.index.intersection(r.index)
                if len(common) < 2:
                    continue
                end = common[-1]
                start = max(common[0], end - pd.DateOffset(years=c["window_years"]))
                start = common[common.searchsorted(start)]
                yrs = (end - start).days / 365.25
                if yrs < c["min_years"]:
                    continue
                if best is None or yrs > best[1] or (yrs == best[1] and (rrow.get("fund_size") or 0) > (best[3] or 0)):
                    best = (ref_isin, yrs, (start, end), rrow.get("fund_size"), rrow["fee"])
            if best is None:
                continue
            ref_isin, yrs, (start, end), _, ref_fee = best
            fee_diff = ((row["fee"] or 0) - (ref_fee or 0)) / 100
            r = px[ref_isin]
            expected = (1 + annual_growth(r, start, end)) / (1 + fee_diff) - 1
            lag = expected - annual_growth(d, start, end)
            same = normalize_name(row.get("name") or "") == normalize_name(meta.loc[ref_isin].get("name") or "")
            if not same:
                t = isin_ticker.get(isin)
                close, divs = series.get(t, (None, None))
                reg = registered_yield(close, divs, start, end)
                if lag <= c["max_lag_other"] or reg >= lag:
                    continue
            if lag > c["max_lag"]:
                px[isin] = rebuild(px[isin], r, fee_diff)
                fixed[isin] = {"ref": ref_isin, "lag": round(float(lag), 5), "years": round(yrs, 1)}
    for isin in m[m["accumulating"] == 0].index:
        if isin in fixed or isin not in info:
            continue
        s = px[isin].dropna()
        if len(s) and (s.index[-1] - s.index[0]).days >= c["min_days"] and not info[isin]["yield12"]:
            info[isin]["div_missing"] = True
            flagged.append(isin)
    for isin, f in fixed.items():
        info.setdefault(isin, {})["div_fix"] = f["ref"]
    report = {"repaired": fixed, "missing": flagged, "n_repaired": len(fixed), "n_missing": len(flagged)}
    return px, info, report


def isin_tickers(conn):
    """{isin: yahoo ticker} for the chosen listing of every ETF."""
    return {isin: t for isin, (t, _cur) in tk.chosen_tickers(conn).items()}

