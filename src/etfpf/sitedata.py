"""Data for the static site: ETF metadata with classification, monthly total returns in NOK and the
Norwegian risk-free rate. All metrics (1/3/5/10-year return, volatility, alpha, beta, R², Sharpe),
the optimisation of the user's own selection and the backtest are computed in the browser from
these files, so the benchmark, periods and constraints can be changed on the page.

Files written to site/data/:
  etfs.json     one row per ISIN (metadata, classification, cluster, last price in NOK)
  returns.json  monthly total returns in NOK, integers in units of 1/scale (1 bp), per ISIN
  summary.json  dates, defaults and data sources
  changes.json  Nordnet list changes per monthly run
  quality.json  coverage and universe report
"""
import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import classify as cl
from . import rates

log = logging.getLogger(__name__)
SCALE = 10000          # returns stored as round(r * SCALE)
STALE_DAYS = 7         # a month-end value needs a price within this many days of the month end


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return None if not math.isfinite(float(o)) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_clean(obj), ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                    encoding="utf-8")


# ---------------------------------------------------------------- monthly returns

def last_complete_month(last_date):
    """Month-end of the last month that is complete at `last_date` (allowing a few days' slack)."""
    last_date = pd.Timestamp(last_date).normalize()
    me = last_date + pd.offsets.MonthEnd(0)
    if (me - last_date).days <= 3:
        return me
    return last_date.replace(day=1) - pd.Timedelta(days=1)


def monthly_returns(prices, end=None, stale_days=STALE_DAYS):
    """Monthly simple returns (month-end to month-end) from a daily price panel (date x ISIN).

    A month-end value requires a price within `stale_days` of the month end; interior gaps are
    forward-filled (zero return, then the catch-up), trailing stale months are dropped."""
    prices = prices.sort_index()
    end = pd.Timestamp(end) if end is not None else last_complete_month(prices.index.max())
    prices = prices[prices.index <= end]
    last = prices.resample("ME").last()
    last_date = _last_obs_dates(prices).reindex(last.index)
    age = (last.index.values[:, None] - last_date.to_numpy()) / np.timedelta64(1, "D")
    m = last.where(pd.DataFrame(age <= stale_days, index=last.index, columns=last.columns))
    # forward-fill only inside each series' range
    first_valid = m.apply(pd.Series.first_valid_index)
    last_valid = m.apply(pd.Series.last_valid_index)
    m = m.ffill()
    for c in m.columns:
        fv, lv = first_valid[c], last_valid[c]
        if fv is None or pd.isna(fv):
            m[c] = np.nan
            continue
        m.loc[(m.index < fv) | (m.index > lv), c] = np.nan
    r = m.pct_change(fill_method=None).iloc[1:]
    return r


def _last_obs_dates(prices):
    """For each month and column, the date of the last non-missing price in that month."""
    d = pd.DataFrame(np.where(prices.notna(), prices.index.values[:, None], np.datetime64("NaT", "ns")),
                     index=prices.index, columns=prices.columns)
    return d.resample("ME").max()


def encode_returns(r, scale=SCALE):
    """{isin: [offset, r1, r2, ...]} with integer returns; offset = index of the first month."""
    out = {}
    vals = r.to_numpy()
    for j, c in enumerate(r.columns):
        col = vals[:, j]
        ok = np.flatnonzero(np.isfinite(col))
        if len(ok) < 2:
            continue
        a, b = ok[0], ok[-1]
        seg = col[a:b + 1]
        seg = np.where(np.isfinite(seg), seg, 0.0)
        out[c] = [int(a)] + [int(round(x * scale)) for x in seg]
    return out


# ---------------------------------------------------------------- metadata

def load_meta(conn):
    u = pd.read_sql_query("SELECT * FROM universe", conn).set_index("isin")
    run = conn.execute("SELECT MAX(run_id) FROM etf_snapshot").fetchone()[0]
    slugs = {}
    for iid, raw in conn.execute("SELECT instrument_id, raw_json FROM etf_snapshot WHERE run_id = ?", (run,)):
        try:
            slugs[iid] = json.loads(raw).get("nnx_info", {}).get("display_slug")
        except (TypeError, ValueError):
            pass
    u["nordnet_url"] = u["instrument_id"].map(
        lambda i: f"https://www.nordnet.no/etf/liste/{slugs[i]}" if slugs.get(i) else None)
    extra = pd.read_sql_query(
        """SELECT m.isin, m.currency, m.issuer_name, m.dividend_policy, m.ask_eligible, m.risk, m.rating,
                  m.fund_type, m.is_tradable, m.instrument_id, s.spread_pct
           FROM etf_master m LEFT JOIN etf_snapshot s ON s.instrument_id = m.instrument_id AND s.run_id = ?""",
        conn, params=(run,))
    # the listing chosen in the universe (same instrument_id) first
    extra["_chosen"] = extra["instrument_id"].isin(set(u["instrument_id"]))
    extra = extra.sort_values("_chosen", ascending=False).drop_duplicates("isin").set_index("isin")
    u = u.join(extra[["currency", "issuer_name", "dividend_policy", "ask_eligible", "risk", "rating", "fund_type",
                      "is_tradable", "spread_pct"]], how="left")
    return u


def cluster_picks(u):
    """One ISIN per cluster for the explorer's "one per index" filter: the representative when the
    cluster has one, otherwise the cheapest (effective fee) ASK-eligible, then longest history."""
    df = u.reset_index()
    df["_rep"] = df["is_representative"].fillna(0).astype(int)
    df["_ask"] = df["ask_eligible"].fillna(0).astype(int)
    df["_fee"] = df["eff_fee"].fillna(df["fee"]).fillna(99)
    df["_hist"] = df["history_years"].fillna(0)
    df = df.sort_values(["cluster_id", "_rep", "_ask", "_fee", "_hist", "fund_size"],
                        ascending=[True, False, False, True, False, False])
    return set(df.drop_duplicates("cluster_id")["isin"])


def build_etfs(u, prices, months):
    picks = cluster_picks(u)
    first_month = {}
    rows = []
    last_px = {c: prices[c].dropna() for c in prices.columns}
    for isin, r in u.iterrows():
        c = cl.classify(r["name"], r["category"], r.get("fund_type"))
        px = last_px.get(isin)
        rows.append({
            "isin": isin, "ticker": r["symbol"], "name": r["name"], "issuer": r.get("issuer_name"),
            "category": r["category"], **c,
            "fee": r["fee"], "fund_size": r["fund_size"], "owners": r["number_of_owners"],
            "currency": r.get("currency"), "acc": None if pd.isna(r["accumulating"]) else bool(r["accumulating"]),
            "hedged": bool(r["hedged"]) if pd.notna(r["hedged"]) else False,
            "leveraged": bool(r["leveraged"]) if pd.notna(r["leveraged"]) else False,
            "ask": bool(r["ask_eligible"]) if pd.notna(r.get("ask_eligible")) else False,
            "risk": r.get("risk"), "rating": r.get("rating"), "spread": r.get("spread_pct"),
            "cluster": int(r["cluster_id"]), "cluster_size": int(r["cluster_size"]),
            "pick": isin in picks, "rep": bool(r["is_representative"]),
            "max_te": r["max_te_in_cluster"], "history_years": r["history_years"],
            "first_price": r["first_price_date"],
            "price_nok": float(px.iloc[-1]) if px is not None and len(px) else None,
            "price_date": str(px.index[-1].date()) if px is not None and len(px) else None,
            "url": r.get("nordnet_url"),
        })
    return rows


# ---------------------------------------------------------------- export

def export(conn, prices, cfg, out_dir, price_root=None, coverage=None, universe_report=None, now=None):
    out = Path(out_dir)
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    sc = cfg.get("site", {})
    u = load_meta(conn)
    r = monthly_returns(prices)
    r = r.loc[:, r.notna().sum() >= 2]
    months = r.index
    enc = encode_returns(r)
    rf, rf_source = rates.monthly_rf(months, price_root)
    etfs = build_etfs(u, prices, months)
    for e in etfs:
        e["has_returns"] = e["isin"] in enc
    write_json(out / "etfs.json", {"etfs": etfs})
    write_json(out / "returns.json", {
        "start": months[0].strftime("%Y-%m"), "end": months[-1].strftime("%Y-%m"), "n": len(months),
        "scale": SCALE, "rf": [round(float(x), 7) for x in rf], "rf_source": rf_source, "r": enc})

    # changes.json
    changes = pd.read_sql_query(
        """SELECT c.run_id, r.run_at, c.instrument_id, c.change, c.field, c.old, c.new, m.isin, m.name, m.symbol
           FROM changes c JOIN runs r USING(run_id) LEFT JOIN etf_master m USING(instrument_id)
           ORDER BY c.run_id DESC""", conn)
    runs = []
    for (rid, at), g in changes.groupby(["run_id", "run_at"], sort=False):
        first = rid == changes["run_id"].min()
        runs.append({"run_id": int(rid), "run_at": at, "counts": g["change"].value_counts().to_dict(),
                     "items": [] if first else g.drop(columns=["run_id", "run_at"]).to_dict("records")})
    write_json(out / "changes.json", {"runs": runs})

    write_json(out / "quality.json", {"coverage": coverage or {}, "universe": universe_report or {},
                                      "n_with_returns": len(enc)})
    last_run = conn.execute("SELECT run_at, n_found FROM runs ORDER BY run_id DESC LIMIT 1").fetchone()
    oc = cfg.get("optimize", {})
    write_json(out / "summary.json", {
        "generated_at": now, "data_until": str(prices.index.max().date()),
        "returns_until": months[-1].strftime("%Y-%m-%d"),
        "nordnet_run_at": last_run[0] if last_run else None, "nordnet_n": last_run[1] if last_run else None,
        "account": {"type": cfg.get("account", {}).get("type", "ASK"),
                    "tax_warning": cfg.get("account", {}).get("type", "ASK") != "ASK"},
        "rf_source": rf_source, "rf_now": float((1 + rf.iloc[-1]) ** 12 - 1),
        "defaults": {
            "benchmark": sc.get("benchmark_isin", oc.get("reference_isin")),
            "market_risk_premium": sc.get("market_risk_premium", oc.get("market_risk_premium", 0.045)),
            "history_weight": sc.get("history_weight", 0.25),
            "estimation_years": sc.get("estimation_years", 5),
            "max_weight": sc.get("default_max_weight", 0.40),
            "min_weight": sc.get("default_min_weight", 0.0),
            "trading_cost_pct": sc.get("trading_cost_pct", 0.25),
            "rebalance_band_pp": oc.get("rebalance_band_pp", 5),
            "portfolio_value_nok": oc.get("portfolio_value_nok", 500000),
        },
        "te_threshold": (universe_report or {}).get("te_threshold"),
    })
    return {"n_etfs": len(etfs), "n_returns": len(enc), "months": len(months),
            "start": months[0].date(), "end": months[-1].date(), "rf_source": rf_source}
